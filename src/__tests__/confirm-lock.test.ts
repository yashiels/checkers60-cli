import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireConfirmLock, plansDir } from "../lib/confirm.js";
import type { PlanAccount } from "../lib/confirm.js";

const acct = (userId: string): PlanAccount => ({
  userId,
  uuid: `uuid-${userId}`,
  mobileHash: `hash-${userId}`,
});

const scope = (userId: string) =>
  createHash("sha256").update(userId).digest("hex").slice(0, 16);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "c60-lock-"));
  process.env.CHECKERS60_PLANS_DIR = tmp;
});

afterEach(() => {
  delete process.env.CHECKERS60_PLANS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

const lockFiles = () => readdirSync(plansDir()).filter((n) => n.endsWith(".lock"));

describe("acquireConfirmLock is account-scoped (keyed by userId hash)", () => {
  it("uses a lock target keyed by the account userId", async () => {
    const release = await acquireConfirmLock(acct("USER-A"));
    try {
      expect(lockFiles()).toContain(`.confirm-${scope("USER-A")}.lock`);
    } finally {
      await release();
    }
  });

  it("different accounts use different lock targets", async () => {
    const relA = await acquireConfirmLock(acct("USER-A"));
    // A different account acquires concurrently — different target, no contention.
    const relB = await acquireConfirmLock(acct("USER-B"));
    try {
      const files = lockFiles();
      expect(files).toContain(`.confirm-${scope("USER-A")}.lock`);
      expect(files).toContain(`.confirm-${scope("USER-B")}.lock`);
      expect(scope("USER-A")).not.toBe(scope("USER-B"));
    } finally {
      await relA();
      await relB();
    }
  });

  it("the SAME account serializes (a second acquire is refused while held)", async () => {
    const relA = await acquireConfirmLock(acct("USER-A"));
    try {
      await expect(acquireConfirmLock(acct("USER-A"))).rejects.toThrow();
    } finally {
      await relA();
    }
    // Once released, the same account can lock again.
    const relA2 = await acquireConfirmLock(acct("USER-A"));
    await relA2();
  });
});
