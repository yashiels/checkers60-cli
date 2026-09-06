import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string) =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

const myProductsFixture = loadFixture("api-my-products.json");
const completedOrdersFixture = loadFixture("api-completed-orders.json");
const firstSlotsFixture = loadFixture("api-first-delivery-slots.json");
const returnGroupsFixture = loadFixture("api-return-groups.json");
const favouritesFixture = loadFixture("api-favourites.json");
const customerProfileFixture = loadFixture("api-customer-profile.json");
const preOrderFixture = loadFixture("api-pre-order.json");
const cardsFixture = loadFixture("api-cards.json");

/** A populated single-cart `/carts/user` response (drives getDeliverySlots → pre-order). */
const populatedCart = {
  carts: [
    {
      item: {
        id: "cart-1",
        cartVersion: 3,
        serviceOptionId: "sixty-min-delivery",
        lineItems: [
          { id: "li-1", productId: "p1", quantity: 2, price: 9250, priceFactor: 100, storeId: "store-1" },
        ],
      },
    },
  ],
};

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
  mapRegular,
  mapOrderItem,
  mapCompletedOrder,
  mapOrderSummary,
  mapOrderDetail,
  mapTrack,
  mapFavourite,
  mapReturnGroup,
  mapAddress,
  mapFirstDeliverySlots,
  mapMembership,
  mapWallet,
  mapCard,
  getCards,
  mapCheckoutPreview,
  emptyCheckoutPreview,
  getCheckoutPreview,
  CHECKOUT_EMPTY_CART_MESSAGE,
  CHECKOUT_TIP_PRESETS_CENTS,
  CHECKOUT_SELECTION_NOTE,
  resolveServiceOption,
  HYPER_DEFERRED_MESSAGE,
  DELIVERY_MODES,
  getRegulars,
  getReorderPreview,
  getCompletedOrders,
  getOrderDetail,
  getTrack,
  getReturnDetail,
  getFavourites,
  getSlots,
  getMembership,
  getWallet,
} from "../lib/orders.js";
import { classifyError, UsageError, EXIT_USAGE, EXIT_CONFIRM } from "../lib/errors.js";
import { APIError } from "../lib/api.js";
import { CONFIG } from "../lib/config.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import { regulars as regularsCommand } from "../commands/regulars.js";
import { reorder as reorderCommand } from "../commands/reorder.js";
import { orders as ordersCommand, ordersShow } from "../commands/orders.js";
import { track as trackCommand } from "../commands/track.js";
import { returns as returnsCommand, returnsShow } from "../commands/returns.js";
import { fav as favCommand } from "../commands/fav.js";
import { addresses as addressesCommand, addressesUse } from "../commands/addresses.js";
import { cards as cardsCommand } from "../commands/cards.js";
import { slots as slotsCommand } from "../commands/slots.js";
import { plus as plusCommand } from "../commands/plus.js";
import { wallet as walletCommand } from "../commands/wallet.js";
import { checkout as checkoutCommand } from "../commands/checkout.js";

const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;

// ── Synthetic "poison" payload ───────────────────────────────────────────
// Distinctively-tagged PII/secret values that must NEVER reach a DTO. Tags are
// unique strings (and off-grid coordinates) so they cannot collide with any
// legitimate allowlisted value (price, qty, id, real city, …).
const POISON = {
  driver: {
    name: "POISON_DRIVER_NAME",
    firstName: "POISON_DRIVER_FIRST",
    lastName: "POISON_DRIVER_LAST",
    phone: "POISON_PHONE_0821112222",
    location: { lat: 12.345678, lng: 98.765432 },
    coordinates: ["POISON_COORD_A", "POISON_COORD_B"],
  },
  driverName: "POISON_DRIVER_NAME",
  driverPhone: "POISON_PHONE_0821112222",
  address: {
    unit: "POISON_UNIT_42",
    street: "POISON_STREET",
    suburb: "POISON_SUBURB",
    deliveryNotes: "POISON_NOTES",
    fullAddress: "POISON_FULL_ADDRESS",
    latitude: 12.345678,
    longitude: 98.765432,
  },
  unit: "POISON_UNIT_42",
  street: "POISON_STREET",
  suburb: "POISON_SUBURB",
  deliveryNotes: "POISON_NOTES",
  latitude: 12.345678,
  longitude: 98.765432,
  payment: {
    token: "POISON_PAYTOKEN",
    cardToken: "POISON_CARDTOKEN",
    maskedCardNumber: "POISON_CARD_4111",
  },
  paymentToken: "POISON_PAYTOKEN",
  maskedCardNumber: "POISON_CARD_4111",
  loyalty: { xtraSavingsId: "POISON_SAID", saId: "POISON_SAID" },
  loyaltyId: "POISON_LOYALTY",
  xtraSavingsAccessToken: "POISON_XS_ACCESS",
  xtraSavingsIdToken: "POISON_XS_ID",
  idNumber: "POISON_SAID",
  saId: "POISON_SAID",
  email: "POISON_EMAIL@example.com",
  signedUrl: "https://poison.example/x.jpg?token=POISON_SIGNED_TOKEN",
  photoUrl: "https://poison.example/p.jpg?signature=POISON_SIGNATURE",
  arbitraryUnknown: "POISON_UNKNOWN",
};

const FORBIDDEN = [
  "POISON_DRIVER_NAME",
  "POISON_DRIVER_FIRST",
  "POISON_DRIVER_LAST",
  "POISON_PHONE_0821112222",
  "POISON_COORD_A",
  "POISON_COORD_B",
  "POISON_UNIT_42",
  "POISON_STREET",
  "POISON_SUBURB",
  "POISON_NOTES",
  "POISON_FULL_ADDRESS",
  "POISON_PAYTOKEN",
  "POISON_CARDTOKEN",
  "POISON_CARD_4111",
  "POISON_SAID",
  "POISON_LOYALTY",
  "POISON_XS_ACCESS",
  "POISON_XS_ID",
  "POISON_EMAIL@example.com",
  "POISON_SIGNED_TOKEN",
  "POISON_SIGNATURE",
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

// ── request router (branch by URL + body) ────────────────────────────────
const ok = (data: unknown) =>
  Promise.resolve({ status: 200, headers: new Headers(), data });

/** Build a catalog product for each requested id (resolves names/prices). */
function catalogFor(ids: string[]) {
  return {
    products: ids.map((id) => ({
      id,
      name: `Product ${id}`,
      priceWithoutDecimal: 1999,
    })),
  };
}

// Overridable per-test: the orders/groups list the account "owns".
let ownGroups: unknown[] = [];

function routeRequest(...args: unknown[]) {
  const url = String(args[1] ?? "");
  const opts = (args[2] ?? {}) as { json?: { filter?: { productListSource?: { productIds?: string[] } } } };

  if (url.includes("/orders/my-products")) return ok(myProductsFixture);
  if (url.includes("/orders/completed-orders")) return ok(completedOrdersFixture);
  if (url.includes("/orders/groups")) return ok({ orderGroups: ownGroups });
  if (url.includes("/first-delivery-slots")) return ok(firstSlotsFixture);
  if (url.includes("/return-groups/app/user")) return ok(returnGroupsFixture);
  if (url.includes("/products/favourites")) return ok(favouritesFixture);
  if (url.endsWith("/cards")) return ok(cardsFixture);
  if (url.includes("customer-profile/v2")) return ok(customerProfileFixture);
  if (url.includes("/products/filter")) {
    const ids = opts.json?.filter?.productListSource?.productIds ?? [];
    return ok(catalogFor(ids));
  }
  return ok({});
}

// ── POISON router: every API envelope a read command touches, saturated with
// nested PII/secrets at the request/fetch boundary. Real allowlisted fields are
// present too, so each command still produces non-empty output to inspect.
function poisonRouter(...args: unknown[]) {
  const url = String(args[1] ?? "");
  const opts = (args[2] ?? {}) as {
    json?: { filter?: { productListSource?: { productIds?: string[] } } };
  };

  if (url.includes("/orders/my-products")) {
    return ok({
      userProductScores: [{ productId: "p1", score: 9, count: 4, ...POISON }],
      ...POISON,
    });
  }
  if (url.includes("/orders/completed-orders")) {
    return ok({
      orders: [
        {
          id: "PO-1",
          createdOn: 1788097128454,
          status: { orderStatus: "delivered" },
          orderItems: [
            {
              productId: "p1",
              quantity: 2,
              price: 100,
              productMinInfo: { name: "Milk", ...POISON },
              ...POISON,
            },
          ],
          orderDelivery: POISON,
          ...POISON,
        },
      ],
      ...POISON,
    });
  }
  if (url.includes("/orders/groups")) {
    return ok({
      orderGroups: [
        {
          reference: "OG-1",
          orders: [
            {
              status: { orderStatus: "on_the_way" },
              total: { totalOwing: 12345 },
              orderItems: [
                {
                  productId: "p1",
                  quantity: 1,
                  price: 100,
                  productMinInfo: { name: "Bread", ...POISON },
                  ...POISON,
                },
              ],
              orderDelivery: POISON,
              ...POISON,
            },
          ],
          ...POISON,
        },
      ],
      ...POISON,
    });
  }
  if (url.includes("/first-delivery-slots")) {
    return ok({
      allowASAPDelivery: true,
      firstAvailableSlotSixtyMin: {
        startTime: "2026-09-05T11:00:00+02:00",
        endTime: "2026-09-05T12:00:00+02:00",
        ...POISON,
      },
      firstAvailableSlotOneDay: null,
      deliveryFeesAndMinimumOrderValues: {
        "sixty-min-delivery": {
          serviceOption: "sixty-min-delivery",
          deliveryFee: 37,
          minimumOrderValue: 150,
          ...POISON,
        },
      },
      ...POISON,
    });
  }
  if (url.includes("/return-groups/app/user")) {
    return ok({
      returns: {
        inProgressReturnGroups: [
          {
            id: "RG-1",
            reference: "RET-1",
            returnStatus: "approved",
            items: [
              {
                productId: "p1",
                quantity: 1,
                name: "Item",
                productMinInfo: { name: "Item", ...POISON },
                ...POISON,
              },
            ],
            contact: POISON,
            photoUrls: [POISON.signedUrl, POISON.photoUrl],
            ...POISON,
          },
        ],
        completedReturnGroups: [],
      },
    });
  }
  if (url.includes("/products/favourites")) {
    return ok({ favourites: [{ productId: "p1", ...POISON }], ...POISON });
  }
  if (url.endsWith("/cards")) {
    return ok({
      success: true,
      cards: [
        {
          ...POISON,
          issuer: "VISA",
          maskedCardNumber: "•••• 0007",
          expiryMonth: "07",
          expiryYear: "2029",
          isDefault: true,
          token: "POISON_CARDTOKEN",
          cardholderName: "POISON_CARDHOLDER_NAME",
          cardHasBeenUsed: true,
          mostRecentlyUsed: true,
        },
      ],
      ...POISON,
    });
  }
  if (url.includes("customer-profile/v2")) {
    return ok({
      userProfile: {
        IsXtraSavingsCustomer: true,
        xTraSavingsCardNumber: "XS-CARD-0001",
        account: { balanceAmount: 12345, balanceFactor: 100, transactions: [POISON], ...POISON },
        addresses: [
          {
            _id: "a1",
            name: "Home",
            city: "Cape Town",
            ...POISON,
            coordinates: { latitude: 12.345678, longitude: 98.765432 },
          },
        ],
        ...POISON,
      },
      ...POISON,
    });
  }
  if (url.includes("/products/filter")) {
    const ids = opts.json?.filter?.productListSource?.productIds ?? [];
    return ok({
      products: ids.map((id) => ({ id, name: `Product ${id}`, priceWithoutDecimal: 1999, ...POISON })),
      ...POISON,
    });
  }
  return ok({});
}

let plansTmp: string;

beforeEach(async () => {
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  // Isolate any confirmation-plan artifacts (addresses use preview) to a temp dir
  // so a preview never touches the real home directory.
  plansTmp = mkdtempSync(join(tmpdir(), "c60-domains-plans-"));
  process.env.CHECKERS60_PLANS_DIR = plansTmp;
  resetRuntimeForTests();
  await initRuntime();
  ownGroups = [];
  requestMock.mockReset();
  requestMock.mockImplementation(routeRequest);
});

afterEach(() => {
  if (origEnvDeviceId === undefined) delete process.env.CHECKERS60_DEVICE_ID;
  else process.env.CHECKERS60_DEVICE_ID = origEnvDeviceId;
  delete process.env.CHECKERS60_PLANS_DIR;
  rmSync(plansTmp, { recursive: true, force: true });
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
// POISON tests — prove redaction at every DTO mapper (§7 must-fix #2)
// ════════════════════════════════════════════════════════════════════════
describe("DTO mappers redact all PII/secrets (synthetic poison inputs)", () => {
  it("mapRegular", () => {
    const dto = mapRegular(
      { productId: "p1", score: 5, count: 3, ...POISON } as never,
      { id: "p1", name: "Milk", priceWithoutDecimal: 1999, ...POISON } as never
    );
    assertClean(dto);
    expectKeys(dto, ["productId", "name", "price", "score", "count"]);
    expect(dto).toMatchObject({ productId: "p1", name: "Milk", price: 1999, score: 5, count: 3 });
  });

  it("mapOrderItem", () => {
    const dto = mapOrderItem({
      productId: "p1",
      quantity: 2,
      price: 4999,
      productMinInfo: { name: "Red Bull", ...POISON },
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["productId", "name", "quantity", "price"]);
    expect(dto.name).toBe("Red Bull");
  });

  it("mapCompletedOrder", () => {
    const dto = mapCompletedOrder({
      id: "o1",
      createdOn: 1788097128454,
      status: { orderStatus: "delivered" },
      orderItems: [{ productId: "p1", quantity: 1, price: 100, ...POISON }],
      orderDelivery: POISON,
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["id", "date", "status", "itemCount", "items"]);
    dto.items.forEach((i) => expectKeys(i, ["productId", "name", "quantity", "price"]));
  });

  it("mapOrderSummary + mapOrderDetail + mapTrack", () => {
    const group = {
      reference: "REF-1",
      orders: [
        {
          status: { orderStatus: "on_the_way" },
          total: { totalOwing: 12345 },
          orderItems: [{ productId: "p1", quantity: 1, price: 100, ...POISON }],
          orderDelivery: POISON,
          ...POISON,
        },
      ],
      ...POISON,
    };
    const summary = mapOrderSummary(group as never);
    assertClean(summary);
    expectKeys(summary, ["reference", "status", "total"]);

    const detail = mapOrderDetail(group as never);
    assertClean(detail);
    expectKeys(detail, ["reference", "status", "total", "itemCount", "items"]);

    const track = mapTrack(group as never);
    assertClean(track);
    expectKeys(track, ["reference", "status", "eta", "slotFrom", "slotTo", "itemCount", "total"]);
    // Track never surfaces driver name/phone/coords.
    expect(track.eta).toBeNull();
  });

  it("mapFavourite", () => {
    const dto = mapFavourite({
      id: "p1",
      name: "Cheese",
      priceWithoutDecimal: 899,
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["productId", "name", "price"]);
  });

  it("mapReturnGroup", () => {
    const dto = mapReturnGroup({
      id: "r1",
      reference: "RET-1",
      returnStatus: "approved",
      items: [{ productId: "p1", quantity: 1, name: "Item", ...POISON }],
      contact: POISON,
      photoUrls: [POISON.signedUrl, POISON.photoUrl],
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["id", "reference", "status", "itemCount", "items"]);
    dto.items.forEach((i) => expectKeys(i, ["productId", "name", "quantity"]));
  });

  it("mapAddress (keeps id/name/city ONLY — drops unit/street/suburb/notes/coords)", () => {
    const dto = mapAddress({
      _id: "a1",
      name: "Home",
      city: "Cape Town",
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["id", "name", "city"]);
    expect(dto).toEqual({ id: "a1", name: "Home", city: "Cape Town" });
  });

  it("mapFirstDeliverySlots", () => {
    const dtos = mapFirstDeliverySlots(
      {
        allowASAPDelivery: true,
        firstAvailableSlotSixtyMin: { startTime: "2026-09-05T11:00:00+02:00", endTime: "2026-09-05T12:00:00+02:00" },
        firstAvailableSlotOneDay: null,
        deliveryFeesAndMinimumOrderValues: {
          "sixty-min-delivery": { serviceOption: "sixty-min-delivery", deliveryFee: 37, minimumOrderValue: 150, ...POISON },
        },
        ...POISON,
      } as never,
      [
        {
          storeId: "store-1",
          serviceOptionIds: ["sixty-min-delivery"],
          brandPriority: 0,
          hasCapacity: [],
          distanceFromCustomer: 0,
        },
      ]
    );
    dtos.forEach((d) => {
      assertClean(d);
      expectKeys(d, ["mode", "storeId", "from", "to", "available", "asap", "deliveryFee", "minimumOrderValue"]);
    });
  });

  it("mapMembership (keeps flag + own card number; drops XS tokens/PII)", () => {
    const dto = mapMembership({
      IsXtraSavingsCustomer: true,
      xTraSavingsCardNumber: "XS-CARD-0001",
      account: { balanceAmount: 5000, balanceFactor: 100, ...POISON },
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["isMember", "memberNumber", "lifetimeSavings"]);
    expect(dto).toEqual({ isMember: true, memberNumber: "XS-CARD-0001", lifetimeSavings: null });
  });

  it("mapWallet (balance in cents from account.balanceAmount; drops PII/tokens)", () => {
    const dto = mapWallet({
      account: { balanceAmount: 5000, balanceFactor: 100, ...POISON },
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, ["balance", "currency"]);
    expect(dto).toEqual({ balance: 5000, currency: "ZAR" });
  });

  it("mapWallet reports a MISSING balance as null (never 0)", () => {
    const dto = mapWallet({ account: {}, ...POISON } as never);
    expect(dto.balance).toBeNull();
    const noAccount = mapWallet({ ...POISON } as never);
    expect(noAccount.balance).toBeNull();
  });

  it("mapCard (keeps issuer/masked/expiry/default; drops token/cardholderName/usage flags)", () => {
    const dto = mapCard({
      ...POISON,
      issuer: "VISA",
      maskedCardNumber: "•••• 4242",
      expiryMonth: "07",
      expiryYear: "2029",
      isDefault: true,
      token: "POISON_CARDTOKEN",
      cardholderName: "POISON_CARDHOLDER_NAME",
      cardHasBeenUsed: true,
      mostRecentlyUsed: true,
    } as never);
    assertClean(dto);
    expect(JSON.stringify(dto)).not.toContain("POISON_CARDHOLDER_NAME");
    expectKeys(dto, ["issuer", "maskedCardNumber", "expiryMonth", "expiryYear", "isDefault"]);
    expect(dto).toEqual({
      issuer: "VISA",
      maskedCardNumber: "•••• 4242",
      expiryMonth: "07",
      expiryYear: "2029",
      isDefault: true,
    });
  });

  it("mapCard defaults isDefault to false and missing fields to null", () => {
    const dto = mapCard({ issuer: "VISA" } as never);
    expectKeys(dto, ["issuer", "maskedCardNumber", "expiryMonth", "expiryYear", "isDefault"]);
    expect(dto).toEqual({
      issuer: "VISA",
      maskedCardNumber: null,
      expiryMonth: null,
      expiryYear: null,
      isDefault: false,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Real-fixture tests — allowlisted fields parse from the captured contracts
// ════════════════════════════════════════════════════════════════════════
describe("real fixtures parse to allowlisted DTOs", () => {
  it("regulars: my-products scores → RegularDTO[] (resolved names/prices)", async () => {
    const dtos = await getRegulars(5);
    expect(dtos).toHaveLength(5);
    dtos.forEach((d) => expectKeys(d, ["productId", "name", "price", "score", "count"]));
    // Sorted by score descending.
    const scores = dtos.map((d) => d.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    assertClean(dtos);
  });

  it("reorder preview: completed-orders → CompletedOrderDTO with line items", async () => {
    const id = completedOrdersFixture.orders[0].id as string;
    const dto = await getReorderPreview(id);
    expect(dto).not.toBeNull();
    expectKeys(dto!, ["id", "date", "status", "itemCount", "items"]);
    expect(dto!.itemCount).toBeGreaterThan(0);
    dto!.items.forEach((i) => expectKeys(i, ["productId", "name", "quantity", "price"]));
    assertClean(dto);
  });

  it("getCompletedOrders maps every order to a DTO", async () => {
    const dtos = await getCompletedOrders();
    expect(dtos.length).toBe(completedOrdersFixture.orders.length);
    dtos.forEach((d) => expectKeys(d, ["id", "date", "status", "itemCount", "items"]));
  });

  it("slots: first-delivery-slots → SlotDTO[] (mode/store/from/to/available only)", async () => {
    const dtos = await getSlots(undefined);
    expect(dtos.length).toBeGreaterThan(0);
    dtos.forEach((d) =>
      expectKeys(d, ["mode", "storeId", "from", "to", "available", "asap", "deliveryFee", "minimumOrderValue"])
    );
    const sixty = dtos.find((d) => d.mode === "sixty-min-delivery");
    expect(sixty?.available).toBe(true);
  });

  it("slots --mode sixty-min filters to the one service option", async () => {
    const dtos = await getSlots("sixty-min");
    expect(dtos.every((d) => d.mode === "sixty-min-delivery")).toBe(true);
  });

  it("first-delivery-slots request: POST ?ignoreCarts=true with a BARE per-store array", async () => {
    await getSlots(undefined);
    const call = requestMock.mock.calls.find((c) => String(c[1]).includes("/first-delivery-slots"));
    expect(call).toBeDefined();
    const [method, url, opts] = call as [string, string, { json?: unknown }];
    expect(method).toBe("POST");
    expect(url).toContain("/api/v3/first-delivery-slots?ignoreCarts=true");
    // BARE ARRAY (not { storeContexts }), one entry per store, field servedServiceOptions.
    expect(Array.isArray(opts.json)).toBe(true);
    const body = opts.json as Array<{ storeId: string; servedServiceOptions: string[] }>;
    expect(body.length).toBe(CONFIG.DEFAULT_STORES.length);
    body.forEach((entry, i) => {
      expect(Object.keys(entry).sort()).toEqual(["servedServiceOptions", "storeId"]);
      expect(entry.storeId).toBe(CONFIG.DEFAULT_STORES[i].storeId);
      expect(entry.servedServiceOptions).toEqual(CONFIG.DEFAULT_STORES[i].serviceOptionIds);
    });
  });

  it("first-delivery-slots deliveryFee/minimumOrderValue are RAND (as reported)", async () => {
    const dtos = await getSlots("sixty-min");
    const sixty = dtos.find((d) => d.mode === "sixty-min-delivery");
    // Fixture reports RAND figures (37, 150) — passed through, NOT re-scaled to cents.
    expect(sixty?.deliveryFee).toBe(37);
    expect(sixty?.minimumOrderValue).toBe(150);
  });

  it("slots: a persistent 400 THROWS a typed error — never an empty slot list", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      if (String(args[1] ?? "").includes("/first-delivery-slots")) {
        return Promise.reject(new APIError(400, "Bad Request", '{"message":"Invalid Request"}', "first-delivery-slots"));
      }
      return routeRequest(...args);
    });
    await expect(getSlots(undefined)).rejects.toBeInstanceOf(APIError);
  });

  it("slots command on a 400 throws a typed non-zero error and prints no 'No delivery slots available'", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      if (String(args[1] ?? "").includes("/first-delivery-slots")) {
        return Promise.reject(new APIError(400, "Bad Request", "", "first-delivery-slots"));
      }
      return routeRequest(...args);
    });
    let thrown: unknown;
    const out = await captureStdout(async () => {
      try {
        await slotsCommand({});
      } catch (err) {
        thrown = err;
      }
    });
    expect(thrown).toBeInstanceOf(APIError);
    const c = classifyError(thrown);
    expect(c.code).not.toBe(0);
    expect(c.status).toBe(400);
    // The genuine-empty message must NEVER appear on a 400.
    expect(out).not.toContain("No delivery slots available");
  });

  it("favourites: empty fixture → []", async () => {
    const dtos = await getFavourites();
    expect(dtos).toEqual([]);
  });

  it("membership: customer-profile/v2 → MembershipDTO", async () => {
    const dto = await getMembership();
    expectKeys(dto, ["isMember", "memberNumber", "lifetimeSavings"]);
    expect(dto).toEqual({ isMember: true, memberNumber: "XS-CARD-0001", lifetimeSavings: null });
    assertClean(dto);
  });

  it("wallet: customer-profile/v2 account → WalletDTO (cents)", async () => {
    const dto = await getWallet();
    expectKeys(dto, ["balance", "currency"]);
    expect(dto).toEqual({ balance: 12345, currency: "ZAR" });
    assertClean(dto);
  });

  const CARD_KEYS = ["issuer", "maskedCardNumber", "expiryMonth", "expiryYear", "isDefault"];

  it("cards: api-cards fixture → CardDTO[] (5 keys; token/cardholderName never surface)", async () => {
    const dtos = await getCards();
    expect(dtos.length).toBe(cardsFixture.cards.length);
    dtos.forEach((d) => expectKeys(d, CARD_KEYS));
    const serialized = JSON.stringify(dtos);
    expect(serialized).not.toContain("SYNTH-TOKEN");
    expect(serialized).not.toContain("CARDHOLDER");
    expect(dtos[0].isDefault).toBe(true);
    expect(dtos[1].isDefault).toBe(false);
  });

  it("getCards GETs /customers/{userId}/cards with the Bearer SESSION token (no profile token)", async () => {
    await getCards();
    const call = requestMock.mock.calls.find((c) => String(c[1]).endsWith("/cards"));
    expect(call).toBeDefined();
    expect(String(call![0])).toBe("GET");
    expect(String(call![1])).toContain("/customers/user-id/cards");
    const opts = call![2] as { headers: Record<string, string>; retry?: string };
    expect(opts.headers.authorization).toBe("Bearer session-tok");
    // Static customer-profile token is NEVER used on the cards contract.
    expect(JSON.stringify(opts.headers)).not.toContain("G5tmYwwRnpfPmtJ3HT7VYV7C4x86NGDz");
    expect(opts.retry).toBe("safe");
  });

  it("cards: an API error propagates (no partial/guessed output)", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      if (String(args[1] ?? "").endsWith("/cards")) return Promise.reject(new Error("boom-cards"));
      return routeRequest(...args);
    });
    await expect(getCards()).rejects.toThrow(/boom-cards/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// IDOR guards (§7 must-fix #4)
// ════════════════════════════════════════════════════════════════════════
describe("IDOR guards: detail only for refs in the account's own list", () => {
  const ownGroup = {
    reference: "OWN-REF-1",
    orders: [
      {
        status: { orderStatus: "delivered" },
        total: { totalOwing: 5000 },
        orderItems: [{ productId: "p1", quantity: 1, price: 5000 }],
      },
    ],
  };

  it("orders show: a foreign ref resolves to null (no cross-account data)", async () => {
    ownGroups = [ownGroup];
    expect(await getOrderDetail("NOT-MINE")).toBeNull();
    expect(await getOrderDetail("OWN-REF-1")).not.toBeNull();
  });

  it("orders show command refuses a foreign ref", async () => {
    ownGroups = [ownGroup];
    await expect(ordersShow("NOT-MINE", { json: true })).rejects.toThrow(/not found/i);
    // Only the account-scoped list was fetched — no separate detail endpoint hit.
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.every((u) => u.includes("/orders/groups"))).toBe(true);
  });

  it("track: a foreign ref resolves to null and the command refuses", async () => {
    ownGroups = [ownGroup];
    expect(await getTrack("NOT-MINE")).toBeNull();
    await expect(trackCommand("NOT-MINE", { json: true })).rejects.toThrow(/not found/i);
  });

  it("returns show: a foreign id resolves to null", async () => {
    const withReturn = {
      inProgressReturnGroups: [{ id: "MY-RETURN-1", reference: "RET-1", returnStatus: "approved", items: [] }],
      completedReturnGroups: [],
    };
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/return-groups/app/user")) return ok({ returns: withReturn });
      return routeRequest(...args);
    });
    expect(await getReturnDetail("NOT-MINE")).toBeNull();
    expect(await getReturnDetail("MY-RETURN-1")).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// reorder --preview is mandatory (§7 must-fix #5): no --preview → usage error
// ════════════════════════════════════════════════════════════════════════
describe("reorder requires --preview", () => {
  it("throws a UsageError (exit 2) and makes NO request when --preview is absent", async () => {
    let thrown: unknown;
    try {
      await reorderCommand("SOMEREF", { json: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(classifyError(thrown).code).toBe(EXIT_USAGE);
    // Never fell through to any network call (no cart write, no fetch).
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("with --preview, previews a real completed order (prices labeled stale)", async () => {
    const id = completedOrdersFixture.orders[0].id as string;
    const out = await captureStdout(() => reorderCommand(id, { preview: true, json: true }));
    const parsed = JSON.parse(out);
    expect(parsed.preview).toBe(true);
    expect(parsed.pricesMayBeStale).toBe(true);
    expect(parsed.order.id).toBe(id);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Hyper deferral (§8): recognize but defer, NO network guess
// ════════════════════════════════════════════════════════════════════════
describe("slots --mode hyper is deferred", () => {
  it("emits the deferred message and makes NO request", async () => {
    const out = await captureStdout(() => slotsCommand({ mode: "hyper", json: true }));
    const parsed = JSON.parse(out);
    expect(parsed.mode).toBe("hyper");
    expect(parsed.supported).toBe(false);
    expect(parsed.message).toBe(HYPER_DEFERRED_MESSAGE);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("hyper is a first-class mode; resolveServiceOption maps only slot modes", () => {
    expect(DELIVERY_MODES).toContain("hyper");
    expect(resolveServiceOption("sixty-min")).toBe("sixty-min-delivery");
    expect(resolveServiceOption("one-day")).toBe("one-day-delivery");
  });
});

// ════════════════════════════════════════════════════════════════════════
// checkout --preview surfaces pre-order TOTALS (read-only, no place-order)
// ════════════════════════════════════════════════════════════════════════
const CHECKOUT_KEYS = [
  "preview",
  "populated",
  "currency",
  "subtotal",
  "discountTotal",
  "deliveryFee",
  "tipAmount",
  "totalOwing",
  "total",
  "fees",
  "allowASAPDelivery",
  "deliverySlots",
  "availablePaymentMethods",
  "tipPresetsCents",
  "note",
  "message",
];

const PREVIEW_SLOT_KEYS = ["from", "to", "displayName"];

/** Build the parsed PreOrderResult (as api.getDeliverySlots returns) from a raw pre-order fixture. */
function preResult(fixture: {
  deliverySlots: Record<string, { allowASAPDelivery?: boolean; slots?: unknown[] }>;
  detailedDeliveryFees?: unknown;
  payment?: unknown;
  totals?: unknown;
}) {
  const cart = Object.values(fixture.deliverySlots)[0] ?? {};
  return {
    slots: (cart.slots ?? []) as never,
    asap: cart.allowASAPDelivery === true,
    totals: fixture.totals as never,
    detailedDeliveryFees: fixture.detailedDeliveryFees as never,
    payment: fixture.payment,
    raw: fixture,
  };
}

/** Route `/carts/user` + `/orders/pre-order` for a populated checkout preview. */
function checkoutRouter(...args: unknown[]) {
  const url = String(args[1] ?? "");
  if (url.includes("/carts/user")) return ok(populatedCart);
  if (url.includes("/orders/pre-order")) return ok(preOrderFixture);
  return routeRequest(...args);
}

describe("checkout --preview surfaces pre-order totals", () => {
  it("without --preview: UsageError (exit 2) and NO request", async () => {
    let thrown: unknown;
    try {
      await checkoutCommand({ json: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(classifyError(thrown).code).toBe(EXIT_USAGE);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("mapCheckoutPreview maps the captured totals as integer CENTS", () => {
    const dto = mapCheckoutPreview(preResult(preOrderFixture));
    expectKeys(dto, CHECKOUT_KEYS);
    expect(dto.populated).toBe(true);
    expect(dto.currency).toBe("ZAR");
    // Every money field an integer cents value read by explicit key.
    expect(dto.subtotal).toBe(20396);
    expect(dto.discountTotal).toBe(4900);
    expect(dto.deliveryFee).toBe(3700);
    expect(dto.tipAmount).toBe(1000);
    expect(dto.totalOwing).toBe(20196);
    expect(dto.total).toBe(19196);
    [dto.subtotal, dto.deliveryFee, dto.tipAmount, dto.total].forEach((v) =>
      expect(Number.isInteger(v)).toBe(true)
    );
  });

  it("mapCheckoutPreview maps detailedDeliveryFees, slots and payment methods", () => {
    const dto = mapCheckoutPreview(preResult(preOrderFixture));
    // Per-service-option fee breakdown (cents).
    expect(dto.fees).toEqual([{ name: "sixty-min-delivery", amount: 3700 }]);
    // Slots carry only from/to/displayName.
    expect(dto.allowASAPDelivery).toBe(true);
    expect(dto.deliverySlots.length).toBe(2);
    dto.deliverySlots.forEach((s) => expectKeys(s, PREVIEW_SLOT_KEYS));
    expect(dto.deliverySlots[0]).toEqual({
      from: "2026-09-06T14:00:00+02:00",
      to: "2026-09-06T15:00:00+02:00",
      displayName: "2-3 PM",
    });
    // Payment METHOD TYPES only — never the card details in `options`.
    expect(dto.availablePaymentMethods).toEqual(["ecentric-card", "stitch-capitec-pay"]);
  });

  it("mapCheckoutPreview drops ALL PII/secrets (poison pre-order: card token/PAN/holder)", () => {
    const dto = mapCheckoutPreview(preResult(preOrderFixture));
    assertClean(dto);
  });

  it("with --preview + populated cart: emits a clean totals DTO end-to-end", async () => {
    requestMock.mockImplementation(checkoutRouter);
    const out = await captureStdout(() => checkoutCommand({ preview: true, json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, CHECKOUT_KEYS);
    expect(parsed.populated).toBe(true);
    expect(parsed.total).toBe(19196);
    expect(parsed.deliverySlots.length).toBe(2);
    // The pre-order call WAS made (totals derive from it).
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.includes("/orders/pre-order"))).toBe(true);
  });

  it("pre-order request: application/json (NOT form) with the enriched app body", async () => {
    requestMock.mockImplementation(checkoutRouter);
    await getCheckoutPreview();
    const call = requestMock.mock.calls.find((c) => String(c[1]).includes("/orders/pre-order"));
    expect(call).toBeDefined();
    const [method, url, opts] = call as [
      string,
      string,
      { json?: Record<string, unknown>; form?: unknown },
    ];
    expect(method).toBe("POST");
    expect(url).toContain("/api/v3/orders/pre-order");
    // Primary fix: JSON body, never the form-urlencoded quirk.
    expect(opts.form).toBeUndefined();
    expect(opts.json).toBeDefined();
    const body = opts.json as {
      cartsInfo: Array<{
        cartId: string;
        driverTipAmount: number;
        cart: Record<string, unknown>;
      }>;
      xsPlusMemberStatus: string;
      storeContexts: unknown[];
    };
    expect(body.xsPlusMemberStatus).toBeTypeOf("string");
    expect(Array.isArray(body.storeContexts)).toBe(true);
    const info = body.cartsInfo[0];
    expect(info.cartId).toBe("cart-1");
    expect(info.driverTipAmount).toBe(0);
    const cart = info.cart as {
      replacementOptions: unknown[];
      deliverySlot: unknown;
      paymentCard: unknown;
      stores: unknown[];
      lineItemTotals: unknown;
      cartSavings: unknown;
      maximumCartSize: number;
      warning: unknown;
      lineItems: Array<Record<string, unknown>>;
    };
    // FIXED 7-item replacement-options list.
    expect(cart.replacementOptions.length).toBe(7);
    expect((cart.replacementOptions as Array<{ code: string }>).map((o) => o.code)).toEqual([
      "replace-with",
      "best-match",
      "picker-decision",
      "refund",
      "alternative-replace",
      "alternative-dont-replace",
      "alternative-not-selected",
    ]);
    expect(cart.deliverySlot).toEqual({});
    expect(cart.paymentCard).toBeNull();
    expect(cart.stores).toEqual([]);
    expect(cart.maximumCartSize).toBe(35);
    expect(cart.warning).toEqual({});
    expect(cart.lineItemTotals).toBeDefined();
    expect(cart.cartSavings).toBeDefined();
    // Each line item carries availableForDelivery + ranged.
    cart.lineItems.forEach((li) => {
      expect(li).toHaveProperty("availableForDelivery");
      expect(li.ranged).toBe(true);
    });
  });

  it("empty cart: populated=false + guidance message, and NO pre-order request", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/carts/user")) return ok({ carts: [] });
      return routeRequest(...args);
    });
    const out = await captureStdout(() => checkoutCommand({ preview: true, json: true }));
    const parsed = JSON.parse(out);
    expectKeys(parsed, CHECKOUT_KEYS);
    expect(parsed.populated).toBe(false);
    expect(parsed.total).toBeNull();
    expect(parsed.fees).toEqual([]);
    expect(parsed.deliverySlots).toEqual([]);
    expect(parsed.message).toBe(CHECKOUT_EMPTY_CART_MESSAGE);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.includes("/orders/pre-order"))).toBe(false);
  });

  it("emptyCheckoutPreview is the fixed empty-cart shape", () => {
    expect(emptyCheckoutPreview()).toEqual({
      preview: true,
      populated: false,
      currency: "ZAR",
      subtotal: null,
      discountTotal: null,
      deliveryFee: null,
      tipAmount: null,
      totalOwing: null,
      total: null,
      fees: [],
      allowASAPDelivery: false,
      deliverySlots: [],
      availablePaymentMethods: [],
      tipPresetsCents: [1000, 2000, 3000, 5000],
      note: CHECKOUT_SELECTION_NOTE,
      message: CHECKOUT_EMPTY_CART_MESSAGE,
    });
  });

  it("getCheckoutPreview reads the pre-order response and never places an order", async () => {
    requestMock.mockImplementation(checkoutRouter);
    const dto = await getCheckoutPreview();
    expect(dto.populated).toBe(true);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    // Only cart read + pre-order (+ profile for xsPlusMemberStatus) — no
    // order-submit / payment endpoint, no cart mutation.
    expect(
      urls.every(
        (u) =>
          u.includes("/carts/user") ||
          u.includes("/orders/pre-order") ||
          u.includes("customer-profile")
      )
    ).toBe(true);
  });

  it("a persistent pre-order 400 THROWS a typed error — never a fake-empty preview", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/carts/user")) return ok(populatedCart);
      if (url.includes("/orders/pre-order")) {
        return Promise.reject(new APIError(400, "Bad Request", '{"message":"Invalid Request"}', "orders/pre-order"));
      }
      return routeRequest(...args);
    });
    await expect(getCheckoutPreview()).rejects.toBeInstanceOf(APIError);
  });

  it("checkout --preview on a 400 throws a typed non-zero error and prints no 'Cart is empty'", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/carts/user")) return ok(populatedCart);
      if (url.includes("/orders/pre-order")) {
        return Promise.reject(new APIError(400, "Bad Request", "", "orders/pre-order"));
      }
      return routeRequest(...args);
    });
    let thrown: unknown;
    const out = await captureStdout(async () => {
      try {
        await checkoutCommand({ preview: true });
      } catch (err) {
        thrown = err;
      }
    });
    expect(thrown).toBeInstanceOf(APIError);
    const c = classifyError(thrown);
    expect(c.code).not.toBe(0);
    expect(c.status).toBe(400);
    // The genuine empty-cart guidance must NEVER appear on a 400.
    expect(out).not.toContain("Cart is empty");
    expect(out).not.toContain(CHECKOUT_EMPTY_CART_MESSAGE);
  });

  it("poisoned pre-order response end-to-end → clean preview DTO", async () => {
    requestMock.mockImplementation(checkoutRouter);
    const out = await captureStdout(() => checkoutCommand({ preview: true, json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, CHECKOUT_KEYS);
    parsed.deliverySlots.forEach((s: object) => expectKeys(s, PREVIEW_SLOT_KEYS));
    // Payment card details (issuer/masked/token/holder) never surface — only type ids.
    expect(parsed.availablePaymentMethods).toEqual(["ecentric-card", "stitch-capitec-pay"]);
  });

  it("human output shows totals, slots, payment methods AND the tip note", async () => {
    requestMock.mockImplementation(checkoutRouter);
    const out = await captureStdout(() => checkoutCommand({ preview: true }));
    assertClean(out);
    expect(out).toContain("Checkout preview");
    expect(out).toContain("Total payable");
    expect(out).toContain("Delivery slots");
    expect(out).toContain("Payment methods");
    expect(out).toContain("Driver tip (examples)");
    expect(out).toContain("R10.00");
    expect(out).toContain("custom");
    expect(out).toContain(CHECKOUT_SELECTION_NOTE);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Command JSON shapes render ONLY from DTOs
// ════════════════════════════════════════════════════════════════════════
describe("command --json output is DTO-shaped and clean", () => {
  it("regulars --json", async () => {
    const out = await captureStdout(() => regularsCommand({ top: 3, json: true }));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    parsed.forEach((d: object) => expectKeys(d, ["productId", "name", "price", "score", "count"]));
  });

  it("orders --json (empty active list)", async () => {
    const out = await captureStdout(() => ordersCommand({ json: true }));
    expect(JSON.parse(out)).toEqual([]);
  });

  it("fav --json (empty)", async () => {
    const out = await captureStdout(() => favCommand({ json: true }));
    expect(JSON.parse(out)).toEqual([]);
  });

  it("returns --json (empty)", async () => {
    const out = await captureStdout(() => returnsCommand({ json: true }));
    expect(JSON.parse(out)).toEqual([]);
  });

  it("returns show --json refuses an unknown id", async () => {
    await expect(returnsShow("NOPE", { json: true })).rejects.toThrow(/not found/i);
  });

  it("addresses --json (empty) emits id/name/city DTOs only", async () => {
    const out = await captureStdout(() => addressesCommand({ json: true }));
    expect(JSON.parse(out)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// COMMAND-LEVEL poison (§7 must-fix #2, end-to-end): inject a poisoned API
// response at the request boundary, run the real command, capture its actual
// `--json` stdout, JSON.parse it, and prove NOTHING poisoned survives AND the
// output keys are exactly the allowlisted DTO keys. This exercises the whole
// path (fetch → map → serialize → stdout), not just the mapper in isolation.
// ════════════════════════════════════════════════════════════════════════
describe("command --json output is clean end-to-end (poisoned API responses)", () => {
  beforeEach(() => {
    requestMock.mockImplementation(poisonRouter);
  });

  const ORDER_ITEM_KEYS = ["productId", "name", "quantity", "price"];

  it("regulars: poisoned my-products + catalog → clean RegularDTO[]", async () => {
    const out = await captureStdout(() => regularsCommand({ top: 5, json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((d: object) => expectKeys(d, ["productId", "name", "price", "score", "count"]));
  });

  it("reorder --preview: poisoned completed-orders → clean ReorderPreviewDTO", async () => {
    const out = await captureStdout(() => reorderCommand("PO-1", { preview: true, json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, ["preview", "pricesMayBeStale", "order"]);
    expect(parsed.preview).toBe(true);
    expect(parsed.pricesMayBeStale).toBe(true);
    expectKeys(parsed.order, ["id", "date", "status", "itemCount", "items"]);
    expect(parsed.order.items.length).toBeGreaterThan(0);
    parsed.order.items.forEach((i: object) => expectKeys(i, ORDER_ITEM_KEYS));
  });

  it("orders list: poisoned order groups → clean OrderSummaryDTO[]", async () => {
    const out = await captureStdout(() => ordersCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((d: object) => expectKeys(d, ["reference", "status", "total"]));
  });

  it("orders show: poisoned order group → clean OrderDetailDTO", async () => {
    const out = await captureStdout(() => ordersShow("OG-1", { json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, ["reference", "status", "total", "itemCount", "items"]);
    expect(parsed.items.length).toBeGreaterThan(0);
    parsed.items.forEach((i: object) => expectKeys(i, ORDER_ITEM_KEYS));
  });

  it("track: poisoned order group (driver/coords) → clean TrackDTO", async () => {
    const out = await captureStdout(() => trackCommand("OG-1", { json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, ["reference", "status", "eta", "slotFrom", "slotTo", "itemCount", "total"]);
    expect(parsed.eta).toBeNull();
  });

  it("returns list: poisoned return groups → clean ReturnGroupDTO[]", async () => {
    const out = await captureStdout(() => returnsCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((r: { items: object[] }) => {
      expectKeys(r, ["id", "reference", "status", "itemCount", "items"]);
      r.items.forEach((i: object) => expectKeys(i, ["productId", "name", "quantity"]));
    });
  });

  it("returns show: poisoned return group → clean ReturnGroupDTO", async () => {
    const out = await captureStdout(() => returnsShow("RG-1", { json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, ["id", "reference", "status", "itemCount", "items"]);
    parsed.items.forEach((i: object) => expectKeys(i, ["productId", "name", "quantity"]));
  });

  it("fav: poisoned favourites + catalog → clean FavouriteDTO[]", async () => {
    const out = await captureStdout(() => favCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((d: object) => expectKeys(d, ["productId", "name", "price"]));
  });

  it("addresses: poisoned profile (unit/street/coords/notes) → clean AddressDTO[]", async () => {
    const out = await captureStdout(() => addressesCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((d: object) => expectKeys(d, ["id", "name", "city"]));
  });

  it("addresses use <known>: poisoned profile → clean preview (plan output leaks no coords/PII)", async () => {
    const prevExit = process.exitCode;
    try {
      const out = await captureStdout(() => addressesUse("a1", { json: true }));
      const parsed = JSON.parse(out);
      // Coordinates (12.345678 / 98.765432) live in the profile but must NEVER
      // reach the plan output — only the allowlisted id/name label does.
      assertClean(parsed);
      expect(parsed.confirmationRequired).toBe(true);
      const plan = parsed.plan as Record<string, unknown>;
      expectKeys(plan, ["operation", "planId", "expiresAt", "addressId", "name"]);
      expect(plan.addressId).toBe("a1");
      expect(process.exitCode).toBe(EXIT_CONFIRM);
    } finally {
      process.exitCode = prevExit;
    }
  });

  it("slots: poisoned first-delivery-slots → clean SlotDTO[]", async () => {
    const out = await captureStdout(() => slotsCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((d: object) =>
      expectKeys(d, [
        "mode",
        "storeId",
        "from",
        "to",
        "available",
        "asap",
        "deliveryFee",
        "minimumOrderValue",
      ])
    );
  });

  it("plus: poisoned profile (XS tokens/PII) → clean MembershipDTO", async () => {
    const out = await captureStdout(() => plusCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, ["isMember", "memberNumber", "lifetimeSavings"]);
    expect(parsed.isMember).toBe(true);
    expect(parsed.memberNumber).toBe("XS-CARD-0001");
    expect(parsed.lifetimeSavings).toBeNull();
  });

  it("wallet: poisoned profile (account/tokens/PII) → clean WalletDTO", async () => {
    const out = await captureStdout(() => walletCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, ["balance", "currency"]);
    expect(parsed.balance).toBe(12345);
    expect(parsed.currency).toBe("ZAR");
  });

  const CARD_KEYS = ["issuer", "maskedCardNumber", "expiryMonth", "expiryYear", "isDefault"];

  it("cards --json: poisoned cards (token/cardholderName) → clean CardDTO[]", async () => {
    const out = await captureStdout(() => cardsCommand({ json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((d: object) => expectKeys(d, CARD_KEYS));
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("POISON_CARDHOLDER_NAME");
    expect(serialized).not.toContain("POISON_CARDTOKEN");
  });

  it("cards table (human): poisoned response never prints token/cardholderName", async () => {
    const out = await captureStdout(() => cardsCommand({}));
    assertClean(out);
    expect(out).not.toContain("POISON_CARDHOLDER_NAME");
    expect(out).not.toContain("POISON_CARDTOKEN");
    // The allowlisted issuer/masked fields DO render.
    expect(out).toContain("VISA");
    expect(out).toContain("•••• 0007");
  });
});

// ════════════════════════════════════════════════════════════════════════
// addresses use <id> — gated switch: preview validates + stages, never writes.
// (The full preview→confirm→reconcile flow is covered in address-mutate.test.ts.)
// ════════════════════════════════════════════════════════════════════════
describe("addresses use <id> preview is read-only + validates the id", () => {
  const MUTATION_PATH = /\/addresses\/[^/]+\/use$|\/store-contexts$|\/carts\/update-address$|\/carts\/transfer-dummies$/;

  /** Profile with one saved (geocoded) address, plus PII the flow must drop. */
  function profileWithAddress(...args: unknown[]) {
    const url = String(args[1] ?? "");
    if (url.includes("customer-profile/v2")) {
      return ok({
        userProfile: {
          addresses: [
            {
              _id: "a1",
              name: "Home",
              city: "Cape Town",
              ...POISON,
              coordinates: { latitude: 12.345678, longitude: 98.765432 },
            },
          ],
        },
      });
    }
    if (url.includes("/carts/user")) return ok({ carts: [] });
    return routeRequest(...args);
  }

  function mutationCalls(): string[] {
    return requestMock.mock.calls
      .map((c) => String(c[1] ?? ""))
      .filter((u) => MUTATION_PATH.test(u));
  }

  it("unknown id → UsageError (exit 2) and dispatches NO switch call", async () => {
    requestMock.mockImplementation(profileWithAddress);
    let thrown: unknown;
    try {
      await addressesUse("NOT-MINE", { json: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(classifyError(thrown).code).toBe(EXIT_USAGE);
    expect(mutationCalls()).toHaveLength(0);
  });

  it("known id → confirmation-required preview (exit 5), clean, NO switch call", async () => {
    requestMock.mockImplementation(profileWithAddress);
    const prevExit = process.exitCode;
    try {
      const out = await captureStdout(() => addressesUse("a1", { json: true }));
      const parsed = JSON.parse(out);
      assertClean(parsed);
      expect(parsed.confirmationRequired).toBe(true);
      const plan = parsed.plan as Record<string, unknown>;
      expectKeys(plan, ["operation", "planId", "expiresAt", "addressId", "name"]);
      expect(plan).toMatchObject({ operation: "address.use", addressId: "a1", name: "Home" });
      expect(process.exitCode).toBe(EXIT_CONFIRM);
      expect(mutationCalls()).toHaveLength(0);
    } finally {
      process.exitCode = prevExit;
    }
  });
});
