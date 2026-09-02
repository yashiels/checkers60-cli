import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "search-promotions.json"), "utf8")
);

// ── request mock (branch by URL) ─────────────────────────────────────────
const requestMock = vi.fn();
vi.mock("../lib/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/http.js")>();
  return { ...actual, request: (...args: unknown[]) => requestMock(...args) };
});

// A logged-in TokenManager, so command-level tests don't hit the creds store.
vi.mock("../lib/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/credentials.js")>();
  return {
    ...actual,
    TokenManager: class {
      async getUserToken(): Promise<string> {
        return "user-tok";
      }
    },
  };
});

import { normalizeBonusBuy, normalizeBonusBuys } from "../lib/promotions.js";
import { CheckersAPI } from "../lib/api.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import { deals as dealsCommand } from "../commands/deals.js";
import { show as showCommand } from "../commands/show.js";
import { cart as cartCommand } from "../commands/cart.js";

const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;

// A fixture product that qualifies for a deal (bonusBuyIds populated).
const MEMBER_PRODUCT = fixture.products[0];
const MEMBER_DEAL_ID: string = MEMBER_PRODUCT.bonusBuyIds[0];

/** Route a mocked catalog/orders request to the right canned response. */
function routeRequest(...args: unknown[]) {
  const url = String(args[1] ?? "");
  if (url.includes("/carts/user")) {
    return Promise.resolve({
      status: 200,
      headers: new Headers(),
      data: {
        carts: [
          {
            item: {
              id: "cart-1",
              cartVersion: 3,
              serviceOptionId: "sixty-min-delivery",
              lineItems: [
                {
                  id: "li-1",
                  productId: MEMBER_PRODUCT.id,
                  quantity: 1,
                  price: MEMBER_PRODUCT.priceWithoutDecimal,
                  storeId: MEMBER_PRODUCT.storeId,
                },
              ],
            },
          },
        ],
      },
    });
  }
  // Any products/filter call (search or product-id lookup) → the fixture.
  return Promise.resolve({ status: 200, headers: new Headers(), data: fixture });
}

beforeEach(async () => {
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  resetRuntimeForTests();
  await initRuntime();
  requestMock.mockReset();
  requestMock.mockImplementation(routeRequest);
});

afterEach(() => {
  if (origEnvDeviceId === undefined) delete process.env.CHECKERS60_DEVICE_ID;
  else process.env.CHECKERS60_DEVICE_ID = origEnvDeviceId;
  resetRuntimeForTests();
  vi.restoreAllMocks();
});

/** Capture everything written to stdout during `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

// ── normalizeBonusBuy ────────────────────────────────────────────────────
describe("normalizeBonusBuy", () => {
  it("maps a real deal without fabricating a numeric threshold", () => {
    const raw = fixture.bonusBuys[MEMBER_DEAL_ID];
    const deal = normalizeBonusBuy(raw);

    expect(deal.id).toBe(MEMBER_DEAL_ID);
    expect(deal.title).toBe(raw.name);
    expect(deal.description).toBe(raw.longDescription);
    expect(deal.membersOnly).toBe(true); // memberType.code === "fox_members"
    expect(deal.discountTypeCode).toBe("other");
    expect(deal.offerTypeCode).toBe(raw.offerType.code);
    expect(deal.validUntil).toBe(new Date(raw.endDate).toISOString());
    expect(deal.memberProductIds).toEqual(raw.productIds);
    expect(deal.memberProductIds.length).toBeGreaterThan(0);
    expect(deal.memberArticleNumbers).toEqual(raw.products);

    // No invented buy-N threshold / progress unit anywhere on the object.
    expect(deal).not.toHaveProperty("requiredQuantity");
    expect(deal).not.toHaveProperty("countingUnit");
    expect(deal).not.toHaveProperty("threshold");
  });

  it("normalizes the whole bonusBuys map", () => {
    const all = normalizeBonusBuys(fixture.bonusBuys);
    expect(all).toHaveLength(Object.keys(fixture.bonusBuys).length);
    expect(all.every((d) => typeof d.id === "string")).toBe(true);
  });

  it("returns [] for a missing map", () => {
    expect(normalizeBonusBuys(undefined)).toEqual([]);
    expect(normalizeBonusBuys(null)).toEqual([]);
  });
});

// ── searchProducts surfaces deals + keeps bonusBuyIds ────────────────────
describe("CheckersAPI.searchProducts", () => {
  it("surfaces normalized deals and preserves product bonusBuyIds", async () => {
    const api = new CheckersAPI();
    const res = await api.searchProducts("flowers");

    expect(res.deals).toHaveLength(Object.keys(fixture.bonusBuys).length);
    expect(res.deals[0]).toHaveProperty("title");

    const member = res.products.find((p) => p.id === MEMBER_PRODUCT.id);
    expect(member?.bonusBuyIds).toEqual(MEMBER_PRODUCT.bonusBuyIds);
  });
});

describe("CheckersAPI.getDeals", () => {
  it("sends a dealsOnly filter and returns normalized deals", async () => {
    const api = new CheckersAPI();
    const res = await api.getDeals("flowers");
    expect(res.deals.length).toBeGreaterThan(0);

    const body = requestMock.mock.calls[0]?.[2] as {
      json?: { filter?: { filterOptions?: { dealsOnly?: boolean } } };
    };
    expect(body.json?.filter?.filterOptions?.dealsOnly).toBe(true);
  });
});

// ── deals command json shape ─────────────────────────────────────────────
describe("deals command", () => {
  it("--json emits a normalized BonusBuy[]", async () => {
    const out = await captureStdout(() => dealsCommand("flowers", { json: true }));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(Object.keys(fixture.bonusBuys).length);
    expect(parsed[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      membersOnly: expect.any(Boolean),
    });
  });
});

// ── show command json shape ──────────────────────────────────────────────
describe("show command", () => {
  it("--json returns { product, deals } with the product's own deals resolved", async () => {
    const out = await captureStdout(() => showCommand(MEMBER_PRODUCT.id, { json: true }));
    const parsed = JSON.parse(out);
    expect(parsed.product.id).toBe(MEMBER_PRODUCT.id);
    expect(Array.isArray(parsed.deals)).toBe(true);
    expect(parsed.deals.map((d: { id: string }) => d.id)).toContain(MEMBER_DEAL_ID);
  });
});

// ── cart --deals: membership only, NO fabricated count ───────────────────
describe("cart --deals", () => {
  it("lists deal membership for a qualifying cart item and emits no 'X of N'", async () => {
    const out = await captureStdout(() => cartCommand({ json: true, deals: true }));
    const parsed = JSON.parse(out);

    expect(Array.isArray(parsed.deals)).toBe(true);
    const deal = parsed.deals.find((d: { id: string }) => d.id === MEMBER_DEAL_ID);
    expect(deal).toBeTruthy();
    expect(deal.items.map((i: { productId: string }) => i.productId)).toContain(
      MEMBER_PRODUCT.id
    );
    // Membership only — never a fabricated numeric threshold / progress.
    expect(deal).not.toHaveProperty("requiredQuantity");
    expect(deal).not.toHaveProperty("progress");
    expect(JSON.stringify(parsed.deals)).not.toMatch(/\b\d+\s*of\s*\d+\b/i);
  });
});

// ── Oracle final-review regressions ──────────────────────────────────────
describe("deal lookup failure is surfaced, not silently empty", () => {
  it("cart --deals reports deals unavailable on a lookup error", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/products/filter")) {
        return Promise.reject(new Error("network down"));
      }
      return routeRequest(...args);
    });
    const out = await captureStdout(() =>
      cartCommand({ json: true, deals: true })
    );
    const parsed = JSON.parse(out);
    // The lookup failed → deals must be empty AND dealsError set (not a false "no deals").
    expect(parsed.deals).toEqual([]);
    expect(parsed.dealsError).toBeTruthy();
    expect(String(parsed.dealsError)).not.toMatch(/\{|\}|success/); // sanitized, no payload
  });
});

describe("getProductDetail does not return an unrelated product", () => {
  it("returns raw undefined when the requested id is absent", async () => {
    // Fixture never contains this id; response has other products.
    const api = new CheckersAPI();
    const { raw, deals } = await api.getProductDetail("nonexistent-id-xyz");
    expect(raw).toBeUndefined();
    expect(deals).toEqual([]);
  });
});
