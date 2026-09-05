import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG } from "./config.js";

/**
 * Confirmation-bound plan artifacts for cart mutations.
 *
 * Cart writes go through the captured whole-cart `/api/v3/carts/update` contract,
 * which has NO server-enforced optimistic concurrency (Oracle ruling r4, RULING B).
 * Safety therefore lives entirely here:
 *
 *   preview  → persist a single-use, hardened artifact holding the COMPLETE cart
 *              snapshot + the intended mutation; print the plan; exit 5.
 *   confirm  → load + hash-verify + account-bind + TTL-check the artifact, re-read
 *              live carts, refuse (exit 5) unless every cartVersion and every
 *              mutation-relevant field still matches, atomically CLAIM the artifact
 *              (single use), then let the caller build the write from the FRESH
 *              snapshot and reconcile afterwards.
 *
 * This is explicitly NON-atomic / last-writer-wins: a competing writer between the
 * guard read and the POST can still cause a lost update. That residual race matches
 * the app's own behavior, the domain is a reversible personal cart, and no purchase
 * is made. It MUST NOT be generalized to addresses, modes, checkout, or orders.
 */

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_CANON = "json-sorted-v1";
export const PLAN_TTL_MS = 15 * 60 * 1000;

export type CartOperation = "cart.add" | "cart.remove" | "cart.clear";

/** A single cart, captured verbatim so nothing is silently dropped at write time. */
export interface CartSnapshot {
  cartId: string;
  serviceOptionId: string;
  cartVersion: number;
  deliveryAddressId: string;
  /** Full raw line items, preserved field-for-field (ids, replacementPreferenceId, …). */
  lineItems: Record<string, unknown>[];
}

export interface PlanSnapshot {
  carts: CartSnapshot[];
  deliveryAddressId: string;
  storeContexts: unknown[];
}

export interface MutationIntent {
  operation: CartOperation;
  targetCartId: string;
  targetServiceOptionId: string;
  /** add/remove: the product acted on. */
  productId?: string;
  /** add: quantity delta (>0). remove: quantity delta (>0) or omit for "remove all". */
  quantity?: number;
  /** add only: the fully-formed line to append when the product is not already in the cart. */
  newLine?: Record<string, unknown>;
}

export interface PlanAccount {
  userId: string;
  uuid: string;
  mobileHash: string;
}

export interface Plan {
  schemaVersion: number;
  canon: string;
  planId: string;
  createdAt: number;
  expiresAt: number;
  account: PlanAccount;
  operation: CartOperation;
  snapshot: PlanSnapshot;
  mutation: MutationIntent;
}

/** The identity-bearing subset of a plan — everything the planId hashes over (timestamps included). */
type PlanCore = Pick<
  Plan,
  "schemaVersion" | "canon" | "account" | "operation" | "snapshot" | "mutation" | "createdAt" | "expiresAt"
>;

/**
 * Raised when a `--confirm` cannot proceed because the artifact is missing,
 * corrupt, expired, account-mismatched, or the live cart has diverged from the
 * plan. All of these mean "re-run the preview" → exit 5 (EXIT_CONFIRM).
 */
export class PlanStaleError extends Error {
  readonly isPlanStale = true;
}

// ── Canonical serialization (stable key order, versioned) ───────────────────

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  // Skip undefined-valued keys so the canonical form survives a JSON round-trip
  // (JSON.stringify omits them; a reloaded artifact must hash identically).
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function computePlanId(core: PlanCore): string {
  const hash = createHash("sha256").update(canonicalize(core)).digest("hex");
  return `sha256:${hash}`;
}

export function mobileHash(mobile: string): string {
  return createHash("sha256").update(mobile).digest("hex");
}

// ── Artifact storage ────────────────────────────────────────────────────────

export function plansDir(): string {
  const override = process.env.CHECKERS60_PLANS_DIR;
  if (override) return override;
  return join(dirname(CONFIG.CREDS_PATH), "checkers60-plans");
}

function artifactPath(planId: string): string {
  // planId is "sha256:<64 hex>"; make it a safe, collision-free filename.
  const safe = planId.replace(/[^a-z0-9]/gi, "_");
  return join(plansDir(), `${safe}.json`);
}

const currentUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

/**
 * Validate the plans directory: a real directory, owned by the current user, with
 * no group/other permission bits. Refuses (rather than trusts) a tampered dir —
 * important because CHECKERS60_PLANS_DIR can point anywhere.
 */
function validateDir(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return; // does not exist yet — ensureDir creates it 0700
  }
  if (!st.isDirectory()) {
    throw new PlanStaleError("Plans directory is not a directory. Refusing.");
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new PlanStaleError("Plans directory is not owned by the current user. Refusing.");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new PlanStaleError("Plans directory has unsafe permissions. Refusing.");
  }
}

function ensureDir(): string {
  const dir = plansDir();
  validateDir(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  validateDir(dir);
  return dir;
}

/** Best-effort sweep of expired/claimed artifacts so the dir doesn't grow unbounded. */
function sweep(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".json") && !name.endsWith(".json.used")) continue;
    const p = join(dir, name);
    try {
      if (name.endsWith(".json.used")) {
        // Reap used markers older than the TTL window.
        if (now - statSync(p).mtimeMs > PLAN_TTL_MS) unlinkSync(p);
        continue;
      }
      const plan = JSON.parse(readFileSync(p, "utf8")) as Plan;
      if (typeof plan.expiresAt !== "number" || plan.expiresAt < now) unlinkSync(p);
    } catch {
      // Corrupt/racing entry — ignore.
    }
  }
}

/**
 * Build, hash, and atomically persist a plan artifact (0600, no-overwrite).
 * Returns the finished plan (with planId/timestamps).
 */
export function writePlan(
  account: PlanAccount,
  operation: CartOperation,
  snapshot: PlanSnapshot,
  mutation: MutationIntent
): Plan {
  const dir = ensureDir();
  sweep(dir);

  // Timestamps are part of the hashed identity, so the planId, the stored expiry,
  // and the displayed expiry can never disagree.
  const now = Date.now();
  const core: PlanCore = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    canon: PLAN_CANON,
    account,
    operation,
    snapshot,
    mutation,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
  };
  const planId = computePlanId(core);
  const plan: Plan = { ...core, planId };

  const path = artifactPath(planId);
  const data = `${JSON.stringify(plan)}\n`;
  let fd: number;
  try {
    // wx = O_CREAT|O_EXCL: fails (never follows a symlink) if the path exists; mode 0600.
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Astronomically unlikely now that timestamps are hashed, but never return an
      // unstored plan: load and return the artifact that actually exists on disk.
      return loadPlan(planId, account);
    }
    throw err;
  }
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return plan;
}

/**
 * Load + fully validate an artifact for `--confirm`. Any failure is a
 * {@link PlanStaleError} ("re-run preview") — never a silent proceed.
 */
export function loadPlan(planId: string, account: PlanAccount): Plan {
  if (!/^sha256:[a-f0-9]{64}$/.test(planId)) {
    throw new PlanStaleError("Invalid plan id. Run the preview again.");
  }
  validateDir(plansDir());
  const path = artifactPath(planId);

  // Open with O_NOFOLLOW and validate/read through the SAME descriptor, so the
  // inode we check is the inode we read (no stat→read pathname TOCTOU).
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new PlanStaleError("Plan not found (missing, already used, or expired). Run the preview again.");
  }
  let raw: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new PlanStaleError("Plan artifact is not a regular file. Run the preview again.");
    }
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      throw new PlanStaleError("Plan artifact is not owned by the current user. Refusing.");
    }
    if ((st.mode & 0o077) !== 0) {
      throw new PlanStaleError("Plan artifact has unsafe permissions. Refusing.");
    }
    raw = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }

  let plan: Plan;
  try {
    plan = JSON.parse(raw) as Plan;
  } catch {
    throw new PlanStaleError("Plan artifact is corrupt. Run the preview again.");
  }

  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.canon !== PLAN_CANON) {
    throw new PlanStaleError("Plan artifact is from an incompatible version. Run the preview again.");
  }
  // Hash-verify: recompute the id from the stored content (timestamps included) and require an exact match.
  const recomputed = computePlanId({
    schemaVersion: plan.schemaVersion,
    canon: plan.canon,
    account: plan.account,
    operation: plan.operation,
    snapshot: plan.snapshot,
    mutation: plan.mutation,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  });
  if (recomputed !== plan.planId || plan.planId !== planId) {
    throw new PlanStaleError("Plan artifact failed integrity verification. Run the preview again.");
  }
  if (typeof plan.expiresAt !== "number" || plan.expiresAt < Date.now()) {
    throw new PlanStaleError("Plan has expired. Run the preview again.");
  }
  if (
    plan.account.userId !== account.userId ||
    plan.account.uuid !== account.uuid ||
    plan.account.mobileHash !== account.mobileHash
  ) {
    throw new PlanStaleError("Plan belongs to a different account. Refusing.");
  }
  return plan;
}

/**
 * Atomically claim an artifact for single use: rename `<id>.json` → `<id>.json.used`.
 * If the rename fails (already claimed / removed), the caller MUST NOT execute.
 * Must be called AFTER {@link loadPlan} succeeds and BEFORE dispatching the write.
 */
export function claimPlan(planId: string): void {
  const path = artifactPath(planId);
  try {
    renameSync(path, `${path}.used`);
  } catch {
    throw new PlanStaleError("Plan was already used or removed. Run the preview again.");
  }
}

/**
 * Acquire an account-scoped local lock so two concurrent `--confirm`s can't
 * both validate-and-execute. Returns a release function.
 */
export async function acquireConfirmLock(): Promise<() => Promise<void>> {
  const dir = ensureDir();
  const lockTarget = join(dir, ".confirm.lock");
  // proper-lockfile needs the target to exist.
  try {
    closeSync(openSync(lockTarget, "wx", 0o600));
  } catch {
    /* already exists */
  }
  const release = await lockfile.lock(lockTarget, {
    retries: { retries: 5, factor: 2, minTimeout: 50, maxTimeout: 500 },
    stale: 30_000,
  });
  return release;
}
