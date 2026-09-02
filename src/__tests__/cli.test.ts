import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const entry = join(repoRoot, "src", "cli.ts");
// A path that does not exist → the CLI is reliably "logged out".
const NO_CREDS = join(tmpdir(), `checkers60-nonexistent-${process.pid}.json`);

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      tsxBin,
      [entry, ...args],
      {
        env: {
          ...process.env,
          NO_COLOR: "1",
          CHECKERS60_CREDS_PATH: NO_CREDS,
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 0;
        resolve({ stdout, stderr, code });
      }
    );
  });
}

describe("CLI JSON mode — commander + error envelopes", () => {
  it("status --json prints valid JSON and exits 0", async () => {
    const r = await runCli(["status", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty("loggedIn");
  });

  it("unknown command under --json emits ONE JSON envelope with exit 2", async () => {
    const r = await runCli(["bogus-cmd", "--json"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.code).toBe(2);
    expect(typeof parsed.error).toBe("string");
    // Buffered commander help/usage text must not leak to stdout.
    expect(r.stdout).not.toContain("Usage:");
    // Exactly one line of JSON output.
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("missing required argument under --json emits a JSON envelope with exit 2", async () => {
    const r = await runCli(["otp-verify", "--json"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.code).toBe(2);
    expect(parsed.error).toMatch(/reference/i);
  });

  it("unknown command WITHOUT --json prints human error to stderr, exit 2", async () => {
    const r = await runCli(["bogus-cmd"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown command");
  });

  it("--help still prints normally in JSON mode and exits 0", async () => {
    const r = await runCli(["--help", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  it("--version still prints normally in JSON mode and exits 0", async () => {
    const r = await runCli(["--version", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("CHECKERS60_JSON env enables JSON mode without the flag", async () => {
    const r = await runCli(["status"], { CHECKERS60_JSON: "1" });
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it("an auth failure (not logged in) is a JSON envelope with exit 3", async () => {
    const r = await runCli(["cart", "--json"]);
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.code).toBe(3);
    // No response body / secret ever appears in the error field.
    expect(parsed.error).not.toMatch(/token|refresh/i);
  });

  it("logout --json emits {\"cleared\":false} and NO human text when logged out", async () => {
    // A fresh, never-created path — and logout skips initRuntime, so nothing
    // writes a device_id here first. The file genuinely does not exist.
    const dir = mkdtempSync(join(tmpdir(), "checkers60-loggedout-"));
    const freshPath = join(dir, "checkers60.json");
    try {
      const r = await runCli(["logout", "--json"], { CHECKERS60_CREDS_PATH: freshPath });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('{"cleared":false}');
      // Exactly one JSON line; no chalk/human strings leak to stdout.
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
      expect(r.stdout).not.toMatch(/Logged out|No saved tokens/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logout succeeds on a CORRUPT creds file (initRuntime skipped) and strips secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkers60-logout-"));
    const corruptPath = join(dir, "checkers60.json");
    // Corrupt (unparseable) creds carrying a secret; also no device_id, so if
    // initRuntime ran it would throw CredentialsCorruptError and block logout.
    writeFileSync(corruptPath, '{ "refresh_token": "supersecret" bad json');
    try {
      const r = await runCli(["logout", "--json"], {
        CHECKERS60_CREDS_PATH: corruptPath,
      });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('{"cleared":true}');
      // The secret must be gone from disk; file is valid JSON again.
      const after = readFileSync(corruptPath, "utf8");
      expect(after).not.toContain("supersecret");
      expect(() => JSON.parse(after)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}, 30000);
