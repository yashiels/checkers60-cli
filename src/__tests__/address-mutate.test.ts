import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, AddressStoreContext, CheckersAPI } from "../lib/api.js";
import { runAddressUse } from "../lib/address-mutate.js";
import type { PlanSnapshot } from "../lib/confirm.js";
import { mobileHash, plansDir, PlanStaleError, writePlan } from "../lib/confirm.js";
import { DivergentOutcomeError, EXIT_CONFIRM, UsageError } from "../lib/errors.js";

let tmp: string;
let outSpy: ReturnType<typeof vi.fn>;

const SESSION = {
  sessionToken: "sess",
  userId: "user-1",
  uuid: "uuid-1",
  mobile: "+27820000000",
  customerId: "CUST",
};

const FROM = "addr-A";
const TARGET = "addr-B";

function addresses(): Address[] {
  return [
    { _id: FROM, name: "Home", coordinates: { latitude: -33.9, longitude: 18.4 } },
    { _id: TARGET, name: "Office", coordinates: { latitude: -34.0, longitude: 18.5 } },
  ];
}

function line(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "li-1",
    productId: "PROD",
    quantity: 2,
    price: 1299,
    priceFactor: 100,
    storeId: "S",
    status: "available",
    replacementPreferenceId: "pref-x",
    instruction: "handle with care",
    // A meaningful field OUTSIDE the old hard-coded whitelist — the denylist-based
    // signature must still compare it, so a silent flip reads as divergent.
    substitutionAllowed: true,
    serviceOptionId: "sixty-min-delivery",
    ...over,
  };
}

function snapshot(addr = FROM): PlanSnapshot {
  return {
    carts: [
      {
        cartId: "cart-60",
        serviceOptionId: "sixty-min-delivery",
        cartVersion: 5,
        deliveryAddressId: addr,
        lineItems: [line()],
      },
      {
        cartId: "cart-1d",
        serviceOptionId: "one-day-delivery",
        cartVersion: 2,
        deliveryAddressId: addr,
        lineItems: [],
      },
    ],
    deliveryAddressId: addr,
    storeContexts: [],
  };
}

const CONTEXTS: AddressStoreContext[] = [
  { storeId: "NS1", serviceOptionIds: ["sixty-min-delivery"] },
  { storeId: "NS2", serviceOptionIds: ["one-day-delivery"] },
];

/**
 * The default server effect of the switch: rotate cart ids + line ids, re-home
 * lines to the new store, point every cart at the target address, and preserve
 * line contents (productId/quantity/attrs). Applied by transferCartDummies.
 */
function applySwitch(state: PlanSnapshot, targetId: string): void {
  state.carts = state.carts.map((c) => ({
    ...c,
    cartId: `${c.cartId}-new`,
    cartVersion: 0,
    deliveryAddressId: targetId,
    lineItems: c.lineItems.map((li) => ({ ...li, id: `${String(li.id)}-r`, storeId: "NEWSTORE" })),
  }));
  state.deliveryAddressId = targetId;
}

interface FakeOpts {
  initial?: PlanSnapshot;
  addrs?: Address[];
  contexts?: AddressStoreContext[];
  emptyContexts?: boolean;
  failAt?: 1 | 2 | 3 | 4; // throw on the Nth switch call (1=use … 4=transfer)
  throwAfterTransfer?: boolean; // apply the switch, then throw (ambiguous transport)
  onTransfer?: (state: PlanSnapshot, targetId: string) => void; // custom post-state
  failReadOnCall?: number; // getCarts throws on its Nth invocation
  reconcileContexts?: AddressStoreContext[]; // store contexts returned by the POST-dispatch re-read
  failContextReread?: boolean; // the post-dispatch store-context re-read throws
  session?: typeof SESSION;
}

interface FakeAPI {
  api: CheckersAPI;
  calls: string[];
  getCarts: ReturnType<typeof vi.fn>;
  use: ReturnType<typeof vi.fn>;
  contexts: ReturnType<typeof vi.fn>;
  updateAddr: ReturnType<typeof vi.fn>;
  transfer: ReturnType<typeof vi.fn>;
  state: () => PlanSnapshot;
}

function fakeApi(opts: FakeOpts = {}): FakeAPI {
  let state = structuredClone(opts.initial ?? snapshot());
  const calls: string[] = [];
  let reads = 0;

  const getCarts = vi.fn(async () => {
    reads += 1;
    if (opts.failReadOnCall && reads === opts.failReadOnCall) throw new Error("read failed");
    return structuredClone(state);
  });
  const getAddresses = vi.fn(async () => structuredClone(opts.addrs ?? addresses()));
  const use = vi.fn(async (_id: string) => {
    calls.push("useAddress");
    if (opts.failAt === 1) throw new Error("use failed");
  });
  let contextCalls = 0;
  const contexts = vi.fn(async (_lat: number, _lng: number) => {
    contextCalls += 1;
    const isDispatch = contextCalls === 1; // #1 = dispatch step 2; #2 = post-dispatch reconcile
    if (isDispatch) {
      // Only the dispatch call is part of the ordered switch flow.
      calls.push("getAddressStoreContexts");
      if (opts.failAt === 2) throw new Error("store-contexts failed");
    } else {
      if (opts.failContextReread) throw new Error("store-contexts reread failed");
      if (opts.reconcileContexts) return structuredClone(opts.reconcileContexts);
    }
    return opts.emptyContexts ? [] : structuredClone(opts.contexts ?? CONTEXTS);
  });
  const updateAddr = vi.fn(async (_ctx: AddressStoreContext[]) => {
    calls.push("updateCartAddress");
    if (opts.failAt === 3) throw new Error("update-address failed");
    return state.carts.map((c) => `${c.cartId}-new`);
  });
  const transfer = vi.fn(async (_args: unknown) => {
    calls.push("transferCartDummies");
    if (opts.failAt === 4) throw new Error("transfer failed");
    const next = structuredClone(state);
    if (opts.onTransfer) opts.onTransfer(next, TARGET);
    else applySwitch(next, TARGET);
    state = next;
    if (opts.throwAfterTransfer) throw new Error("connection reset after transfer");
  });

  const api = {
    tokens: { getSession: vi.fn(async () => opts.session ?? SESSION) },
    getAddresses,
    getCarts,
    useAddress: use,
    getAddressStoreContexts: contexts,
    updateCartAddress: updateAddr,
    transferCartDummies: transfer,
  } as unknown as CheckersAPI;

  return { api, calls, getCarts, use, contexts, updateAddr, transfer, state: () => state };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "c60-addr-plans-"));
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

async function preview(f: FakeAPI): Promise<string> {
  await runAddressUse(f.api, TARGET, { json: true });
  const planId = (lastJson().plan as Record<string, unknown>).planId as string;
  outSpy.mock.calls.length = 0;
  process.exitCode = 0;
  return planId;
}

function assertNoWrites(f: FakeAPI): void {
  expect(f.use).not.toHaveBeenCalled();
  expect(f.contexts).not.toHaveBeenCalled();
  expect(f.updateAddr).not.toHaveBeenCalled();
  expect(f.transfer).not.toHaveBeenCalled();
}

describe("address switch gate — preview", () => {
  it("makes NO write, exits 5, and persists a single-use plan artifact", async () => {
    const f = fakeApi();
    await runAddressUse(f.api, TARGET, { json: true });

    assertNoWrites(f);
    expect(process.exitCode).toBe(EXIT_CONFIRM);
    const out = lastJson();
    expect(out.confirmationRequired).toBe(true);
    expect(String(out.confirm)).toContain("--confirm sha256:");
    expect(readdirSync(plansDir()).filter((x) => x.endsWith(".json"))).toHaveLength(1);
  });

  it("target id not in getAddresses → UsageError (exit 2), zero writes, no plan", async () => {
    const f = fakeApi();
    await expect(runAddressUse(f.api, "addr-UNKNOWN", { json: true })).rejects.toBeInstanceOf(
      UsageError
    );
    assertNoWrites(f);
    expect(readdirSync(plansDir()).filter((x) => x.endsWith(".json"))).toHaveLength(0);
  });

  it("switching to the already-active address is a clean no-op (no plan, no write)", async () => {
    const f = fakeApi();
    await runAddressUse(f.api, FROM, { json: true });
    assertNoWrites(f);
    expect(lastJson().noop).toBe(true);
    expect(readdirSync(plansDir()).filter((x) => x.endsWith(".json"))).toHaveLength(0);
  });
});

describe("address switch gate — confirm dispatch", () => {
  it("issues the EXACT 4-call flow in order and reconciles to success", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    await runAddressUse(f.api, TARGET, { json: true, confirm: planId });

    expect(f.calls).toEqual([
      "useAddress",
      "getAddressStoreContexts",
      "updateCartAddress",
      "transferCartDummies",
    ]);
    expect(process.exitCode).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, operation: "address.use", addressId: TARGET });
  });

  it("passes the current cart ids as fromCartIds and the target as newDeliveryAddressId", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    await runAddressUse(f.api, TARGET, { json: true, confirm: planId });
    const args = f.transfer.mock.calls[0][0] as {
      fromCartIds: string[];
      toCartIds: string[];
      newDeliveryAddressId: string;
    };
    expect(args.fromCartIds.sort()).toEqual(["cart-1d", "cart-60"]);
    expect(args.newDeliveryAddressId).toBe(TARGET);
  });

  it("tolerates cart-ID rotation when contents are preserved (success)", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    await runAddressUse(f.api, TARGET, { json: true, confirm: planId });
    // Cart ids rotated, delivery address switched, contents preserved.
    const after = f.state();
    expect(after.carts.map((c) => c.cartId).sort()).toEqual(["cart-1d-new", "cart-60-new"]);
    expect(after.carts.every((c) => c.deliveryAddressId === TARGET)).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(lastJson().ok).toBe(true);
  });
});

describe("address switch gate — plan lifecycle", () => {
  it("is single-use: a second confirm of the same plan refuses and does NOT re-dispatch", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    await runAddressUse(f.api, TARGET, { json: true, confirm: planId });
    expect(f.transfer).toHaveBeenCalledOnce();

    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.transfer).toHaveBeenCalledOnce();
  });

  it("refuses a missing / unknown plan id (exit 5), zero writes", async () => {
    const f = fakeApi();
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: `sha256:${"0".repeat(64)}` })
    ).rejects.toBeInstanceOf(PlanStaleError);
    assertNoWrites(f);
  });

  it("refuses a plan created for a DIFFERENT operation (exit 5), zero writes", async () => {
    const f = fakeApi();
    // A generic plan for a different operation must never drive an address switch.
    const foreign = writePlan(
      { userId: SESSION.userId, uuid: SESSION.uuid, mobileHash: mobileHash(SESSION.mobile) },
      "fav.add",
      { payload: { productId: "x" }, preconditions: { wasFavourite: false } }
    );
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: foreign.planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
    assertNoWrites(f);
  });

  it("refuses a corrupt plan artifact, zero writes", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    const file = readdirSync(plansDir()).find((x) => x.endsWith(".json"))!;
    writeFileSync(join(plansDir(), file), "{not json");
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
    assertNoWrites(f);
  });

  it("refuses a tampered plan artifact (integrity check), zero writes", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    const file = readdirSync(plansDir()).find((x) => x.endsWith(".json"))!;
    const plan = JSON.parse(readFileSync(join(plansDir(), file), "utf8"));
    plan.payload.addressId = "addr-EVIL"; // tamper without recomputing the id
    writeFileSync(join(plansDir(), file), JSON.stringify(plan));
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
    assertNoWrites(f);
  });

  it("refuses a plan confirmed under a different account, zero writes", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    const other = fakeApi({ session: { ...SESSION, userId: "someone-else", uuid: "other" } });
    await expect(
      runAddressUse(other.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
    assertNoWrites(other);
  });

  it("refuses (exit 5) when the cart changed since the preview", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    // A concurrent writer bumped a cart version between preview and confirm.
    f.state().carts[0].cartVersion = 6;
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
    assertNoWrites(f);
  });

  it("refuses (exit 5) when a MEANINGFUL line field drifted between preview and confirm", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    // A replacement-preference change between preview and confirm must be rejected
    // at the drift guard — not silently carried into the switch.
    f.state().carts[0].lineItems[0].replacementPreferenceId = "pref-DRIFTED";
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
    assertNoWrites(f);
  });
});

describe("address switch gate — failure at each step (reconcile decides, never a false success)", () => {
  for (const step of [1, 2, 3, 4] as const) {
    it(`step ${step} throws → no false success; carts unchanged → stale (exit 5)`, async () => {
      const f = fakeApi({ failAt: step });
      const planId = await preview(f);
      await expect(
        runAddressUse(f.api, TARGET, { json: true, confirm: planId })
      ).rejects.toBeInstanceOf(PlanStaleError);
      // Never auto-retried; the delivery address never moved off the original.
      expect(f.transfer.mock.calls.length).toBeLessThanOrEqual(1);
      expect(f.state().carts.every((c) => c.deliveryAddressId === FROM)).toBe(true);
      // The plan was claimed (single-use) before the first POST.
      expect(readdirSync(plansDir()).some((x) => x.endsWith(".json.used"))).toBe(true);
    });
  }

  it("empty store-contexts (no serviceable stores) → not success", async () => {
    // useAddress succeeds but coverage is empty; the switch cannot complete.
    const f = fakeApi({ emptyContexts: true, onTransfer: () => {} });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(PlanStaleError);
  });
});

describe("address switch gate — ambiguous transport & divergence", () => {
  it("last call (transfer) throws AFTER fully applying, reads look intended → divergent, NOT ok:true", async () => {
    // A multi-step switch that errors mid-flight can never read as clean success,
    // even when the post-dispatch reads happen to show the intended state.
    const f = fakeApi({ throwAfterTransfer: true });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
    // The effect did land server-side (so this is genuinely unconfirmable, not stale).
    expect(f.state().carts.every((c) => c.deliveryAddressId === TARGET)).toBe(true);
  });

  it("PARTIAL switch (some carts moved, some not) → divergent (exit 6)", async () => {
    const f = fakeApi({
      onTransfer: (state) => {
        // Only the sixty-min cart moved to the target; one-day stayed behind.
        const sixty = state.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!;
        sixty.cartId = "cart-60-new";
        sixty.deliveryAddressId = TARGET;
      },
    });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("address reached on every cart but CONTENTS changed → divergent (exit 6)", async () => {
    const f = fakeApi({
      onTransfer: (state, targetId) => {
        applySwitch(state, targetId);
        // A line quantity silently changed during the transfer.
        const sixty = state.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!;
        sixty.lineItems[0].quantity = 99;
      },
    });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("address reached but a line's preserved attribute (replacement preference) changed → divergent", async () => {
    const f = fakeApi({
      onTransfer: (state, targetId) => {
        applySwitch(state, targetId);
        const sixty = state.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!;
        sixty.lineItems[0].replacementPreferenceId = "pref-DIFFERENT";
      },
    });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("address reached but a MEANINGFUL non-whitelisted line field changed → divergent", async () => {
    // `substitutionAllowed` is not in the old hard-coded whitelist; the denylist-
    // based signature must still catch it flipping, or the switch silently lost it.
    const f = fakeApi({
      onTransfer: (state, targetId) => {
        applySwitch(state, targetId);
        const sixty = state.carts.find((c) => c.serviceOptionId === "sixty-min-delivery")!;
        sixty.lineItems[0].substitutionAllowed = false;
      },
    });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("a server-assigned line field (id/storeId) changing is NOT divergent (success)", async () => {
    // The default switch rotates id + storeId; those are denylisted, so the switch
    // still reconciles to success.
    const f = fakeApi();
    const planId = await preview(f);
    await runAddressUse(f.api, TARGET, { json: true, confirm: planId });
    expect(lastJson().ok).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("store contexts CHANGE after dispatch so they no longer cover a mode → divergent", async () => {
    // The address switched on every cart, but the POST-dispatch store-context
    // re-read no longer covers the one-day mode — success must NOT be reported off
    // the stale pre-write context.
    const f = fakeApi({
      reconcileContexts: [{ storeId: "NS1", serviceOptionIds: ["sixty-min-delivery"] }],
    });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("post-dispatch store-context re-read fails → divergent (outcome unconfirmable)", async () => {
    const f = fakeApi({ failContextReread: true });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("post-dispatch re-read failure → exit 6 (outcome unknown)", async () => {
    // getCarts calls: 1 preview, 2 confirm-guard, 3 post-dispatch reconcile (fails).
    const f = fakeApi({ failReadOnCall: 3 });
    const planId = await preview(f);
    await expect(
      runAddressUse(f.api, TARGET, { json: true, confirm: planId })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("two concurrent confirms of one plan: exactly one dispatches (atomic single-use claim)", async () => {
    const f = fakeApi();
    const planId = await preview(f);
    const results = await Promise.allSettled([
      runAddressUse(f.api, TARGET, { json: true, confirm: planId }),
      runAddressUse(f.api, TARGET, { json: true, confirm: planId }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof PlanStaleError
    ).length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    expect(f.transfer).toHaveBeenCalledOnce();
  });
});
