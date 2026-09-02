import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  sweepOrphans,
  withCredentialsLock,
  updateBffToken,
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

describe("sweepOrphans", () => {
  it("removes 0600 crash orphans matching the pattern, leaving other writers' temps", async () => {
    // A crash orphan for THIS store — created via the same 0600 mechanism.
    const orphan = join(tempDir, `.${basename(credsPath)}.tmp.99999.deadbeef`);
    closeSync(openSync(orphan, "wx", 0o600));
    expect(mode(orphan)).toBe(0o600);

    // Another writer's live temp (different basename) must be untouched.
    const otherLive = join(tempDir, ".other.json.tmp.1.abcdef");
    closeSync(openSync(otherLive, "wx", 0o600));

    await sweepOrphans(credsPath);

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
});

describe("TokenManager.getUserToken reconciliation", () => {
  it("adopts a still-valid identical disk token with NO network refresh", async () => {
    seed({
      user_token: "valid-token",
      refresh_token: "refresh-a",
      user_expiry: Date.now() + 3_600_000,
    });
    const fetchMock = vi.fn(() => {
      throw new Error("network must not be called");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tm = new TokenManager();
    await expect(tm.getUserToken()).resolves.toBe("valid-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws logged-out when disk has no refresh token (never resurrects memory)", async () => {
    seed({ user_token: "stale", user_expiry: 0 });
    const tm = new TokenManager();
    // Simulate a stale in-memory refresh token that must NOT be resurrected.
    tm.refreshToken = "ghost-refresh";
    await expect(tm.getUserToken()).rejects.toThrow(/Not logged in/);
  });

  it("keeps the old refresh token when the refresh response omits a new one", async () => {
    seed({
      user_token: "expired",
      refresh_token: "refresh-old",
      user_expiry: 0,
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token/dsl")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "bff", expires_in: 86_400 }), {
            status: 200,
          })
        );
      }
      // Refresh response WITHOUT a refreshToken.
      return Promise.resolve(
        new Response(
          JSON.stringify({ response: { accessToken: "user-new", expiresIn: 3600 } }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tm = new TokenManager();
    await expect(tm.getUserToken()).resolves.toBe("user-new");
    const disk = readDisk();
    expect(disk.refresh_token).toBe("refresh-old");
    expect(disk.user_token).toBe("user-new");
  });

  it("nested getUserToken -> getBFFTokenLocked does not deadlock", async () => {
    seed({
      user_token: "expired",
      refresh_token: "refresh-old",
      user_expiry: 0,
      // No bff token → forces the in-lock getBFFTokenLocked network path.
    });
    let bffCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token/dsl")) {
        bffCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "bff", expires_in: 86_400 }), {
            status: 200,
          })
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            response: { accessToken: "user-new", refreshToken: "refresh-new", expiresIn: 3600 },
          }),
          { status: 200 }
        )
      );
    }) as unknown as typeof fetch;

    const tm = new TokenManager();
    // If the nested lock deadlocked this would hang; the test timeout guards it.
    const token = await tm.getUserToken();
    expect(token).toBe("user-new");
    expect(bffCalls).toBe(1);
    expect(readDisk().bff_token).toBe("bff");
  }, 5000);
});

describe("cross-process locking (real child processes)", () => {
  it("two concurrent refreshers => exactly ONE network refresh, both converge", async () => {
    seed({
      user_token: "expired",
      refresh_token: "refresh-old",
      user_expiry: 0,
    });
    const counterPath = join(tempDir, "refresh-count");
    writeFileSync(counterPath, "");
    const workerPath = fileURLToPath(new URL("./refresh-worker.ts", import.meta.url));
    const barrier = Date.now() + 400;

    const run = (): Promise<{ code: number; out: string; err: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
          env: {
            ...process.env,
            CHECKERS60_CREDS_PATH: credsPath,
            CHECKERS60_DEVICE_ID: "test-device-id",
            WORKER_COUNTER: counterPath,
            BARRIER_TS: String(barrier),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code: code ?? 0, out, err }));
      });

    const [a, b] = await Promise.all([run(), run()]);

    expect(a.code, `worker A failed: ${a.err}`).toBe(0);
    expect(b.code, `worker B failed: ${b.err}`).toBe(0);

    const refreshCount = readFileSync(counterPath, "utf8").length;
    expect(refreshCount).toBe(1);

    const disk = readDisk();
    expect(disk.user_token).toBe("user-new");
    expect(disk.refresh_token).toBe("refresh-new");

    const resA = JSON.parse(a.out.trim());
    const resB = JSON.parse(b.out.trim());
    expect(resA.token).toBe("user-new");
    expect(resB.token).toBe("user-new");
    expect(resA.refreshToken).toBe("refresh-new");
    expect(resB.refreshToken).toBe("refresh-new");
  }, 20_000);
});
