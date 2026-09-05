import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  openSync,
  closeSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { CONFIG } from "../lib/config.js";
import { TokenManager, clearCredentials } from "../lib/credentials.js";
import { initRuntime, resetRuntimeForTests } from "../lib/runtime.js";
import {
  atomicWriteJson,
  withCredentialsLock,
  updateBffToken,
  updateSession,
  readCredentials,
  CredentialsCorruptError,
  TransactionAbortedError,
  type CredentialsFile,
} from "../lib/creds-store.js";

let tempDir: string;
let credsPath: string;
const origCredsPath = CONFIG.CREDS_PATH;
const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;
const realFetch = globalThis.fetch;

function readDisk(): CredentialsFile {
  return JSON.parse(readFileSync(credsPath, "utf8")) as CredentialsFile;
}

function seed(creds: CredentialsFile): void {
  writeFileSync(credsPath, JSON.stringify(creds, null, 2));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "creds-test-"));
  credsPath = join(tempDir, "checkers60.json");
  CONFIG.CREDS_PATH = credsPath;
  // Header builders read the resolved device id via getDeviceId(); pin one via
  // env (session-only, never persisted) so this suite's token flows can run.
  process.env.CHECKERS60_DEVICE_ID = "test-device-id";
  resetRuntimeForTests();
  await initRuntime();
});

afterEach(() => {
  CONFIG.CREDS_PATH = origCredsPath;
  if (origEnvDeviceId === undefined) delete process.env.CHECKERS60_DEVICE_ID;
  else process.env.CHECKERS60_DEVICE_ID = origEnvDeviceId;
  resetRuntimeForTests();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("atomicWriteJson", () => {
  it("writes the file with mode 0600 and creates the dir 0700", async () => {
    const nested = join(tempDir, "sub", "checkers60.json");
    CONFIG.CREDS_PATH = nested;
    await atomicWriteJson(nested, { bff_token: "x" });
    expect(mode(nested)).toBe(0o600);
    expect(mode(dirname(nested))).toBe(0o700);
    expect(existsSync(nested)).toBe(true);
  });

  it("leaves no temp files behind after a successful write", async () => {
    await atomicWriteJson(credsPath, { bff_token: "x" });
    const temps = readdirSync(tempDir).filter((f) => f.includes(".tmp."));
    expect(temps).toHaveLength(0);
  });

  it("cleans up the temp and does not commit when the gate throws", async () => {
    seed({ user_token: "keep" });
    await expect(
      atomicWriteJson(credsPath, { user_token: "new" }, () => {
        throw new Error("gate blocked");
      })
    ).rejects.toThrow("gate blocked");
    expect(readDisk().user_token).toBe("keep");
    const temps = readdirSync(tempDir).filter((f) => f.includes(".tmp."));
    expect(temps).toHaveLength(0);
  });
});

describe("orphan sweep (via withCredentialsLock)", () => {
  it("removes 0600 crash orphans matching the pattern, leaving other writers' temps", async () => {
    // A crash orphan for THIS store — created via the same 0600 mechanism.
    const orphan = join(tempDir, `.${basename(credsPath)}.tmp.99999.deadbeef`);
    closeSync(openSync(orphan, "wx", 0o600));
    expect(mode(orphan)).toBe(0o600);

    // Another writer's live temp (different basename) must be untouched.
    const otherLive = join(tempDir, ".other.json.tmp.1.abcdef");
    closeSync(openSync(otherLive, "wx", 0o600));

    // The sweep is only reachable while the lock is held; a no-op transaction
    // triggers it before any temp of ours exists.
    await withCredentialsLock(async () => undefined);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(otherLive)).toBe(true);
  });
});

describe("field-scoped updaters", () => {
  it("updateBffToken never clobbers user tokens (stale-overwrite scenario)", async () => {
    seed({
      user_token: "user-a",
      refresh_token: "refresh-a",
      user_expiry: Date.now() + 3_600_000,
    });
    await updateBffToken({ bffToken: "bff-new", bffExpiry: Date.now() + 86_400_000 });
    const disk = readDisk();
    expect(disk.bff_token).toBe("bff-new");
    expect(disk.user_token).toBe("user-a");
    expect(disk.refresh_token).toBe("refresh-a");
    expect(mode(credsPath)).toBe(0o600);
  });
});

describe("corruption safety", () => {
  it("throws (does not silently overwrite) on a corrupt file in a write transaction", async () => {
    writeFileSync(credsPath, "{ not json ]");
    await expect(
      updateBffToken({ bffToken: "bff", bffExpiry: 1 })
    ).rejects.toBeInstanceOf(CredentialsCorruptError);
    // File must be left untouched, not overwritten.
    expect(readFileSync(credsPath, "utf8")).toBe("{ not json ]");
  });

  it("readCredentials degrades to {} in lenient mode", async () => {
    writeFileSync(credsPath, "{ not json ]");
    await expect(readCredentials(credsPath, true)).resolves.toEqual({});
  });
});

describe("commit gate / transaction deadline", () => {
  it("rejects a write once the deadline has passed, without committing", async () => {
    seed({ user_token: "keep" });
    await expect(
      withCredentialsLock(
        async (ctx) => {
          await new Promise((r) => setTimeout(r, 60));
          return ctx.writePatch({ user_token: "too-late" });
        },
        { deadlineMs: 10 }
      )
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    expect(readDisk().user_token).toBe("keep");
  });
});

describe("logout", () => {
  it("preserves device_id and drops all token/identity fields", async () => {
    seed({
      device_id: "dev-123",
      user_token: "u",
      refresh_token: "r",
      user_expiry: Date.now() + 1000,
      bff_token: "b",
      mobile: "+27000",
      customer_id: "cust",
      sixty60_user_id: "s60",
    });
    const cleared = await clearCredentials();
    expect(cleared).toBe(true);
    const disk = readDisk();
    expect(disk.device_id).toBe("dev-123");
    expect(disk.user_token).toBeUndefined();
    expect(disk.refresh_token).toBeUndefined();
    expect(disk.bff_token).toBeUndefined();
    expect(disk.mobile).toBeUndefined();
    expect(disk.sixty60_user_id).toBeUndefined();
    expect(mode(credsPath)).toBe(0o600);
  });

  it("clears a CORRUPT file so no secrets remain, and reports cleared=true", async () => {
    // A corrupt file that still holds a secret on disk. It parses to nothing,
    // but logout MUST still overwrite it — never leave the secret behind.
    writeFileSync(
      credsPath,
      '{ "device_id": "dev-xyz", "refresh_token": "secret-refresh" } trailing garbage'
    );
    const cleared = await clearCredentials();
    // File existed, so logout reports cleared=true even though it was unparseable.
    expect(cleared).toBe(true);
    // No secret bytes survive anywhere in the file.
    const raw = readFileSync(credsPath, "utf8");
    expect(raw).not.toContain("secret-refresh");
    // File is valid JSON again with no token/identity fields.
    const disk = readDisk();
    expect(disk.refresh_token).toBeUndefined();
    expect(disk.user_token).toBeUndefined();
    expect(mode(credsPath)).toBe(0o600);
  });

  it("returns false when no creds file exists", async () => {
    rmSync(credsPath, { force: true });
    const cleared = await clearCredentials();
    expect(cleared).toBe(false);
  });
});

describe("updateSession — one atomic commit that purges the DSL model", () => {
  it("writes the whole session bundle AND nulls legacy DSL fields in one patch", async () => {
    // Seed a file carrying the retired DSL token triple that must be purged.
    seed({
      device_id: "dev-1",
      user_token: "old-user",
      refresh_token: "old-refresh",
      user_expiry: Date.now() + 3_600_000,
    });
    const expiry = Date.now() + 3_600_000;
    const committed = await updateSession({
      sessionToken: "sess-1",
      sessionExpiry: expiry,
      userId: "user-id",
      customerId: "000C3V55",
      shopriteUuid: "uuid-1",
      mobile: "+27000",
    });

    // Both the returned state and the on-disk file reflect one atomic commit.
    for (const state of [committed, readDisk()]) {
      expect(state.session_token).toBe("sess-1");
      expect(state.session_expiry).toBe(expiry);
      expect(state.sixty60_user_id).toBe("user-id");
      expect(state.customer_uid).toBe("000C3V55");
      expect(state.shoprite_uuid).toBe("uuid-1");
      expect(state.mobile).toBe("+27000");
      // Legacy DSL fields purged.
      expect(state.user_token ?? null).toBeNull();
      expect(state.refresh_token ?? null).toBeNull();
      expect(state.user_expiry).toBeUndefined();
      // device_id preserved.
      expect(state.device_id).toBe("dev-1");
    }
    expect(mode(credsPath)).toBe(0o600);
  });
});

describe("TokenManager.getSession — disk-authoritative", () => {
  it("returns the committed session snapshot from a single disk read", async () => {
    seed({
      session_token: "sess-1",
      session_expiry: Date.now() + 3_600_000,
      sixty60_user_id: "user-id",
      shoprite_uuid: "uuid-1",
      customer_uid: "000C3V55",
      mobile: "+27000",
    });
    const fetchMock = vi.fn(() => {
      throw new Error("network must not be called");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tm = new TokenManager();
    const session = await tm.getSession();
    expect(session).toEqual({
      sessionToken: "sess-1",
      userId: "user-id",
      uuid: "uuid-1",
      mobile: "+27000",
      customerId: "000C3V55",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws not-logged-in when disk has no session token (never resurrects memory)", async () => {
    seed({
      session_token: "sess-1",
      session_expiry: Date.now() + 3_600_000,
    });
    const tm = new TokenManager(); // adopts a live in-memory session
    // Another process logged out: disk now has no session.
    seed({ device_id: "dev-1" });
    await expect(tm.getSession()).rejects.toThrow(/Not logged in/);
  });

  it("throws not-logged-in on an expired session (60s skew), no refresh", async () => {
    seed({
      session_token: "sess-1",
      // Inside the 60s skew window → treated as expired.
      session_expiry: Date.now() + 30_000,
      sixty60_user_id: "user-id",
      shoprite_uuid: "uuid-1",
    });
    const fetchMock = vi.fn(() => {
      throw new Error("network must not be called (no refresh)");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const tm = new TokenManager();
    await expect(tm.getSession()).rejects.toThrow(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isAuthenticated keys on a valid session token ONLY (legacy DSL never counts)", async () => {
    // Only legacy DSL fields present → NOT authenticated.
    seed({
      user_token: "old",
      refresh_token: "old-refresh",
      user_expiry: Date.now() + 3_600_000,
    });
    expect(new TokenManager().isAuthenticated()).toBe(false);

    // A valid session token → authenticated.
    seed({ session_token: "sess-1", session_expiry: Date.now() + 3_600_000 });
    expect(new TokenManager().isAuthenticated()).toBe(true);
  });
});
