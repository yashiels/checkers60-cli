import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const requestMock = vi.fn();
vi.mock("../lib/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/http.js")>();
  return { ...actual, request: (...args: unknown[]) => requestMock(...args) };
});

import { CheckersAPI } from "../lib/api.js";
import type { TokenManager } from "../lib/credentials.js";
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

function fakeTokens(): TokenManager {
  return { getUserToken: vi.fn().mockResolvedValue("user-tok") } as unknown as TokenManager;
}

describe("CheckersAPI.updateCart error message", () => {
  it("throws a body-free error that never leaks the API payload", async () => {
    // The response has no `carts`, but DOES carry a secret-looking payload that
    // must NEVER be interpolated into the thrown error.
    requestMock.mockResolvedValue({
      data: { errorCode: "AUTH_DENIED", token: "leaked-secret-token" },
    });

    const api = new CheckersAPI(fakeTokens());
    await expect(
      api.updateCart("cart-1", [{ productId: "p", quantity: 1, price: 100 }])
    ).rejects.toThrow(/^Cart update failed$/);

    // Confirm the raw payload is absent from the message.
    let message = "";
    try {
      await api.updateCart("cart-1", [{ productId: "p", quantity: 1, price: 100 }]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("Cart update failed");
    expect(message).not.toMatch(/leaked-secret-token|AUTH_DENIED|[{}]/);
  });
});
