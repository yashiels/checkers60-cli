import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../lib/config.js";
import { TokenManager, computeSessionExpiry } from "../lib/credentials.js";
import { CheckersAPI } from "../lib/api.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import { type CredentialsFile } from "../lib/creds-store.js";

let tempDir: string;
let credsPath: string;
const origCredsPath = CONFIG.CREDS_PATH;
const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;
const origMobile = CONFIG.MOBILE;
const origUserId = CONFIG.SIXTY60_USER_ID;
const origUuid = CONFIG.SHOPRITE_UUID;
const realFetch = globalThis.fetch;

const MOBILE = "+27821234567";

function readDisk(): CredentialsFile {
  return JSON.parse(readFileSync(credsPath, "utf8")) as CredentialsFile;
}

function seed(creds: CredentialsFile): void {
  writeFileSync(credsPath, JSON.stringify(creds, null, 2));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: { "content-type": "application/json" },
  });
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
}

/** Build a fetch router for the full verifyOtp flow; captures every request. */
function loginRouter(overrides: { dslCustomerId?: string; verifyExpiresIn?: unknown } = {}) {
  const calls: Captured[] = [];
  const { dslCustomerId = "000C3V55", verifyExpiresIn = 3600 } = overrides;
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = String(input);
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers as Record<string, string>) ?? {},
        body: init.body as string | undefined,
        redirect: (init as { redirect?: string }).redirect,
      });
      if (url.includes("/token/dsl")) {
        return Promise.resolve(json({ access_token: "bff-token", expires_in: 86_400 }));
      }
      if (url.includes("/otp/loginbymobile/verify")) {
        return Promise.resolve(
          json({ response: { accessToken: "sess-1", expiresIn: verifyExpiresIn } })
        );
      }
      if (url.includes("/users/loginbymobile")) {
        return Promise.resolve(json({ response: { reference: "ref-1" } }));
      }
      if (url.includes("/users/verify")) {
        return Promise.resolve(json({ response: { uid: "000C3V55", result: true } }));
      }
      if (url.includes("customer-profile/v2")) {
        return Promise.resolve(json({ userProfile: { id: "internal-user-id" } }));
      }
      if (url.includes("api.shopritegroup.co.za") && url.includes("/users")) {
        return Promise.resolve(
          json({ response: { user: { uuid: "shoprite-uuid", customerId: dslCustomerId } } })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  );
  return { calls, fetchMock };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "auth-test-"));
  credsPath = join(tempDir, "checkers60.json");
  CONFIG.CREDS_PATH = credsPath;
  CONFIG.MOBILE = MOBILE;
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  resetRuntimeForTests();
  await initRuntime();
});

afterEach(() => {
  CONFIG.CREDS_PATH = origCredsPath;
  CONFIG.MOBILE = origMobile;
  CONFIG.SIXTY60_USER_ID = origUserId;
  CONFIG.SHOPRITE_UUID = origUuid;
  if (origEnvDeviceId === undefined) delete process.env.CHECKERS60_DEVICE_ID;
  else process.env.CHECKERS60_DEVICE_ID = origEnvDeviceId;
  resetRuntimeForTests();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("verifyOtp — full session flow", () => {
  it("stores the session bundle from the four sources in ONE atomic commit", async () => {
    const { fetchMock } = loginRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const before = Date.now();
    const tm = new TokenManager();
    await tm.verifyOtp("ref-1", "1234");

    const disk = readDisk();
    expect(disk.session_token).toBe("sess-1"); // (a) OTP verify
    expect(disk.customer_uid).toBe("000C3V55"); // (b) users/verify uid
    expect(disk.sixty60_user_id).toBe("internal-user-id"); // (c) profile id
    expect(disk.shoprite_uuid).toBe("shoprite-uuid"); // (d) DSL /users uuid
    expect(disk.mobile).toBe(MOBILE);
    // Lifetime honored (3600s), never a default.
    expect(disk.session_expiry).toBeGreaterThanOrEqual(before + 3600 * 1000);
    // Legacy DSL fields purged in the same commit.
    expect(disk.user_token ?? null).toBeNull();
    expect(disk.refresh_token ?? null).toBeNull();
    expect(disk.user_expiry).toBeUndefined();
    // In-memory snapshot adopts the commit.
    expect(tm.sessionToken).toBe("sess-1");
    expect(tm.isAuthenticated()).toBe(true);
  });

  it("ABORTS the commit (no partial write) on a customerId cross-check mismatch", async () => {
    const { fetchMock } = loginRouter({ dslCustomerId: "DIFFERENT" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tm = new TokenManager();
    await expect(tm.verifyOtp("ref-1", "1234")).rejects.toThrow(/mismatch/i);
    // No creds file was written (nothing but possibly the bff token) — no session.
    const disk = (() => {
      try {
        return readDisk();
      } catch {
        return {} as CredentialsFile;
      }
    })();
    expect(disk.session_token ?? null).toBeNull();
    expect(disk.sixty60_user_id).toBeUndefined();
  });

  it("uses the exact per-endpoint BFF header matrix with no cross-leak", async () => {
    const { calls, fetchMock } = loginRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await new TokenManager().verifyOtp("ref-1", "1234");

    const find = (needle: string) => calls.find((c) => c.url.includes(needle))!;

    const tokenDsl = find("/token/dsl");
    expect(tokenDsl.headers["content-length"]).toBe("0");
    expect(tokenDsl.headers.authorization).toBeUndefined();
    expect(tokenDsl.headers["x-api-key"]).toBeUndefined();

    const otpVerify = find("/otp/loginbymobile/verify");
    expect(otpVerify.headers.authorization).toBe("Bearer bff-token");
    expect(otpVerify.headers.mobilenumber).toBeUndefined();
    expect(otpVerify.headers["x-api-key"]).toBeUndefined();

    const usersVerify = find("/users/verify");
    expect(usersVerify.headers.authorization).toBe("Bearer bff-token");
    expect(usersVerify.headers.mobilenumber).toBe(MOBILE);
    expect(usersVerify.headers["channel-os"]).toBe(CONFIG.APP_VERSION);
    expect(usersVerify.headers["x-api-key"]).toBeUndefined();

    const profile = find("customer-profile/v2");
    expect(profile.headers.authorization).toBe(`Bearer ${CONFIG.PROFILE_TOKEN}`);
    expect(profile.headers.mobilenumber).toBeUndefined();
    expect(profile.headers["x-api-key"]).toBeUndefined();
    expect(profile.redirect).toBe("manual");

    const dslUsers = find("api.shopritegroup.co.za");
    expect(dslUsers.headers.access_token).toBe("sess-1");
    expect(dslUsers.headers["x-api-key"]).toBe(CONFIG.X_API_KEY_USER);
    expect(dslUsers.headers.authorization).toBeUndefined();
    expect(dslUsers.headers.mobilenumber).toBeUndefined();
  });
});

describe("verifyOtp — expiry validation (reject before commit, no default)", () => {
  it.each([
    ["malformed string", "abc"],
    ["zero", 0],
    ["negative", -5],
    ["at the skew boundary (<=60)", 60],
    ["overflow", Number.MAX_SAFE_INTEGER],
    ["non-finite", Infinity],
    ["NaN", NaN],
  ])("fails login with NO commit on %s", async (_label, expiresIn) => {
    const { fetchMock } = loginRouter({ verifyExpiresIn: expiresIn });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tm = new TokenManager();
    await expect(tm.verifyOtp("ref-1", "1234")).rejects.toThrow(/Login failed/);
    const disk = (() => {
      try {
        return readDisk();
      } catch {
        return {} as CredentialsFile;
      }
    })();
    expect(disk.session_token ?? null).toBeNull();
  });
});

describe("computeSessionExpiry", () => {
  it("accepts a finite lifetime > 60s and returns an absolute ms timestamp", () => {
    expect(computeSessionExpiry(3600, 1_000)).toBe(1_000 + 3600 * 1000);
  });
  it.each([
    ["non-number", "3600"],
    ["zero", 0],
    ["negative", -1],
    ["<=60", 60],
    ["Infinity", Infinity],
    ["NaN", NaN],
    ["overflow", Number.MAX_SAFE_INTEGER],
  ])("throws on %s", (_label, value) => {
    expect(() => computeSessionExpiry(value)).toThrow();
  });
});

describe("SessionContext drives headers AND search body (never CONFIG)", () => {
  it("feeds userid header and userContext.userId body from the disk session", async () => {
    seed({
      session_token: "sess-1",
      session_expiry: Date.now() + 3_600_000,
      sixty60_user_id: "user-XYZ",
      shoprite_uuid: "uuid-XYZ",
      customer_uid: "000C3V55",
      mobile: MOBILE,
    });
    // Poison the mutable CONFIG identity: it must NOT leak into the request.
    CONFIG.SIXTY60_USER_ID = "WRONG-CONFIG-ID";
    CONFIG.SHOPRITE_UUID = "WRONG-CONFIG-UUID";

    let captured: Captured | undefined;
    globalThis.fetch = vi.fn(
      (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
        captured = {
          url: String(input),
          method: init.method ?? "GET",
          headers: (init.headers as Record<string, string>) ?? {},
          body: init.body as string | undefined,
        };
        return Promise.resolve(json({ products: [], totalCount: 0 }));
      }
    ) as unknown as typeof fetch;

    await new CheckersAPI().searchProducts("milk");

    expect(captured).toBeDefined();
    const headers = captured!.headers;
    expect(headers.userid).toBe("user-XYZ");
    expect(headers["customer-id"]).toBe("uuid-XYZ");
    // Cross-leak guards: no BFF-only headers on the catalog request.
    expect(headers.mobilenumber).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();

    const body = JSON.parse(captured!.body ?? "{}");
    expect(body.userContext.userId).toBe("user-XYZ");
  });
});

describe("orders-api header matrix (no mobilenumber / x-api-key leak)", () => {
  it("sends session bearer + identity + store headers, and never BFF-only headers", async () => {
    seed({
      session_token: "sess-1",
      session_expiry: Date.now() + 3_600_000,
      sixty60_user_id: "user-XYZ",
      shoprite_uuid: "uuid-XYZ",
      customer_uid: "000C3V55",
      mobile: MOBILE,
    });
    let captured: Captured | undefined;
    globalThis.fetch = vi.fn(
      (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
        captured = {
          url: String(input),
          method: init.method ?? "GET",
          headers: (init.headers as Record<string, string>) ?? {},
        };
        return Promise.resolve(json({ orderGroups: [] }));
      }
    ) as unknown as typeof fetch;

    await new CheckersAPI().getOrders();
    const h = captured!.headers;
    expect(h.authorization).toBe("Bearer sess-1");
    expect(h.userid).toBe("user-XYZ");
    expect(h["customer-id"]).toBe("uuid-XYZ");
    expect(typeof h.storeids).toBe("string");
    expect(h.mobilenumber).toBeUndefined();
    expect(h.email).toBeUndefined();
    expect(h["x-api-key"]).toBeUndefined();
  });
});

describe("a 401 does NOT wipe the stored session", () => {
  it("surfaces the auth error but leaves the session token on disk", async () => {
    seed({
      session_token: "sess-1",
      session_expiry: Date.now() + 3_600_000,
      sixty60_user_id: "user-XYZ",
      shoprite_uuid: "uuid-XYZ",
      customer_uid: "000C3V55",
      mobile: MOBILE,
    });
    globalThis.fetch = vi.fn(async () =>
      json({ error: "unauthorized" }, 401)
    ) as unknown as typeof fetch;

    await expect(new CheckersAPI().getOrders()).rejects.toBeInstanceOf(Error);
    // The stored session is untouched — a 401 could be bad headers, not a dead session.
    expect(readDisk().session_token).toBe("sess-1");
  });
});

describe("getBFFToken does not hold the credential lock during its network fetch", () => {
  it("keeps the lock available while /token/dsl is pending", async () => {
    // Deferred /token/dsl response — resolves only when we signal, and signals
    // back the moment the fetch mock is actually entered (fetch unlocked).
    let releaseFetch!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((r) => (releaseFetch = r));
    const entered = new Promise<void>((r) => (markEntered = r));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/token/dsl")) {
        markEntered(); // the first lock has been released; the fetch is in flight
        await gate; // hang until released
        return json({ access_token: "bff-live", expires_in: 86400 });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const tm = new TokenManager();
    const bffPromise = tm.getBFFToken(); // starts the (hanging) fetch, unlocked
    await entered; // guarantee the fetch is pending before racing for the lock

    // While the fetch is pending, an independent credential transaction must
    // still acquire the lock promptly (proving the fetch holds no lock).
    const { withCredentialsLock } = await import("../lib/creds-store.js");
    const lockOk = await Promise.race([
      withCredentialsLock(async () => "acquired"),
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error("lock was blocked by the pending BFF fetch")), 2000)
      ),
    ]);
    expect(lockOk).toBe("acquired");

    releaseFetch();
    await expect(bffPromise).resolves.toBe("bff-live");
    expect(readDisk().bff_token).toBe("bff-live");
  });
});
