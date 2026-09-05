import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const requestMock = vi.fn();
vi.mock("../lib/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/http.js")>();
  return { ...actual, request: (...args: unknown[]) => requestMock(...args) };
});

import { CheckersAPI } from "../lib/api.js";
import type { TokenManager, SessionContext } from "../lib/credentials.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";

const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;

beforeEach(async () => {
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  resetRuntimeForTests();
  await initRuntime();
  requestMock.mockReset();
});

afterEach(() => {
  if (origEnvDeviceId === undefined) delete process.env.CHECKERS60_DEVICE_ID;
  else process.env.CHECKERS60_DEVICE_ID = origEnvDeviceId;
  resetRuntimeForTests();
  vi.restoreAllMocks();
});

function fakeSession(): SessionContext {
  return {
    sessionToken: "session-tok",
    userId: "user-id",
    uuid: "shoprite-uuid",
    mobile: "+27000000000",
    customerId: "000C3V55",
  };
}

function fakeTokens(): TokenManager {
  return { getSession: vi.fn().mockResolvedValue(fakeSession()) } as unknown as TokenManager;
}

describe("CheckersAPI.commitCartUpdate error message", () => {
  it("throws a body-free error that never leaks the API payload", async () => {
    // The response has no `carts`, but DOES carry a secret-looking payload that
    // must NEVER be interpolated into the thrown error.
    requestMock.mockResolvedValue({
      status: 400,
      data: { errorCode: "AUTH_DENIED", token: "leaked-secret-token" },
    });

    const api = new CheckersAPI(fakeTokens());
    const snapshot = {
      carts: [
        {
          cartId: "cart-1",
          serviceOptionId: "sixty-min-delivery",
          cartVersion: 3,
          deliveryAddressId: "addr-1",
          lineItems: [],
        },
      ],
      deliveryAddressId: "addr-1",
      storeContexts: [],
    };

    let message = "";
    try {
      await api.commitCartUpdate(snapshot);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Cart update failed/);
    expect(message).not.toMatch(/leaked-secret-token|AUTH_DENIED/);
  });

  it("sends the update as JSON, not form-urlencoded", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      data: { carts: [{ item: { id: "cart-1", cartVersion: 4, serviceOptionId: "sixty-min-delivery", deliveryAddressId: "addr-1", lineItems: [] } }] },
    });
    const api = new CheckersAPI(fakeTokens());
    await api.commitCartUpdate({
      carts: [{ cartId: "cart-1", serviceOptionId: "sixty-min-delivery", cartVersion: 3, deliveryAddressId: "addr-1", lineItems: [] }],
      deliveryAddressId: "addr-1",
      storeContexts: [],
    });
    const [, , opts] = requestMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(opts.json).toBeDefined();
    expect(opts.form).toBeUndefined();
    expect(opts.retry).toBe("never");
  });
});
