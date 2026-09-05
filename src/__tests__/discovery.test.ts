import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string) =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

const offersFixture = loadFixture("api-offers-for-you.json");
const promotionsFixture = loadFixture("api-promotions-for-you.json");
const filterOptionsFixture = loadFixture("api-filter-options.json");

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
  mapOfferProduct,
  mapCategory,
  getOffers,
  getDiscover,
  getCategories,
} from "../lib/discovery.js";
import { CheckersAPI } from "../lib/api.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import { offers as offersCommand } from "../commands/offers.js";
import { discover as discoverCommand } from "../commands/discover.js";
import { categories as categoriesCommand } from "../commands/categories.js";

const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;

// ── Synthetic "poison" payload (same discipline as domains.test.ts) ───────
const POISON = {
  driver: { name: "POISON_DRIVER_NAME", phone: "POISON_PHONE_0821112222" },
  driverName: "POISON_DRIVER_NAME",
  address: { unit: "POISON_UNIT_42", street: "POISON_STREET", suburb: "POISON_SUBURB" },
  unit: "POISON_UNIT_42",
  street: "POISON_STREET",
  suburb: "POISON_SUBURB",
  deliveryNotes: "POISON_NOTES",
  latitude: 12.345678,
  longitude: 98.765432,
  payment: { token: "POISON_PAYTOKEN", maskedCardNumber: "POISON_CARD_4111" },
  paymentToken: "POISON_PAYTOKEN",
  maskedCardNumber: "POISON_CARD_4111",
  loyalty: { xtraSavingsId: "POISON_SAID" },
  saIdNumber: "POISON_SAID",
  idNumber: "POISON_SAID",
  cardNumber: "POISON_CARD_9710",
  email: "POISON_EMAIL@example.com",
  firstName: "POISON_FIRST",
  lastName: "POISON_LAST",
  birthDate: "POISON_BIRTH",
  mobileNumber: "POISON_MOBILE",
  signedUrl: "https://poison.example/x.jpg?token=POISON_SIGNED_TOKEN",
  arbitraryUnknown: "POISON_UNKNOWN",
};

const FORBIDDEN = [
  "POISON_DRIVER_NAME",
  "POISON_PHONE_0821112222",
  "POISON_UNIT_42",
  "POISON_STREET",
  "POISON_SUBURB",
  "POISON_NOTES",
  "POISON_PAYTOKEN",
  "POISON_CARD_4111",
  "POISON_CARD_9710",
  "POISON_SAID",
  "POISON_EMAIL@example.com",
  "POISON_FIRST",
  "POISON_LAST",
  "POISON_BIRTH",
  "POISON_MOBILE",
  "POISON_SIGNED_TOKEN",
  "POISON_UNKNOWN",
  "12.345678",
  "98.765432",
  "poison.example",
];

/** Assert no poison value survives into a serialized DTO. */
function assertClean(dto: unknown): void {
  const serialized = JSON.stringify(dto);
  for (const bad of FORBIDDEN) {
    expect(serialized).not.toContain(bad);
  }
}

/** Assert the DTO's own keys are EXACTLY the allowlist (no leaked props). */
function expectKeys(dto: object, keys: string[]): void {
  expect(Object.keys(dto).sort()).toEqual([...keys].sort());
}

// ── request router (branch by URL) ───────────────────────────────────────
const ok = (data: unknown) =>
  Promise.resolve({ status: 200, headers: new Headers(), data });

// Overridable per-test: the profile the account resolves to (loyalty membership).
let profileResponse: unknown = {
  response: { user: { loyaltyCards: { cards: [{ active: true, theme: "Checkers" }] } } },
};

function routeRequest(...args: unknown[]) {
  const url = String(args[1] ?? "");
  if (url.includes("/products/offers-for-you")) return ok(offersFixture);
  if (url.includes("/promotions/forYou")) return ok(promotionsFixture);
  if (url.includes("/products/filter/options")) return ok(filterOptionsFixture);
  if (url.includes("/dsl/") && url.endsWith("/users")) return ok(profileResponse);
  return ok({});
}

// ── POISON router: saturate every discovery envelope with nested PII ──────
function poisonRouter(...args: unknown[]) {
  const url = String(args[1] ?? "");
  if (url.includes("/products/offers-for-you")) {
    return ok({
      promotions: {
        "PROMO-P1": {
          id: "PROMO-P1",
          name: "Poisoned Offer",
          longDescription: "Buy 2 & Save",
          memberType: { code: "fox_members" },
          discountType: { code: "other" },
          endDate: 1700000000000,
          products: ["ART-P1"],
          productIds: ["PROD-P1"],
          ...POISON,
        },
      },
      ...POISON,
    });
  }
  if (url.includes("/promotions/forYou")) {
    return ok({
      bonusBuys: [
        {
          id: "PROMO-P2",
          name: "Poisoned Promo",
          longDescription: "Save more",
          memberType: { code: "all" },
          discountType: { code: "other" },
          endDate: 1700000000000,
          products: ["ART-P2"],
          productIds: ["PROD-P2"],
          ...POISON,
        },
      ],
      items: [
        {
          id: "PROD-P2",
          name: "Poisoned Product",
          priceWithoutDecimal: 1999,
          imageId: "IMG-P2",
          bonusBuyIds: ["PROMO-P2"],
          ...POISON,
        },
      ],
      ...POISON,
    });
  }
  if (url.includes("/products/filter/options")) {
    return ok({
      success: true,
      filterOptions: {
        departmentOptions: [
          { displayCategoryId: "CAT-P1", name: "Poisoned Dept", count: 5, ...POISON },
        ],
        ...POISON,
      },
      ...POISON,
    });
  }
  if (url.includes("/dsl/") && url.endsWith("/users")) {
    return ok({
      response: {
        user: {
          loyaltyCards: { cards: [{ active: true, theme: "Checkers", ...POISON }] },
          ...POISON,
        },
      },
      ...POISON,
    });
  }
  return ok({});
}

beforeEach(async () => {
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  resetRuntimeForTests();
  await initRuntime();
  profileResponse = {
    response: { user: { loyaltyCards: { cards: [{ active: true, theme: "Checkers" }] } } },
  };
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

// ════════════════════════════════════════════════════════════════════════
// Mapper poison tests — prove redaction at each discovery mapper
// ════════════════════════════════════════════════════════════════════════
describe("discovery mappers redact all PII/secrets (synthetic poison inputs)", () => {
  it("mapOfferProduct (with imageId + bonusBuyIds)", () => {
    const dto = mapOfferProduct({
      id: "PROD-1",
      name: "Milk",
      priceWithoutDecimal: 1999,
      imageId: "IMG-1",
      bonusBuyIds: ["PROMO-1"],
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["productId", "name", "price", "imageId", "bonusBuyIds"]);
    expect(dto).toMatchObject({ productId: "PROD-1", name: "Milk", price: 1999, imageId: "IMG-1" });
    expect(dto.bonusBuyIds).toEqual(["PROMO-1"]);
  });

  it("mapOfferProduct (minimal — no optional keys emitted)", () => {
    const dto = mapOfferProduct({ id: "PROD-2", name: "Bread", ...POISON } as never);
    assertClean(dto);
    expectKeys(dto, ["productId", "name", "price"]);
    expect(dto.price).toBeNull();
  });

  it("mapOfferProduct drops non-string bonusBuyIds and never aliases the raw array", () => {
    const raw = { id: "PROD-3", name: "X", bonusBuyIds: ["A", 5, null, "B"] } as never;
    const dto = mapOfferProduct(raw);
    expect(dto.bonusBuyIds).toEqual(["A", "B"]);
    expect(dto.bonusBuyIds).not.toBe((raw as { bonusBuyIds: unknown }).bonusBuyIds);
  });

  it("mapCategory", () => {
    const dto = mapCategory({
      displayCategoryId: "CAT-1",
      name: "Dairy",
      count: 12,
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["id", "name", "count"]);
    expect(dto).toEqual({ id: "CAT-1", name: "Dairy", count: 12 });
  });

  it("mapCategory falls back to id and null count", () => {
    const dto = mapCategory({ id: "CAT-2", name: "Snacks" } as never);
    expect(dto).toEqual({ id: "CAT-2", name: "Snacks", count: null });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Real-fixture tests — allowlisted fields parse from the captured contracts
// ════════════════════════════════════════════════════════════════════════
describe("real fixtures parse to allowlisted DTOs", () => {
  it("offers: offers-for-you promotions map → BonusBuy[]", async () => {
    const dtos = await getOffers();
    expect(dtos).toHaveLength(Object.keys(offersFixture.promotions).length);
    expect(dtos.every((d) => typeof d.id === "string")).toBe(true);
    expect(dtos.find((d) => d.id === "PROMO-0001")?.membersOnly).toBe(true);
    assertClean(dtos);
  });

  it("discover: promotions/forYou → DiscoverDTO { promotions, products }", async () => {
    const dto = await getDiscover(true);
    expectKeys(dto, ["promotions", "products"]);
    expect(dto.promotions).toHaveLength(promotionsFixture.bonusBuys.length);
    expect(dto.products).toHaveLength(promotionsFixture.items.length);
    dto.products.forEach((p) => {
      const keys = Object.keys(p);
      expect(keys).toContain("productId");
      expect(keys).toContain("name");
      expect(keys).toContain("price");
      keys.forEach((k) => expect(["productId", "name", "price", "imageId", "bonusBuyIds"]).toContain(k));
    });
    assertClean(dto);
  });

  it("discover derives membership from the profile when no flag is given", async () => {
    await getDiscover(undefined);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    // Derivation fetched the profile, then queried promotions with the derived flag.
    expect(urls.some((u) => u.includes("/dsl/") && u.endsWith("/users"))).toBe(true);
    const promoCall = urls.find((u) => u.includes("/promotions/forYou"));
    expect(promoCall).toContain("isXtraSavingsMember=true");
  });

  it("discover with an explicit flag does NOT fetch the profile", async () => {
    await getDiscover(false);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.includes("/dsl/") && u.endsWith("/users"))).toBe(false);
    expect(urls.find((u) => u.includes("/promotions/forYou"))).toContain("isXtraSavingsMember=false");
  });

  it("categories: filter/options departmentOptions → CategoryDTO[]", async () => {
    const dtos = await getCategories("milk");
    expect(dtos).toHaveLength(filterOptionsFixture.filterOptions.departmentOptions.length);
    dtos.forEach((d) => expectKeys(d, ["id", "name", "count"]));
    expect(dtos[0]).toEqual({ id: "CAT-0001", name: "Milk, Dairy & Eggs", count: 27 });
    assertClean(dtos);
  });
});

// ════════════════════════════════════════════════════════════════════════
// isXtraSavingsMember derivation (boolean only; profile PII never escapes)
// ════════════════════════════════════════════════════════════════════════
describe("isXtraSavingsMember derivation", () => {
  it("true for an active Checkers loyalty card", async () => {
    expect(await new CheckersAPI().isXtraSavingsMember()).toBe(true);
  });

  it("true for an active Xtra card", async () => {
    profileResponse = { response: { user: { loyaltyCards: { cards: [{ active: true, theme: "Xtra Savings" }] } } } };
    expect(await new CheckersAPI().isXtraSavingsMember()).toBe(true);
  });

  it("false for an inactive card, no cards, or an active UNRELATED card type", async () => {
    profileResponse = { response: { user: { loyaltyCards: { cards: [{ active: false, theme: "Checkers" }] } } } };
    expect(await new CheckersAPI().isXtraSavingsMember()).toBe(false);
    profileResponse = { response: { user: {} } };
    expect(await new CheckersAPI().isXtraSavingsMember()).toBe(false);
    // An active card that is NOT a Checkers/Xtra card must not imply membership.
    profileResponse = { response: { user: { loyaltyCards: { cards: [{ active: true, theme: "Shoprite" }] } } } };
    expect(await new CheckersAPI().isXtraSavingsMember()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Command --json output is DTO-shaped and clean (empty feeds)
// ════════════════════════════════════════════════════════════════════════
describe("command --json output is DTO-shaped", () => {
  it("offers --json (empty promotions map → [])", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/products/offers-for-you")) return ok({ promotions: {}, success: true });
      return routeRequest(...args);
    });
    const out = await captureStdout(() => offersCommand({ json: true }));
    expect(JSON.parse(out)).toEqual([]);
  });

  it("discover --json (empty feed → { promotions: [], products: [] })", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/promotions/forYou")) return ok({ bonusBuys: [], items: [], success: true });
      return routeRequest(...args);
    });
    const out = await captureStdout(() => discoverCommand({ json: true, member: true }));
    expect(JSON.parse(out)).toEqual({ promotions: [], products: [] });
  });

  it("categories --json (empty departments → [])", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/products/filter/options"))
        return ok({ success: true, filterOptions: { departmentOptions: [] } });
      return routeRequest(...args);
    });
    const out = await captureStdout(() => categoriesCommand("nothing", { json: true }));
    expect(JSON.parse(out)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// COMMAND-LEVEL poison (end-to-end): poisoned API → clean --json stdout
// ════════════════════════════════════════════════════════════════════════
describe("command --json output is clean end-to-end (poisoned API responses)", () => {
  beforeEach(() => {
    requestMock.mockImplementation(poisonRouter);
  });

  it("offers: poisoned offers-for-you → clean BonusBuy[]", async () => {
    const out = await captureStdout(() => offersCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((d: { id: string }) => typeof d.id === "string")).toBe(true);
  });

  it("discover: poisoned promotions/forYou + profile → clean DiscoverDTO", async () => {
    const out = await captureStdout(() => discoverCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, ["promotions", "products"]);
    expect(parsed.products.length).toBeGreaterThan(0);
    parsed.products.forEach((p: object) => {
      Object.keys(p).forEach((k) =>
        expect(["productId", "name", "price", "imageId", "bonusBuyIds"]).toContain(k)
      );
    });
  });

  it("categories: poisoned filter/options → clean CategoryDTO[]", async () => {
    const out = await captureStdout(() => categoriesCommand("milk", { json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((c: object) => expectKeys(c, ["id", "name", "count"]));
  });
});
