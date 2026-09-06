import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePlanId,
  loadPlan,
  plansDir,
  PLAN_CANON,
  PLAN_SCHEMA_VERSION,
  PLAN_TTL_MS,
  PlanStaleError,
  writePlan,
  type PlanAccount,
  type PlanBody,
  type PlanSnapshot,
} from "../lib/confirm.js";

let tmp: string;

const ACCT: PlanAccount = { userId: "u1", uuid: "x1", mobileHash: "h1" };

const genericBody = (productId = "p1"): PlanBody => ({
  payload: { productId, isFavourite: true },
  preconditions: { wasFavourite: false },
});

function snapshot(): PlanSnapshot {
  return {
    carts: [
      {
        cartId: "cart-60",
        serviceOptionId: "sixty-min-delivery",
        cartVersion: 1,
        deliveryAddressId: "addr-1",
        lineItems: [],
      },
    ],
    deliveryAddressId: "addr-1",
    storeContexts: [],
  };
}

const cartBody = (): PlanBody => ({
  snapshot: snapshot(),
  mutation: {
    operation: "cart.clear",
    targetCartId: "cart-60",
    targetServiceOptionId: "sixty-min-delivery",
  },
});

/** Read the single stored plan artifact, mutate its JSON, and rewrite it (same file/id). */
function tamperStored(mutate: (raw: Record<string, unknown>) => void): void {
  const file = readdirSync(plansDir()).find((x) => x.endsWith(".json"))!;
  const path = join(plansDir(), file);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(raw);
  writeFileSync(path, JSON.stringify(raw));
}

/** Write a fully-hashed plan straight to disk from an arbitrary core (for negative tests). */
function forgePlan(core: Record<string, unknown>): string {
  const planId = computePlanId(core as never);
  const plan = { ...core, planId };
  const safe = planId.replace(/[^a-z0-9]/gi, "_");
  writeFileSync(join(plansDir(), `${safe}.json`), `${JSON.stringify(plan)}\n`);
  return planId;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "c60-confirm-"));
  process.env.CHECKERS60_PLANS_DIR = tmp;
});

afterEach(() => {
  delete process.env.CHECKERS60_PLANS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("confirm — round trip", () => {
  it("loads a generic plan under its own operation", () => {
    const plan = writePlan(ACCT, "fav.add", genericBody());
    expect(loadPlan(plan.planId, ACCT, "fav.add").planId).toBe(plan.planId);
  });

  it("loads a cart plan under its own operation", () => {
    const plan = writePlan(ACCT, "cart.clear", cartBody());
    expect(loadPlan(plan.planId, ACCT, "cart.clear").planId).toBe(plan.planId);
  });
});

describe("confirm — unknown top-level keys", () => {
  it("rejects a plan carrying an extra top-level field (hashed content untouched)", () => {
    const plan = writePlan(ACCT, "fav.add", genericBody());
    // Extra key is NOT part of the hashed core, so integrity alone would pass it.
    tamperStored((raw) => {
      raw.injected = "surprise";
    });
    expect(() => loadPlan(plan.planId, ACCT, "fav.add")).toThrow(PlanStaleError);
  });
});

describe("confirm — strict single-domain shape", () => {
  it("writePlan rejects a mixed body (snapshot + payload)", () => {
    expect(() =>
      writePlan(ACCT, "cart.clear", {
        snapshot: snapshot(),
        payload: { x: 1 },
      } as PlanBody)
    ).toThrow(PlanStaleError);
  });

  it("writePlan rejects an incomplete cart body (snapshot without mutation)", () => {
    expect(() => writePlan(ACCT, "cart.clear", { snapshot: snapshot() } as PlanBody)).toThrow(
      PlanStaleError
    );
  });

  it("writePlan rejects an incomplete generic body (payload without preconditions)", () => {
    expect(() => writePlan(ACCT, "fav.add", { payload: { x: 1 } } as PlanBody)).toThrow(
      PlanStaleError
    );
  });

  it("writePlan rejects an unknown extra body key", () => {
    expect(() =>
      writePlan(ACCT, "fav.add", {
        payload: {},
        preconditions: {},
        extra: 1,
      } as unknown as PlanBody)
    ).toThrow(PlanStaleError);
  });

  it("writePlan rejects a null/array domain value", () => {
    expect(() =>
      writePlan(ACCT, "fav.add", { payload: null, preconditions: {} } as unknown as PlanBody)
    ).toThrow(PlanStaleError);
    expect(() =>
      writePlan(ACCT, "fav.add", { payload: [], preconditions: {} } as unknown as PlanBody)
    ).toThrow(PlanStaleError);
  });

  it("loadPlan rejects a stored plan that mixes both domain shapes", () => {
    const plan = writePlan(ACCT, "cart.clear", cartBody());
    tamperStored((raw) => {
      raw.payload = { x: 1 };
      raw.preconditions = { y: 2 };
    });
    expect(() => loadPlan(plan.planId, ACCT, "cart.clear")).toThrow(PlanStaleError);
  });

  it("loadPlan rejects a stored cart plan missing its mutation", () => {
    const plan = writePlan(ACCT, "cart.clear", cartBody());
    tamperStored((raw) => {
      delete raw.mutation;
    });
    expect(() => loadPlan(plan.planId, ACCT, "cart.clear")).toThrow(PlanStaleError);
  });
});

describe("confirm — operation ⇄ payload domain binding", () => {
  it("writePlan rejects a cart operation carrying a generic payload", () => {
    expect(() => writePlan(ACCT, "cart.clear", genericBody())).toThrow(PlanStaleError);
  });

  it("writePlan rejects a generic operation carrying a cart payload", () => {
    expect(() => writePlan(ACCT, "fav.add", cartBody())).toThrow(PlanStaleError);
  });

  it("loadPlan rejects a generic-shaped artifact stamped with a cart operation", () => {
    const now = Date.now();
    const planId = forgePlan({
      schemaVersion: PLAN_SCHEMA_VERSION,
      canon: PLAN_CANON,
      account: ACCT,
      operation: "cart.add",
      payload: { productId: "p" },
      preconditions: { wasFavourite: false },
      createdAt: now,
      expiresAt: now + 1000,
    });
    expect(() => loadPlan(planId, ACCT, "cart.add")).toThrow(PlanStaleError);
  });
});

describe("confirm — expected operation binding", () => {
  it("rejects a plan consumed under the wrong operation", () => {
    const plan = writePlan(ACCT, "fav.add", genericBody());
    expect(() => loadPlan(plan.planId, ACCT, "fav.remove")).toThrow(PlanStaleError);
  });

  it("accepts a plan under its own operation", () => {
    const plan = writePlan(ACCT, "fav.add", genericBody());
    expect(loadPlan(plan.planId, ACCT, "fav.add").planId).toBe(plan.planId);
  });
});

describe("confirm — caller-bounded expiry", () => {
  it("honours a shorter caller-supplied max-age", () => {
    const plan = writePlan(ACCT, "fav.add", genericBody("short"), { maxAgeMs: 60_000 });
    expect(plan.expiresAt - plan.createdAt).toBe(60_000);
  });

  it("clamps a max-age longer than the TTL down to the TTL ceiling", () => {
    const plan = writePlan(ACCT, "fav.add", genericBody("long"), { maxAgeMs: PLAN_TTL_MS * 100 });
    expect(plan.expiresAt - plan.createdAt).toBe(PLAN_TTL_MS);
  });

  it("rejects a non-positive or non-finite max-age", () => {
    expect(() => writePlan(ACCT, "fav.add", genericBody("zero"), { maxAgeMs: 0 })).toThrow(
      PlanStaleError
    );
    expect(() =>
      writePlan(ACCT, "fav.add", genericBody("nan"), { maxAgeMs: Number.NaN })
    ).toThrow(PlanStaleError);
  });
});

describe("confirm — timestamp ordering/bounds", () => {
  it("rejects createdAt > expiresAt (both in the future, so not merely 'expired')", () => {
    const now = Date.now();
    const planId = forgePlan({
      schemaVersion: PLAN_SCHEMA_VERSION,
      canon: PLAN_CANON,
      account: ACCT,
      operation: "fav.add",
      payload: { productId: "p" },
      preconditions: { wasFavourite: false },
      createdAt: now + 10_000,
      expiresAt: now + 5_000,
    });
    expect(() => loadPlan(planId, ACCT, "fav.add")).toThrow(PlanStaleError);
  });

  it("rejects a future-dated plan that would otherwise outlive the TTL", () => {
    const future = Date.now() + 24 * 60 * 60 * 1000;
    const planId = forgePlan({
      schemaVersion: PLAN_SCHEMA_VERSION,
      canon: PLAN_CANON,
      account: ACCT,
      operation: "fav.add",
      payload: { productId: "p" },
      preconditions: { wasFavourite: false },
      createdAt: future,
      expiresAt: future + 60_000,
    });
    expect(() => loadPlan(planId, ACCT, "fav.add")).toThrow(PlanStaleError);
  });

  it("rejects a window wider than the TTL ceiling", () => {
    const now = Date.now();
    const planId = forgePlan({
      schemaVersion: PLAN_SCHEMA_VERSION,
      canon: PLAN_CANON,
      account: ACCT,
      operation: "fav.add",
      payload: { productId: "p" },
      preconditions: { wasFavourite: false },
      createdAt: now,
      expiresAt: now + PLAN_TTL_MS + 60_000,
    });
    expect(() => loadPlan(planId, ACCT, "fav.add")).toThrow(PlanStaleError);
  });
});
