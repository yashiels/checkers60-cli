import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
      async getSession() {
        return {
          sessionToken: "session-tok",
          userId: "user-id",
          uuid: "shoprite-uuid",
          mobile: "+27000000000",
          customerId: "000C3V55",
        };
      }
    },
  };
});

import {
  getCartSavings,
  isDealActive,
  mapCartDeal,
  mapCartSavings,
  SAVINGS_EMPTY_CART_MESSAGE,
} from "../lib/orders.js";
import { normalizeBonusBuy } from "../lib/promotions.js";
import { mapCatalogProduct, type RawCatalogProduct } from "../lib/api.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import { savings as savingsCommand } from "../commands/savings.js";

const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;

// ── Synthetic poison payload (distinct, never a legit allowlisted value) ──
const POISON = {
  driverName: "POISON_DRIVER_NAME",
  driverPhone: "POISON_PHONE_0821112222",
  location: { lat: 12.345678, lng: 98.765432 },
  address: { unit: "POISON_UNIT_42", street: "POISON_STREET", fullAddress: "POISON_FULL_ADDRESS" },
  paymentToken: "POISON_PAYTOKEN",
  maskedCardNumber: "POISON_CARD_4111",
  xtraSavingsAccessToken: "POISON_XS_ACCESS",
  xtraSavingsIdToken: "POISON_XS_ID",
  email: "POISON_EMAIL@example.com",
  signedUrl: "https://poison.example/x.jpg?token=POISON_SIGNED_TOKEN",
  arbitraryUnknown: "POISON_UNKNOWN",
};

const FORBIDDEN = [
  "POISON_DRIVER_NAME",
  "POISON_PHONE_0821112222",
  "POISON_UNIT_42",
  "POISON_STREET",
  "POISON_FULL_ADDRESS",
  "POISON_PAYTOKEN",
  "POISON_CARD_4111",
  "POISON_XS_ACCESS",
  "POISON_XS_ID",
  "POISON_EMAIL@example.com",
  "POISON_SIGNED_TOKEN",
  "POISON_UNKNOWN",
  "12.345678",
  "98.765432",
  "poison.example",
];

function assertClean(dto: unknown): void {
  const serialized = JSON.stringify(dto);
  for (const bad of FORBIDDEN) expect(serialized).not.toContain(bad);
}

function expectKeys(dto: object, keys: string[]): void {
  expect(Object.keys(dto).sort()).toEqual([...keys].sort());
}

/**
 * No fabricated threshold/progress/per-deal-saving field or "N of N" text
 * escapes. (The top-level `cartSavings` is a VERBATIM server figure, not a
 * fabrication, so it is intentionally not forbidden here.)
 */
function assertNoFabrication(dto: unknown): void {
  const s = JSON.stringify(dto);
  for (const forbidden of [
    "discountValue",
    "requiredQuantity",
    "threshold",
    "progress",
    "savedAmount",
    "dealSavings",
    "itemsToAdd",
    "nShort",
    "balanceAmount",
  ]) {
    expect(s).not.toContain(forbidden);
  }
  expect(s).not.toMatch(/\b\d+\s*of\s*\d+\b/i);
}

// ── Synthetic deals + products (ids PROD-*/ART-*/DEAL-*, ts 17e8) ─────────
const FAR_FUTURE = 4102444800000; // 2100
const IN_WINDOW = 1735000000000; // late 2024

function rawDeal(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "DEAL-X",
    active: true,
    name: "Buy 2 & Save 20%",
    shortDescription: "Buy 2 & Save 20%",
    longDescription: "Buy Any 2 Selected Widgets And Save 20%",
    discountType: { code: "other" },
    discountValue: 0,
    memberType: { code: "fox_members" },
    offerType: { code: "untranslated" },
    startDate: 1700000000000,
    endDate: FAR_FUTURE,
    products: ["ART-0001", "ART-0002", "ART-0003"],
    productIds: ["PROD-0001", "PROD-0002", "PROD-0003"],
    channelSpecificPromotions: { sixty60: true },
    channelIndicator: "Store and Online",
    ...POISON,
    ...over,
  };
}

const BONUS_BUYS: Record<string, Record<string, unknown>> = {
  // Touched by the cart via bonusBuyIds + memberProductIds.
  "DEAL-0001": rawDeal({ id: "DEAL-0001" }),
  // Touched ONLY via article number. The deal lists a unit-suffixed article
  // ("10139271EA") while the product's articleNumber is the bare core.
  "DEAL-0002": rawDeal({
    id: "DEAL-0002",
    name: "Buy 3 & Save 15%",
    longDescription: "Buy Any 3 Selected Gadgets And Save 15%",
    products: ["10139271EA", "ART-9992"],
    productIds: ["PROD-9991", "PROD-9992"],
  }),
  // In the cart's member set but the window has closed → inactive.
  "DEAL-0003": rawDeal({ id: "DEAL-0003", endDate: 1600000000000, productIds: ["PROD-0001"] }),
  // In the member set but explicitly off the sixty60 channel → excluded.
  "DEAL-0004": rawDeal({
    id: "DEAL-0004",
    productIds: ["PROD-0001"],
    channelSpecificPromotions: { sixty60: false },
  }),
};

/** Catalog product rows keyed by id, each poisoned. */
const PRODUCTS: Record<string, Record<string, unknown>> = {
  "PROD-0001": {
    id: "PROD-0001",
    name: "Widget A",
    priceWithoutDecimal: 4999,
    articleNumber: "ART-0001",
    bonusBuyIds: ["DEAL-0001", "DEAL-0003", "DEAL-0004"],
    ...POISON,
  },
  "PROD-CART-2": {
    id: "PROD-CART-2",
    name: "Gadget Z",
    priceWithoutDecimal: 2599,
    articleNumber: "10139271",
    bonusBuyIds: [],
    ...POISON,
  },
};

const ok = (data: unknown) =>
  Promise.resolve({ status: 200, headers: new Headers(), data });

/** A populated cart with two poisoned line items. */
function cartResponse() {
  return ok({
    carts: [
      {
        item: {
          id: "cart-1",
          cartVersion: 3,
          serviceOptionId: "sixty-min-delivery",
          lineItems: [
            { id: "li-1", productId: "PROD-0001", quantity: 2, price: 4999, storeId: "s1", ...POISON },
            { id: "li-2", productId: "PROD-CART-2", quantity: 1, price: 2599, storeId: "s1", ...POISON },
          ],
          cartSavings: { productSavings: 1500, discountCodesSavings: 0, totalSavings: 1500 },
          ...POISON,
        },
      },
    ],
    ...POISON,
  });
}

function router(...args: unknown[]) {
  const url = String(args[1] ?? "");
  const opts = (args[2] ?? {}) as {
    json?: { filter?: { productListSource?: { productIds?: string[] } } };
  };
  if (url.includes("/carts/user")) return cartResponse();
  if (url.includes("/products/filter")) {
    const ids = opts.json?.filter?.productListSource?.productIds ?? [];
    return ok({
      products: ids.map((id) => PRODUCTS[id] ?? { id, name: `Product ${id}`, ...POISON }),
      bonusBuys: BONUS_BUYS,
      ...POISON,
    });
  }
  return ok({});
}

let emptyCart = false;
function maybeEmptyRouter(...args: unknown[]) {
  const url = String(args[1] ?? "");
  if (emptyCart && url.includes("/carts/user")) return ok({ carts: [] });
  return router(...args);
}

beforeEach(async () => {
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  resetRuntimeForTests();
  await initRuntime();
  emptyCart = false;
  requestMock.mockReset();
  requestMock.mockImplementation(maybeEmptyRouter);
});

afterEach(() => {
  if (origEnvDeviceId === undefined) delete process.env.CHECKERS60_DEVICE_ID;
  else process.env.CHECKERS60_DEVICE_ID = origEnvDeviceId;
  resetRuntimeForTests();
  vi.restoreAllMocks();
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
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

const SAVINGS_KEYS = ["cartItemCount", "cartSavings", "deals", "message"];
const CART_SAVINGS_KEYS = ["productSavings", "discountCodesSavings", "totalSavings"];
const DEAL_KEYS = [
  "dealId",
  "title",
  "terms",
  "validUntil",
  "membersOnly",
  "qualifyingItemsInCart",
  "eligibleOptionProductIds",
];
const ITEM_KEYS = ["productId", "name", "quantity"];

// ── isDealActive ─────────────────────────────────────────────────────────
describe("isDealActive", () => {
  const base = normalizeBonusBuy(rawDeal({ id: "D" }) as never);

  it("live inside the window on sixty60", () => {
    expect(isDealActive(base, IN_WINDOW)).toBe(true);
  });
  it("excludes a closed window", () => {
    const d = normalizeBonusBuy(rawDeal({ id: "D", endDate: 1600000000000 }) as never);
    expect(isDealActive(d, IN_WINDOW)).toBe(false);
  });
  it("excludes a not-yet-started deal", () => {
    const d = normalizeBonusBuy(rawDeal({ id: "D", startDate: FAR_FUTURE }) as never);
    expect(isDealActive(d, IN_WINDOW)).toBe(false);
  });
  it("excludes an explicitly inactive deal", () => {
    const d = normalizeBonusBuy(rawDeal({ id: "D", active: false }) as never);
    expect(isDealActive(d, IN_WINDOW)).toBe(false);
  });
  it("excludes a deal with NO active flag (requires an explicit active:true)", () => {
    const d = normalizeBonusBuy(rawDeal({ id: "D", active: undefined }) as never);
    expect(d.active).toBe(false);
    expect(isDealActive(d, IN_WINDOW)).toBe(false);
  });
  it("excludes a deal off the sixty60 channel", () => {
    const d = normalizeBonusBuy(
      rawDeal({ id: "D", channelSpecificPromotions: { sixty60: false } }) as never
    );
    expect(isDealActive(d, IN_WINDOW)).toBe(false);
  });
  it("excludes a deal with NO sixty60 signal (requires a positive indication)", () => {
    const d = normalizeBonusBuy(
      rawDeal({ id: "D", channelSpecificPromotions: { instore: true } }) as never
    );
    expect(d.availableOnSixty60).toBe(false);
    expect(isDealActive(d, IN_WINDOW)).toBe(false);
  });
  it("admits a deal whose sixty60 signal is an override object", () => {
    const d = normalizeBonusBuy(
      rawDeal({ id: "D", channelSpecificPromotions: { sixty60: { endDate: FAR_FUTURE } } }) as never
    );
    expect(d.availableOnSixty60).toBe(true);
    expect(isDealActive(d, IN_WINDOW)).toBe(true);
  });
  it("is inclusive at the exact start and end boundaries", () => {
    const d = normalizeBonusBuy(rawDeal({ id: "D", startDate: 1000, endDate: 2000 }) as never);
    expect(isDealActive(d, 1000)).toBe(true);
    expect(isDealActive(d, 2000)).toBe(true);
    expect(isDealActive(d, 999)).toBe(false);
    expect(isDealActive(d, 2001)).toBe(false);
  });
  it("EXCLUDES a deal whose present date bound is malformed (fails closed)", () => {
    const badStart = normalizeBonusBuy(rawDeal({ id: "D", startDate: "soon" }) as never);
    expect(badStart.startDate).toBeNull();
    expect(isDealActive(badStart, IN_WINDOW)).toBe(false);

    const nanEnd = normalizeBonusBuy(rawDeal({ id: "D", endDate: Number.NaN }) as never);
    expect(nanEnd.endDate).toBeNull();
    expect(isDealActive(nanEnd, IN_WINDOW)).toBe(false);
  });
  it("EXCLUDES a deal with an explicit null date bound (fails closed, not unbounded)", () => {
    const nullStart = normalizeBonusBuy(rawDeal({ id: "D", startDate: null }) as never);
    expect(nullStart.startDate).toBeNull();
    expect(isDealActive(nullStart, IN_WINDOW)).toBe(false);

    const nullEnd = normalizeBonusBuy(rawDeal({ id: "D", endDate: null }) as never);
    expect(nullEnd.endDate).toBeNull();
    expect(isDealActive(nullEnd, IN_WINDOW)).toBe(false);
  });
  it("EXCLUDES a deal when a sixty60 override nulls out a valid expiry", () => {
    const d = normalizeBonusBuy(
      rawDeal({ id: "D", channelSpecificPromotions: { sixty60: { endDate: null } } }) as never
    );
    expect(d.availableOnSixty60).toBe(true);
    expect(d.endDate).toBeNull();
    expect(isDealActive(d, IN_WINDOW)).toBe(false);
  });
  it("treats a truly ABSENT date bound (undefined) as unbounded on that side", () => {
    const d = normalizeBonusBuy(
      rawDeal({ id: "D", startDate: undefined, endDate: undefined }) as never
    );
    expect(d.startDate).toBeUndefined();
    expect(d.endDate).toBeUndefined();
    expect(isDealActive(d, IN_WINDOW)).toBe(true);
  });
});

// ── article-number source is the verified field only (no barcode/sku alias) ──
describe("pickArticleNumber (via mapCatalogProduct) ignores barcode/sku aliases", () => {
  it("reads the articleNumber field", () => {
    const p = mapCatalogProduct({ id: "x", name: "A", articleNumber: "10139271" } as RawCatalogProduct);
    expect(p.articleNumber).toBe("10139271");
  });
  it("does NOT treat barcode/sku/code as an article number", () => {
    const p = mapCatalogProduct({
      id: "x",
      name: "A",
      barcodes: ["10139271"],
      barcode: "10139271",
      sku: "10139271",
      code: "10139271",
    } as never);
    expect(p.articleNumber).toBeUndefined();
  });
});

// ── mapCartDeal ──────────────────────────────────────────────────────────
describe("mapCartDeal", () => {
  const deal = normalizeBonusBuy(rawDeal({ id: "DEAL-0001" }) as never);

  it("aggregates by product, de-dupes eligible options, drops PII", () => {
    const dto = mapCartDeal(
      deal,
      [
        { id: "l1", productId: "PROD-0001", quantity: 2, price: 4999 } as never,
        { id: "l2", productId: "PROD-0001", quantity: 1, price: 4999 } as never,
      ],
      new Map([["PROD-0001", "Widget A"]])
    );
    assertClean(dto);
    expectKeys(dto, DEAL_KEYS);
    dto.qualifyingItemsInCart.forEach((i) => expectKeys(i, ITEM_KEYS));
    // Two lines of the same product aggregate into one, quantities summed.
    expect(dto.qualifyingItemsInCart).toEqual([
      { productId: "PROD-0001", name: "Widget A", quantity: 3 },
    ]);
    // In-cart product removed from eligible options; the rest survive, in order.
    expect(dto.eligibleOptionProductIds).toEqual(["PROD-0002", "PROD-0003"]);
    // Human terms carry the buy-quantity/saving; no numeric field is fabricated.
    expect(dto.terms).toContain("Save 20%");
    assertNoFabrication(dto);
  });
});

// ── mapCartSavings (verbatim server figure, never computed) ──────────────
describe("mapCartSavings", () => {
  it("copies integer-cent savings verbatim", () => {
    const dto = mapCartSavings({ productSavings: 1500, discountCodesSavings: 0, totalSavings: 1500 });
    expect(dto).toEqual({ productSavings: 1500, discountCodesSavings: 0, totalSavings: 1500 });
    expectKeys(dto!, CART_SAVINGS_KEYS);
  });
  it("reports a non-integer/absent field as null, never fabricated", () => {
    const dto = mapCartSavings({ productSavings: 12.5, totalSavings: 1500 } as never);
    expect(dto).toEqual({ productSavings: null, discountCodesSavings: null, totalSavings: 1500 });
  });
  it("returns null when nothing usable is present", () => {
    expect(mapCartSavings(undefined)).toBeNull();
    expect(mapCartSavings({})).toBeNull();
  });
});

// ── getCartSavings orchestration ─────────────────────────────────────────
describe("getCartSavings", () => {
  it("surfaces only active, cart-touched deals with clean allowlisted keys", async () => {
    const dto = await getCartSavings(undefined, IN_WINDOW);
    assertClean(dto);
    assertNoFabrication(dto);
    expectKeys(dto, SAVINGS_KEYS);
    expect(dto.cartItemCount).toBe(2);
    expect(dto.message).toBeNull();
    // Verbatim server cart savings — copied, not computed.
    expect(dto.cartSavings).toEqual({ productSavings: 1500, discountCodesSavings: 0, totalSavings: 1500 });

    const ids = dto.deals.map((d) => d.dealId).sort();
    // DEAL-0001 (bonusBuyIds/member match) + DEAL-0002 (article match);
    // DEAL-0003 (closed) and DEAL-0004 (off-channel) are excluded.
    expect(ids).toEqual(["DEAL-0001", "DEAL-0002"]);

    dto.deals.forEach((d) => {
      expectKeys(d, DEAL_KEYS);
      d.qualifyingItemsInCart.forEach((i) => expectKeys(i, ITEM_KEYS));
    });
  });

  it("matches a deal via article number alone (no productId/bonusBuyId match)", async () => {
    const dto = await getCartSavings(undefined, IN_WINDOW);
    const byArticle = dto.deals.find((d) => d.dealId === "DEAL-0002");
    expect(byArticle).toBeTruthy();
    expect(byArticle!.qualifyingItemsInCart.map((i) => i.productId)).toEqual(["PROD-CART-2"]);
  });

  it("empty cart → guidance message, no deals, no product lookup", async () => {
    emptyCart = true;
    const dto = await getCartSavings(undefined, IN_WINDOW);
    expectKeys(dto, SAVINGS_KEYS);
    expect(dto).toEqual({ cartItemCount: 0, cartSavings: null, deals: [], message: SAVINGS_EMPTY_CART_MESSAGE });
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.includes("/products/filter"))).toBe(false);
  });

  it("is read-only: only cart-read + catalog filter, no order/cart write", async () => {
    await getCartSavings(undefined, IN_WINDOW);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(
      urls.every((u) => u.includes("/carts/user") || u.includes("/products/filter"))
    ).toBe(true);
  });
});

// ── command --json end-to-end (poisoned envelopes) ───────────────────────
describe("savings command --json is clean end-to-end", () => {
  it("emits a DTO-shaped, poison-free SavingsDTO", async () => {
    const out = await captureStdout(() => savingsCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    assertNoFabrication(parsed);
    expectKeys(parsed, SAVINGS_KEYS);
    expect(parsed.deals.length).toBeGreaterThan(0);
    parsed.deals.forEach((d: object) => {
      expectKeys(d, DEAL_KEYS);
      (d as { qualifyingItemsInCart: object[] }).qualifyingItemsInCart.forEach((i) =>
        expectKeys(i, ITEM_KEYS)
      );
    });
  });

  it("empty cart --json emits the guidance message", async () => {
    emptyCart = true;
    const out = await captureStdout(() => savingsCommand({ json: true }));
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ cartItemCount: 0, cartSavings: null, deals: [], message: SAVINGS_EMPTY_CART_MESSAGE });
  });
});
