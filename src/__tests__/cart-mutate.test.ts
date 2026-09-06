import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckersAPI } from "../lib/api.js";
import { buildWriteSnapshot, runCartMutation } from "../lib/cart-mutate.js";
import type { MutationIntent, PlanSnapshot } from "../lib/confirm.js";
import { plansDir, PlanStaleError } from "../lib/confirm.js";
import { DivergentOutcomeError, EXIT_CONFIRM, UsageError } from "../lib/errors.js";

let tmp: string;

const SESSION = {
  sessionToken: "sess",
  userId: "user-1",
  uuid: "uuid-1",
  mobile: "+27820000000",
  customerId: "CUST",
};

function snapshot(lineItems: Record<string, unknown>[], version = 5): PlanSnapshot {
  return {
    carts: [
      {
        cartId: "cart-60",
        serviceOptionId: "sixty-min-delivery",
        cartVersion: version,
        deliveryAddressId: "addr-1",
        lineItems,
      },
      {
        cartId: "cart-1d",
        serviceOptionId: "one-day-delivery",
        cartVersion: 2,
        deliveryAddressId: "addr-1",
        lineItems: [],
      },
    ],
    deliveryAddressId: "addr-1",
    storeContexts: [{ storeId: "S" }],
  };
}

function line(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "li-1",
    productId: "PROD",
    quantity: 1,
    price: 1299,
    priceFactor: 100,
    storeId: "S",
    status: "available",
    replacementPreferenceId: "pref-x",
    instruction: "handle with care",
    serviceOptionId: "sixty-min-delivery",
    ...over,
  };
}

/**
 * Model the real `/carts/update` server semantics: MERGE the sent lines into the
 * current state (upsert by line id), delete any line sent with quantity 0, and
 * leave omitted lines untouched. Used by the fake's default commit path so tests
 * exercise the same tombstone requirement the live API enforces.
 */
function mergeCartUpdate(current: PlanSnapshot, sent: PlanSnapshot): PlanSnapshot {
  const next = structuredClone(current);
  next.deliveryAddressId = sent.deliveryAddressId;
  for (const sentCart of sent.carts) {
    const target = next.carts.find((c) => c.cartId === sentCart.cartId);
    if (!target) {
      next.carts.push(structuredClone(sentCart));
      continue;
    }
    target.deliveryAddressId = sentCart.deliveryAddressId;
    for (const li of sentCart.lineItems) {
      const id = String(li.id);
      const idx = target.lineItems.findIndex((x) => String(x.id) === id);
      if ((Number(li.quantity) || 0) === 0) {
        if (idx >= 0) target.lineItems.splice(idx, 1);
      } else if (idx >= 0) {
        target.lineItems[idx] = structuredClone(li);
      } else {
        target.lineItems.push(structuredClone(li));
      }
    }
  }
  return next;
}

interface FakeAPI {
  api: CheckersAPI;
  getCarts: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  mutate: (fn: (s: PlanSnapshot) => void) => void;
}

/**
 * A stateful fake cart. `getCarts` returns the current state; `commitCartUpdate`
 * replaces it with what was sent (or `onCommit`'s result); `deleteCart` empties
 * and rotates the id of the addressed cart (matching the real server).
 */
function fakeApi(
  initial: PlanSnapshot,
  opts: {
    onCommit?: (s: PlanSnapshot) => PlanSnapshot | void;
    throwOnCommit?: unknown; // truthy → throw this (or a default Error) instead of committing
    throwAfterApply?: boolean;
    session?: typeof SESSION;
    failReadOnCall?: number; // getCarts throws on its Nth invocation (1-based)
  } = {}
): FakeAPI {
  let state = structuredClone(initial);
  let reads = 0;
  const getCarts = vi.fn(async () => {
    reads += 1;
    if (opts.failReadOnCall && reads === opts.failReadOnCall) throw new Error("read failed");
    return structuredClone(state);
  });
  const commit = vi.fn(async (s: PlanSnapshot) => {
    if ("throwOnCommit" in opts) {
      // Reject with the exact configured value (may be falsey — e.g. undefined/null).
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw opts.throwOnCommit;
    }
    if (opts.onCommit) {
      // Tests that use onCommit author the post-state directly (divergence, lost
      // update, weird server responses), so it fully controls the outcome.
      const r = opts.onCommit(s);
      state = structuredClone(r ?? s);
    } else {
      // Model the real /carts/update contract: MERGE the sent lines into the
      // current cart (upsert by line id), delete any line sent with quantity 0,
      // and leave omitted lines untouched. A fake that replaced state wholesale
      // hid the tombstone requirement (an omitted removal silently "worked").
      state = mergeCartUpdate(state, s);
    }
    if (opts.throwAfterApply) throw new Error("connection reset after apply");
    return structuredClone(state);
  });
  const del = vi.fn(async (cartId: string) => {
    state = structuredClone(state);
    for (const c of state.carts) {
      if (c.cartId === cartId) {
        c.cartId = `${cartId}-new`;
        c.cartVersion = 0;
        c.lineItems = [];
      }
    }
  });
  const api = {
    tokens: { getSession: vi.fn(async () => opts.session ?? SESSION) },
    getCarts,
    commitCartUpdate: commit,
    deleteCart: del,
  } as unknown as CheckersAPI;
  return {
    api,
    getCarts,
    commit,
    del,
    mutate: (fn) => {
      fn(state);
    },
  };
}

type BuildFn = (
  targetCart: { cartId: string; lineItems: Record<string, unknown>[] },
  serviceOptionId: string
) => Promise<{ intent: MutationIntent; displayName?: string } | { noop: true; reason?: string }>;

const addProd =
  (qty = 1): BuildFn =>
  async (targetCart, so) => {
    const present = targetCart.lineItems.some((li) => li.productId === "PROD");
    return {
      intent: {
        operation: "cart.add",
        targetCartId: targetCart.cartId,
        targetServiceOptionId: so,
        productId: "PROD",
        quantity: qty,
        newLine: present ? undefined : line({ id: "li-new", quantity: qty }),
      },
    };
  };

const removeProd =
  (qty?: number): BuildFn =>
  async (targetCart, so) => ({
    intent: {
      operation: "cart.remove",
      targetCartId: targetCart.cartId,
      targetServiceOptionId: so,
      productId: "PROD",
      quantity: qty,
    },
  });

let outSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "c60-plans-"));
  process.env.CHECKERS60_PLANS_DIR = tmp;
  process.exitCode = 0;
  outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true) as unknown as ReturnType<typeof vi.fn>;
});

afterEach(() => {
  outSpy.mockRestore();
  delete process.env.CHECKERS60_PLANS_DIR;
  process.exitCode = 0;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(outSpy.mock.calls.map((c) => String(c[0])).join(""));
}

async function preview(f: FakeAPI, build: BuildFn, op: MutationIntent["operation"] = "cart.add"): Promise<string> {
  await runCartMutation(f.api, op, { json: true }, build);
  const planId = (lastJson().plan as Record<string, unknown>).planId as string;
  outSpy.mock.calls.length = 0;
  process.exitCode = 0;
  return planId;
}

describe("cart mutation gate — preview", () => {
  it("makes NO write call, exits 5, and persists a single-use plan artifact", async () => {
    const f = fakeApi(snapshot([]));
    await runCartMutation(f.api, "cart.add", { json: true }, addProd(2));

    expect(f.commit).not.toHaveBeenCalled();
    expect(f.del).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CONFIRM);
    const out = lastJson();
    expect(out.confirmationRequired).toBe(true);
    expect(String(out.confirm)).toContain("--confirm sha256:");
    expect(readdirSync(plansDir()).filter((x) => x.endsWith(".json"))).toHaveLength(1);
  });

  it("previews the resulting item count without touching the cart", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]));
    await runCartMutation(f.api, "cart.add", { json: true }, addProd(3));
    const plan = lastJson().plan as Record<string, unknown>;
    expect(plan.before).toBe(1);
    expect(plan.after).toBe(4);
  });
});

describe("cart mutation gate — confirm", () => {
  it("applies the write, preserving unrelated line-item fields", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]));
    const planId = await preview(f, addProd(1));

    await runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1));

    expect(f.commit).toHaveBeenCalledOnce();
    const body = f.commit.mock.calls[0][0] as PlanSnapshot;
    const target = body.carts.find((c) => c.cartId === "cart-60")!;
    expect(target.lineItems[0].quantity).toBe(2);
    expect(target.lineItems[0].replacementPreferenceId).toBe("pref-x");
    expect(target.lineItems[0].instruction).toBe("handle with care");
    expect(body.carts).toHaveLength(2); // both modes round-tripped
    expect(body.deliveryAddressId).toBe("addr-1"); // real address preserved
    expect(process.exitCode).toBe(0);
  });

  it("refuses (exit 5, no write) when the cartVersion changed since preview", async () => {
    const f = fakeApi(snapshot([line()], 5));
    const planId = await preview(f, addProd(1));
    f.mutate((s) => {
      s.carts[0].cartVersion = 6; // concurrent writer bumped the version
    });
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("refuses when line items changed even if the version matched", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })], 5));
    const planId = await preview(f, addProd(1));
    f.mutate((s) => {
      s.carts[0].lineItems[0].quantity = 9;
    });
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("refuses when a cart is missing its version at confirm time", async () => {
    const f = fakeApi(snapshot([line()], 5));
    const planId = await preview(f, addProd(1));
    f.mutate((s) => {
      s.carts[0].cartVersion = Number.NaN;
    });
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("is single-use: a second confirm of the same plan refuses and does NOT re-write", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]));
    const planId = await preview(f, addProd(1));

    await runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1));
    expect(f.commit).toHaveBeenCalledOnce();

    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it("refuses a missing / unknown plan id", async () => {
    const f = fakeApi(snapshot([line()]));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: `sha256:${"0".repeat(64)}` }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("refuses a corrupt plan artifact", async () => {
    const f = fakeApi(snapshot([line()]));
    const planId = await preview(f, addProd(1));
    const file = readdirSync(plansDir()).find((x) => x.endsWith(".json"))!;
    writeFileSync(join(plansDir(), file), "{not json");
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("refuses a plan whose stored content was tampered (integrity check)", async () => {
    const f = fakeApi(snapshot([line()]));
    const planId = await preview(f, addProd(1));
    const file = readdirSync(plansDir()).find((x) => x.endsWith(".json"))!;
    const plan = JSON.parse(readFileSync(join(plansDir(), file), "utf8"));
    plan.mutation.quantity = 999; // tamper without recomputing the id
    writeFileSync(join(plansDir(), file), JSON.stringify(plan));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).not.toHaveBeenCalled();
  });
});

describe("cart mutation gate — reconcile", () => {
  it("reports failure (exit 5) when the write left the cart unchanged", async () => {
    // onCommit ignores the sent body and keeps the original state (lost update).
    const original = snapshot([line({ quantity: 1 })]);
    const f = fakeApi(original, { onCommit: () => structuredClone(original) });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
  });

  it("raises a divergent-outcome (exit 6) when the cart matches neither intended nor original", async () => {
    const weird = snapshot([line({ productId: "OTHER", quantity: 7 })]);
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: () => structuredClone(weird),
    });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("is divergent when the target change lands but ANOTHER cart changed collaterally", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: (sent) => {
        const s = structuredClone(sent);
        s.carts.find((c) => c.serviceOptionId === "one-day-delivery")!.lineItems.push(
          line({ id: "x", productId: "COLLAT" })
        );
        return s;
      },
    });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("is divergent (exit 6) when the post-write cart has duplicate modes", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: (sent) => {
        const s = structuredClone(sent);
        // Server returns two sixty-min carts — ambiguous; must never read as success.
        s.carts.push({
          cartId: "cart-60-dup",
          serviceOptionId: "sixty-min-delivery",
          cartVersion: 1,
          deliveryAddressId: "addr-1",
          lineItems: [line({ id: "d", quantity: 2 })],
        });
        return s;
      },
    });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("is divergent when the top-level delivery address changed collaterally", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: (sent) => {
        const s = structuredClone(sent);
        s.deliveryAddressId = "addr-CHANGED";
        return s;
      },
    });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("is divergent when a per-cart delivery address changed collaterally", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: (sent) => {
        const s = structuredClone(sent);
        s.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!.deliveryAddressId =
          "addr-PER-CART-CHANGED";
        return s;
      },
    });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("a falsey dispatch rejection is still treated as a failure (unchanged → exit 5, 'write failed')", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]), { throwOnCommit: undefined });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof PlanStaleError && /write failed/i.test((e as Error).message)
    );
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it("dispatch throws but cart is unchanged → exit 5 (re-preview), plan still claimed, no retry", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]), { throwOnCommit: true });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.commit).toHaveBeenCalledOnce(); // never auto-retried
    expect(readdirSync(plansDir()).some((x) => x.endsWith(".json.used"))).toBe(true);
  });

  it("dispatch throws but the write actually landed → reconciles to success", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]), { throwAfterApply: true });
    const planId = await preview(f, addProd(1));
    await runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1));
    expect(process.exitCode).toBe(0);
    expect(lastJson().ok).toBe(true);
  });

  it("dispatch reads back a divergent third state → exit 6", async () => {
    const weird = snapshot([line({ productId: "OTHER", quantity: 7 })]);
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: () => structuredClone(weird),
    });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });
});

describe("cart mutation gate — empty-cart via DELETE", () => {
  it("removing the last item uses deleteCart (not an empty /carts/update)", async () => {
    const f = fakeApi(snapshot([line({ quantity: 3 })]));
    const planId = await preview(f, removeProd(), "cart.remove");
    await runCartMutation(f.api, "cart.remove", { json: true, confirm: planId }, removeProd());
    expect(f.del).toHaveBeenCalledOnce();
    expect(f.del.mock.calls[0][0]).toBe("cart-60");
    expect(f.commit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("clear on a non-empty cart uses deleteCart", async () => {
    const clearBuild: BuildFn = async (tc, so) => ({
      intent: { operation: "cart.clear", targetCartId: tc.cartId, targetServiceOptionId: so },
    });
    const f = fakeApi(snapshot([line(), line({ id: "li-2", productId: "P2" })]));
    const planId = await preview(f, clearBuild, "cart.clear");
    await runCartMutation(f.api, "cart.clear", { json: true, confirm: planId }, clearBuild);
    expect(f.del).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("clear on an already-empty cart is a clean no-op (no plan, no write)", async () => {
    const clearBuild: BuildFn = async (tc, so) => {
      if (tc.lineItems.length === 0) return { noop: true, reason: "already empty" };
      return {
        intent: { operation: "cart.clear", targetCartId: tc.cartId, targetServiceOptionId: so },
      };
    };
    const f = fakeApi(snapshot([]));
    await runCartMutation(f.api, "cart.clear", { json: true }, clearBuild);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.del).not.toHaveBeenCalled();
    expect(readdirSync(plansDir()).filter((x) => x.endsWith(".json"))).toHaveLength(0);
    expect(lastJson().noop).toBe(true);
  });

  it("removing with a remainder uses /carts/update, not DELETE", async () => {
    const f = fakeApi(snapshot([line({ quantity: 3 })]));
    const planId = await preview(f, removeProd(1), "cart.remove");
    await runCartMutation(f.api, "cart.remove", { json: true, confirm: planId }, removeProd(1));
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.del).not.toHaveBeenCalled();
    const body = f.commit.mock.calls[0][0] as PlanSnapshot;
    expect(body.carts.find((c) => c.cartId === "cart-60")!.lineItems[0].quantity).toBe(2);
  });
});

describe("cart mutation gate — unsupported shapes", () => {
  it("refuses to quantity-adjust an age-restricted line", async () => {
    const f = fakeApi(snapshot([line({ hasAlcohol: true })]));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true }, addProd(1))
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses to quantity-adjust a weighted line", async () => {
    const f = fakeApi(snapshot([line({ selectedWeightRange: { min: 1, max: 2 } })]));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true }, addProd(1))
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses an ambiguous cart state with two carts of the same mode", async () => {
    const dup = snapshot([line()]);
    dup.carts.push({
      cartId: "cart-60b",
      serviceOptionId: "sixty-min-delivery",
      cartVersion: 1,
      deliveryAddressId: "addr-1",
      lineItems: [],
    });
    const f = fakeApi(dup);
    await expect(
      runCartMutation(f.api, "cart.add", { json: true }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
  });

  it("refuses an option-bearing existing line", async () => {
    const f = fakeApi(snapshot([line({ optionSelections: [{ id: "o1" }] })]));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true }, addProd(1))
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("cart mutation gate — account binding & concurrency", () => {
  it("refuses a plan confirmed under a different account", async () => {
    const start = snapshot([line({ quantity: 1 })]);
    const previewer = fakeApi(start);
    const planId = await preview(previewer, addProd(1));

    const other = fakeApi(start, { session: { ...SESSION, userId: "someone-else", uuid: "other" } });
    await expect(
      runCartMutation(other.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(other.commit).not.toHaveBeenCalled();
  });

  it("two concurrent confirms of one plan: exactly one writes (atomic single-use claim)", async () => {
    const f = fakeApi(snapshot([line({ quantity: 1 })]));
    const planId = await preview(f, addProd(1));

    const results = await Promise.allSettled([
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1)),
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof PlanStaleError
    ).length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    expect(f.commit).toHaveBeenCalledOnce();
  });
});

describe("cart mutation gate — reconcile robustness", () => {
  it("treats split/reordered server lines as success (aggregate multiset)", async () => {
    // Cart has PROD ×1; add ×1 → intended PROD ×2. Server returns it as two lines ×1 reordered.
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: (sent) => {
        const s = structuredClone(sent);
        const c = s.carts.find((x) => x.serviceOptionId === "sixty-min-delivery")!;
        c.lineItems = [
          line({ id: "b", productId: "PROD", quantity: 1 }),
          line({ id: "a", productId: "PROD", quantity: 1 }),
        ];
        return s;
      },
    });
    const planId = await preview(f, addProd(1));
    await runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1));
    expect(process.exitCode).toBe(0);
    expect(lastJson().ok).toBe(true);
  });

  it("dispatch throws AFTER a divergent apply → exit 6", async () => {
    const weird = snapshot([line({ productId: "OTHER", quantity: 5 })]);
    const f = fakeApi(snapshot([line({ quantity: 1 })]), {
      onCommit: () => structuredClone(weird),
      throwAfterApply: true,
    });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("post-dispatch re-read failure → exit 6 (outcome unknown)", async () => {
    // getCarts calls: 1 preview, 2 confirm-guard, 3 post-dispatch reconcile (fails).
    const f = fakeApi(snapshot([line({ quantity: 1 })]), { failReadOnCall: 3 });
    const planId = await preview(f, addProd(1));
    await expect(
      runCartMutation(f.api, "cart.add", { json: true, confirm: planId }, addProd(1))
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });
});

describe("cart mutation gate — split-line removal", () => {
  const twoLines = () =>
    snapshot([
      line({ id: "l1", productId: "PROD", quantity: 2 }),
      line({ id: "l2", productId: "PROD", quantity: 3 }),
    ]);

  it("remove (qty omitted) drops EVERY line for the product", async () => {
    const f = fakeApi(twoLines());
    const planId = await preview(f, removeProd(), "cart.remove");
    await runCartMutation(f.api, "cart.remove", { json: true, confirm: planId }, removeProd());
    // 5 total → empty → DELETE.
    expect(f.del).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("partial remove consumes quantity across split lines", async () => {
    const f = fakeApi(twoLines());
    const planId = await preview(f, removeProd(3), "cart.remove"); // remove 3 of 5 → 2 remain
    await runCartMutation(f.api, "cart.remove", { json: true, confirm: planId }, removeProd(3));
    expect(f.commit).toHaveBeenCalledOnce();
    const body = f.commit.mock.calls[0][0] as PlanSnapshot;
    const target = body.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!;
    const totalQty = target.lineItems
      .filter((li) => li.productId === "PROD")
      .reduce((n, li) => n + (Number(li.quantity) || 0), 0);
    expect(totalQty).toBe(2);
  });

  // Regression: removing one product from a multi-product cart (cart NOT emptied,
  // so it goes through /carts/update, not DELETE). The endpoint MERGES lines, so a
  // removal expressed by omission is silently ignored — the item stays. The write
  // must send a quantity-0 tombstone. Before the fix the final state still had PROD.
  it("removes only the target product from a multi-product cart (tombstone, not omission)", async () => {
    const start = snapshot([
      line({ id: "p", productId: "PROD", quantity: 1 }),
      line({ id: "k", productId: "KEEP", quantity: 1 }),
    ]);
    const f = fakeApi(start);
    const planId = await preview(f, removeProd(), "cart.remove");
    await runCartMutation(f.api, "cart.remove", { json: true, confirm: planId }, removeProd());
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.del).not.toHaveBeenCalled();
    const final = (await f.getCarts()) as PlanSnapshot;
    const t = final.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!;
    expect(t.lineItems.map((li) => li.productId).sort()).toEqual(["KEEP"]);
  });
});

describe("buildWriteSnapshot (tombstones for the merge-semantics /carts/update)", () => {
  const target = (s: PlanSnapshot) =>
    s.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!;

  it("emits a quantity-0 tombstone for a line the mutation dropped", () => {
    const prev = snapshot([line({ id: "keep", productId: "A" }), line({ id: "drop", productId: "B" })]);
    const intended = snapshot([line({ id: "keep", productId: "A" })]);
    const t = target(buildWriteSnapshot(prev, intended));
    expect(t.lineItems.find((li) => li.id === "drop")?.quantity).toBe(0);
    expect(t.lineItems.find((li) => li.id === "keep")?.quantity).toBe(1);
  });

  it("adds no tombstone for a pure add", () => {
    const prev = snapshot([line({ id: "a", productId: "A" })]);
    const intended = snapshot([line({ id: "a", productId: "A" }), line({ id: "b", productId: "B" })]);
    const t = target(buildWriteSnapshot(prev, intended));
    expect(t.lineItems).toHaveLength(2);
    expect(t.lineItems.every((li) => (Number(li.quantity) || 0) > 0)).toBe(true);
  });

  it("keeps a decremented line by id without tombstoning it", () => {
    const prev = snapshot([line({ id: "a", productId: "A", quantity: 5 })]);
    const intended = snapshot([line({ id: "a", productId: "A", quantity: 2 })]);
    const t = target(buildWriteSnapshot(prev, intended));
    expect(t.lineItems).toHaveLength(1);
    expect(t.lineItems[0].quantity).toBe(2);
  });

  it("does not mutate the intended snapshot it was given", () => {
    const prev = snapshot([line({ id: "a" }), line({ id: "b", productId: "B" })]);
    const intended = snapshot([line({ id: "a" })]);
    const before = structuredClone(intended);
    buildWriteSnapshot(prev, intended);
    expect(intended).toEqual(before);
  });
});
