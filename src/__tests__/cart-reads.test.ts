import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string) =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

const alternativesFixture = loadFixture("api-user-alternatives.json");

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
  mapBackupProduct,
  forgottenDeferredDTO,
  suggestDeferredDTO,
  getBackups,
  CART_FORGOTTEN_DEFERRED_MESSAGE,
  CART_SUGGEST_DEFERRED_MESSAGE,
} from "../lib/orders.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import { CONFIG } from "../lib/config.js";
import {
  cartForgotten,
  cartSuggest,
  backup as backupCommand,
} from "../commands/cart-reads.js";

const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;

// ── Synthetic "poison" payload ───────────────────────────────────────────
const POISON = {
  driver: { name: "POISON_DRIVER_NAME", phone: "POISON_PHONE_0821112222" },
  driverName: "POISON_DRIVER_NAME",
  driverPhone: "POISON_PHONE_0821112222",
  address: { unit: "POISON_UNIT_42", fullAddress: "POISON_FULL_ADDRESS" },
  unit: "POISON_UNIT_42",
  street: "POISON_STREET",
  suburb: "POISON_SUBURB",
  latitude: 12.345678,
  longitude: 98.765432,
  payment: { token: "POISON_PAYTOKEN", maskedCardNumber: "POISON_CARD_4111" },
  maskedCardNumber: "POISON_CARD_4111",
  loyaltyId: "POISON_LOYALTY",
  saId: "POISON_SAID",
  email: "POISON_EMAIL@example.com",
  signedUrl: "https://poison.example/x.jpg?token=POISON_SIGNED_TOKEN",
  stockOnHand: 4242,
  arbitraryUnknown: "POISON_UNKNOWN",
};

const FORBIDDEN = [
  "POISON_DRIVER_NAME",
  "POISON_PHONE_0821112222",
  "POISON_UNIT_42",
  "POISON_FULL_ADDRESS",
  "POISON_STREET",
  "POISON_SUBURB",
  "POISON_PAYTOKEN",
  "POISON_CARD_4111",
  "POISON_LOYALTY",
  "POISON_SAID",
  "POISON_EMAIL@example.com",
  "POISON_SIGNED_TOKEN",
  "POISON_UNKNOWN",
  "4242",
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

const BACKUP_KEYS = ["productId", "name", "price", "imageId"];

// ── request router ───────────────────────────────────────────────────────
const ok = (data: unknown) =>
  Promise.resolve({ status: 200, headers: new Headers(), data });

function catalogFor(ids: string[]) {
  return {
    products: ids.map((id) => ({
      id,
      name: `Product ${id}`,
      priceWithoutDecimal: 1999,
      imageId: `img-${id}`,
    })),
  };
}

function routeRequest(...args: unknown[]) {
  const url = String(args[1] ?? "");
  const opts = (args[2] ?? {}) as {
    json?: { filter?: { productListSource?: { productIds?: string[] } } };
  };
  if (url.includes("/products/user-alternatives")) return ok(alternativesFixture);
  if (url.includes("/products/filter")) {
    const ids = opts.json?.filter?.productListSource?.productIds ?? [];
    return ok(catalogFor(ids));
  }
  return ok({});
}

// POISON router: alternatives map + catalog products saturated with PII/secrets.
function poisonRouter(...args: unknown[]) {
  const url = String(args[1] ?? "");
  const opts = (args[2] ?? {}) as {
    json?: { filter?: { productListSource?: { productIds?: string[] } } };
  };
  if (url.includes("/products/user-alternatives")) {
    return ok({
      success: true,
      alternativeProductIdMap: { "PROD-0001": ["PROD-0002", "PROD-0003"] },
      ...POISON,
    });
  }
  if (url.includes("/products/filter")) {
    const ids = opts.json?.filter?.productListSource?.productIds ?? [];
    return ok({
      products: ids.map((id) => ({
        id,
        name: `Product ${id}`,
        priceWithoutDecimal: 1999,
        imageId: `img-${id}`,
        ...POISON,
      })),
      ...POISON,
    });
  }
  return ok({});
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
// mapBackupProduct redacts all PII/secrets
// ════════════════════════════════════════════════════════════════════════
describe("mapBackupProduct redacts PII and keeps only allowlisted keys", () => {
  it("maps id/name/price/imageId only", () => {
    const dto = mapBackupProduct({
      id: "PROD-0002",
      name: "Full Cream Milk",
      priceWithoutDecimal: 2499,
      imageId: "img-1",
      ...POISON,
    } as never);
    assertClean(dto);
    expectKeys(dto, BACKUP_KEYS);
    expect(dto).toEqual({
      productId: "PROD-0002",
      name: "Full Cream Milk",
      price: 2499,
      imageId: "img-1",
    });
  });

  it("nulls price/imageId when absent", () => {
    const dto = mapBackupProduct({ id: "PROD-0002", name: "x" } as never);
    expect(dto.price).toBeNull();
    expect(dto.imageId).toBeNull();
    expectKeys(dto, BACKUP_KEYS);
  });
});

// ════════════════════════════════════════════════════════════════════════
// getBackups: only THIS product's alternatives, deduped, in API order
// ════════════════════════════════════════════════════════════════════════
describe("getBackups", () => {
  it("resolves only alternativeProductIdMap[productId], deduped and ordered", async () => {
    const dtos = await getBackups("PROD-0001");
    // Fixture lists PROD-0002, PROD-0003, PROD-0002 (dup) — dedup to 2, order kept.
    expect(dtos.map((d) => d.productId)).toEqual(["PROD-0002", "PROD-0003"]);
    dtos.forEach((d) => expectKeys(d, BACKUP_KEYS));
    assertClean(dtos);
  });

  it("uses the exact captured contract: POST catalog user-alternatives with {productIds,storeContexts}", async () => {
    await getBackups("PROD-0001");
    const altCall = requestMock.mock.calls.find((c) =>
      String(c[1]).includes("/products/user-alternatives")
    );
    expect(altCall).toBeDefined();
    const [method, url, opts] = altCall as [string, string, { json?: unknown }];
    expect(method).toBe("POST");
    expect(url).toBe(
      "https://catalog.sixty60.co.za/api/v1/products/user-alternatives"
    );
    expect(opts.json).toEqual({
      productIds: ["PROD-0001"],
      storeContexts: CONFIG.DEFAULT_STORES,
    });
  });

  it("never returns the source product as its own backup", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/products/user-alternatives")) {
        return ok({ alternativeProductIdMap: { "PROD-0001": ["PROD-0001", "PROD-0002"] } });
      }
      return routeRequest(...args);
    });
    const dtos = await getBackups("PROD-0001");
    expect(dtos.map((d) => d.productId)).toEqual(["PROD-0002"]);
  });

  it("source-only alternatives → [] and NO catalog request", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/products/user-alternatives")) {
        return ok({ alternativeProductIdMap: { "PROD-0001": ["PROD-0001"] } });
      }
      return routeRequest(...args);
    });
    const dtos = await getBackups("PROD-0001");
    expect(dtos).toEqual([]);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.includes("/products/filter"))).toBe(false);
  });

  it("returns [] and makes no catalog call when the product has no alternatives", async () => {
    const dtos = await getBackups("PROD-UNKNOWN");
    expect(dtos).toEqual([]);
    const urls = requestMock.mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.includes("/products/filter"))).toBe(false);
  });

  it("does NOT flatten other products' alternatives", async () => {
    // PROD-9999 -> PROD-0004 exists in the fixture but must never leak into PROD-0001.
    const dtos = await getBackups("PROD-0001");
    expect(dtos.map((d) => d.productId)).not.toContain("PROD-0004");
  });

  it("excludes catalog rows for ids that were not requested", async () => {
    requestMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[1] ?? "");
      if (url.includes("/products/user-alternatives")) {
        return ok({ alternativeProductIdMap: { "PROD-0001": ["PROD-0002"] } });
      }
      if (url.includes("/products/filter")) {
        // Catalog returns an unrequested extra product — must be dropped.
        return ok({
          products: [
            { id: "PROD-0002", name: "Wanted", priceWithoutDecimal: 100, imageId: "i" },
            { id: "PROD-EXTRA", name: "Unwanted", priceWithoutDecimal: 999, imageId: "x" },
          ],
        });
      }
      return ok({});
    });
    const dtos = await getBackups("PROD-0001");
    expect(dtos.map((d) => d.productId)).toEqual(["PROD-0002"]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Deferred commands: forgotten + suggest (no network, honest capability)
// ════════════════════════════════════════════════════════════════════════
describe("cart forgotten / cart suggest are deferred", () => {
  it("forgotten emits supported:false + message and makes NO request", async () => {
    const out = await captureStdout(() => cartForgotten({ json: true }));
    const parsed = JSON.parse(out);
    expectKeys(parsed, ["feature", "supported", "message"]);
    expect(parsed.feature).toBe("forgotten");
    expect(parsed.supported).toBe(false);
    expect(parsed.message).toBe(CART_FORGOTTEN_DEFERRED_MESSAGE);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("suggest emits supported:false + message and makes NO request", async () => {
    const out = await captureStdout(() => cartSuggest({ json: true }));
    const parsed = JSON.parse(out);
    expectKeys(parsed, ["feature", "supported", "message"]);
    expect(parsed.feature).toBe("suggest");
    expect(parsed.supported).toBe(false);
    expect(parsed.message).toBe(CART_SUGGEST_DEFERRED_MESSAGE);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("deferral DTO factories are network-free and correctly shaped", () => {
    expect(forgottenDeferredDTO()).toEqual({
      feature: "forgotten",
      supported: false,
      message: CART_FORGOTTEN_DEFERRED_MESSAGE,
    });
    expect(suggestDeferredDTO()).toEqual({
      feature: "suggest",
      supported: false,
      message: CART_SUGGEST_DEFERRED_MESSAGE,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// backup command --json is DTO-shaped and clean end-to-end (poisoned API)
// ════════════════════════════════════════════════════════════════════════
describe("backup --json output is clean end-to-end (poisoned API responses)", () => {
  beforeEach(() => {
    requestMock.mockImplementation(poisonRouter);
  });

  it("poisoned alternatives + catalog → clean BackupProductDTO[]", async () => {
    const out = await captureStdout(() => backupCommand("PROD-0001", { json: true }));
    const parsed = JSON.parse(out);
    assertClean(parsed);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((d: object) => expectKeys(d, BACKUP_KEYS));
  });
});

describe("backup --json output (clean fixtures)", () => {
  it("renders the resolved alternatives", async () => {
    const out = await captureStdout(() => backupCommand("PROD-0001", { json: true }));
    const parsed = JSON.parse(out);
    expect(parsed.map((d: { productId: string }) => d.productId)).toEqual([
      "PROD-0002",
      "PROD-0003",
    ]);
  });

  it("empty alternatives → []", async () => {
    const out = await captureStdout(() => backupCommand("PROD-UNKNOWN", { json: true }));
    expect(JSON.parse(out)).toEqual([]);
  });
});
