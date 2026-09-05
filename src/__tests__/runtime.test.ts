import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../lib/config.js";
import {
  resolveDeviceId,
  initRuntime,
  getDeviceId,
  resetRuntimeForTests,
} from "../lib/runtime.js";
import { TokenManager, clearCredentials } from "../lib/credentials.js";
import { type CredentialsFile } from "../lib/creds-store.js";

let tempDir: string;
let credsPath: string;
const origCredsPath = CONFIG.CREDS_PATH;
const origEnvDeviceId = process.env.CHECKERS60_DEVICE_ID;

function readDisk(): CredentialsFile {
  return JSON.parse(readFileSync(credsPath, "utf8")) as CredentialsFile;
}

function seed(creds: CredentialsFile): void {
  writeFileSync(credsPath, JSON.stringify(creds, null, 2));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "runtime-test-"));
  credsPath = join(tempDir, "checkers60.json");
  CONFIG.CREDS_PATH = credsPath;
  delete process.env.CHECKERS60_DEVICE_ID;
  resetRuntimeForTests();
});

afterEach(() => {
  CONFIG.CREDS_PATH = origCredsPath;
  if (origEnvDeviceId === undefined) delete process.env.CHECKERS60_DEVICE_ID;
  else process.env.CHECKERS60_DEVICE_ID = origEnvDeviceId;
  resetRuntimeForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveDeviceId precedence", () => {
  it("uses CHECKERS60_DEVICE_ID env and does NOT persist it (no creds file created)", async () => {
    process.env.CHECKERS60_DEVICE_ID = "env-fixed-id";
    await expect(resolveDeviceId()).resolves.toBe("env-fixed-id");
    expect(existsSync(credsPath)).toBe(false);
  });

  it("env override does NOT overwrite an already-persisted device_id", async () => {
    seed({ device_id: "persisted-id", user_token: "u" });
    process.env.CHECKERS60_DEVICE_ID = "env-fixed-id";
    await expect(resolveDeviceId()).resolves.toBe("env-fixed-id");
    expect(readDisk().device_id).toBe("persisted-id");
  });

  it("adopts a persisted device_id without generating a new one", async () => {
    seed({ device_id: "disk-id" });
    await expect(resolveDeviceId()).resolves.toBe("disk-id");
    expect(readDisk().device_id).toBe("disk-id");
  });

  it("first run with no env + no persisted id generates, persists, and is STABLE", async () => {
    const first = await resolveDeviceId();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(readDisk().device_id).toBe(first);
    // A second resolution reads the same persisted id (no rotation).
    const second = await resolveDeviceId();
    expect(second).toBe(first);
  });
});

describe("initRuntime + getDeviceId", () => {
  it("getDeviceId throws (fail-fast) before initRuntime resolves it", () => {
    expect(() => getDeviceId()).toThrow(/Runtime not initialized/);
  });

  it("a header builder used before initRuntime throws (fail-fast)", () => {
    const tm = new TokenManager();
    expect(() => tm.bffHeaders("bff-token")).toThrow(/Runtime not initialized/);
  });

  it("after initRuntime, getDeviceId returns the resolved id and header builders use it", async () => {
    const id = await initRuntime();
    expect(getDeviceId()).toBe(id);
    const headers = new TokenManager().bffHeaders("bff-token");
    expect(headers["device-id"]).toBe(id);
  });

  it("initRuntime is idempotent (same id, no rotation)", async () => {
    const a = await initRuntime();
    const b = await initRuntime();
    expect(b).toBe(a);
    expect(readDisk().device_id).toBe(a);
  });
});

describe("logout preserves device_id", () => {
  it("keeps device_id across logout so the install id is stable", async () => {
    const id = await resolveDeviceId();
    seed({ ...readDisk(), user_token: "u", refresh_token: "r" });
    await clearCredentials();
    expect(readDisk().device_id).toBe(id);
    // Re-resolving after logout returns the SAME persisted id.
    resetRuntimeForTests();
    await expect(resolveDeviceId()).resolves.toBe(id);
  });
});

describe("cross-process convergence (real child processes)", () => {
  it("two concurrent first-run processes converge to ONE persisted device id", async () => {
    const workerPath = fileURLToPath(new URL("./device-worker.ts", import.meta.url));
    const barrier = Date.now() + 400;

    const run = (): Promise<{ code: number; out: string; err: string }> =>
      new Promise((resolve) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CHECKERS60_CREDS_PATH: credsPath,
          BARRIER_TS: String(barrier),
        };
        delete env.CHECKERS60_DEVICE_ID;
        const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
          env,
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

    const idA = JSON.parse(a.out.trim()).deviceId as string;
    const idB = JSON.parse(b.out.trim()).deviceId as string;
    expect(idA).toMatch(/^[0-9a-f]{16}$/);
    expect(idA).toBe(idB);
    expect(readDisk().device_id).toBe(idA);
  }, 20_000);
});
