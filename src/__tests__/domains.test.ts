import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
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
  mapCheckoutPreview,
  emptyCheckoutPreview,
  getCheckoutPreview,
  CHECKOUT_EMPTY_CART_MESSAGE,
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
import { classifyError, UsageError, EXIT_USAGE } from "../lib/errors.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import { regulars as regularsCommand } from "../commands/regulars.js";
import { reorder as reorderCommand } from "../commands/reorder.js";
import { orders as ordersCommand, ordersShow } from "../commands/orders.js";
import { track as trackCommand } from "../commands/track.js";
import { returns as returnsCommand, returnsShow } from "../commands/returns.js";
import { fav as favCommand } from "../commands/fav.js";
import { addresses as addressesCommand } from "../commands/addresses.js";
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
  if (url.includes("customer-profile/v2")) {
    return ok({
      userProfile: {
        IsXtraSavingsCustomer: true,
        xTraSavingsCardNumber: "XS-CARD-0001",
        account: { balanceAmount: 12345, balanceFactor: 100, transactions: [POISON], ...POISON },
        addresses: [{ _id: "a1", name: "Home", city: "Cape Town", ...POISON }],
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

beforeEach(async () => {
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  resetRuntimeForTests();
  await initRuntime();
  ownGroups = [];
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
  "total",
  "fees",
  "minimumOrder",
  "violations",
  "quoteId",
  "quoteExpiry",
  "message",
];

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

  it("mapCheckoutPreview maps money as integer cents and preserves the UNKNOWN fee", () => {
    const dto = mapCheckoutPreview(preOrderFixture.totals);
    expectKeys(dto, CHECKOUT_KEYS);
    expect(dto.populated).toBe(true);
    expect(dto.subtotal).toBe(18500);
    expect(dto.total).toBe(22350);
    expect(dto.currency).toBe("ZAR");
    // Every fee is name + amount ONLY, amount an integer (never a float on money).
    dto.fees.forEach((f) => {
      expectKeys(f, ["name", "amount"]);
      expect(Number.isInteger(f.amount)).toBe(true);
    });
    // The unknown "eco-bag" category is NOT dropped — name + amount survive.
    const eco = dto.fees.find((f) => f.name === "Reusable bag levy");
    expect(eco).toBeDefined();
    expect(eco).toEqual({ name: "Reusable bag levy", amount: 150 });
    // Minimum-order status.
    expect(dto.minimumOrder).toEqual({ value: 35000, met: false, shortfall: 16500 });
    // Quote id + expiry surfaced (expiry normalized to ISO-8601).
    expect(dto.quoteId).toBe("PREORDER-Q-0001");
    expect(dto.quoteExpiry).toBe(new Date("2026-09-06T11:15:00+02:00").toISOString());
    expect(dto.violations.length).toBe(1);
  });

  it("mapCheckoutPreview drops ALL PII/secrets (poison totals)", () => {
    const dto = mapCheckoutPreview(preOrderFixture.totals);
    assertClean(dto);
  });

  it("empty array of fees suppresses scalar-fee fallback (no double-count)", () => {
    const dto = mapCheckoutPreview({ subTotal: 100, total: 100, fees: [], deliveryFee: 3500 });
    expect(dto.fees).toEqual([]);
  });

  it("with --preview + populated cart: emits a clean totals DTO end-to-end", async () => {
    requestMock.mockImplementation(checkoutRouter);
    const out = await captureStdout(() => checkoutCommand({ preview: true, json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expectKeys(parsed, CHECKOUT_KEYS);
    expect(parsed.populated).toBe(true);
    expect(parsed.total).toBe(22350);
    expect(parsed.fees.some((f: { name: string }) => f.name === "Reusable bag levy")).toBe(true);
    // The pre-order call WAS made (totals derive from it) — no new endpoint.
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.includes("/orders/pre-order"))).toBe(true);
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
      total: null,
      fees: [],
      minimumOrder: { value: null, met: null, shortfall: null },
      violations: [],
      quoteId: null,
      quoteExpiry: null,
      message: CHECKOUT_EMPTY_CART_MESSAGE,
    });
  });

  it("getCheckoutPreview reuses the pre-order call and never places an order", async () => {
    requestMock.mockImplementation(checkoutRouter);
    const dto = await getCheckoutPreview();
    expect(dto.populated).toBe(true);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    // Only cart read + pre-order — no order-submit / payment endpoint.
    expect(urls.every((u) => u.includes("/carts/user") || u.includes("/orders/pre-order"))).toBe(true);
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
});
