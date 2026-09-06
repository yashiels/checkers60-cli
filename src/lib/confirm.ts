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
 * Confirmation-bound plan artifacts.
 *
 * TWO layers live here, with DIFFERENT reuse rules:
 *
 *   1. The ARTIFACT LIFECYCLE — hardened on-disk storage (0600, O_EXCL/O_NOFOLLOW,
 *      owner + permission checks), content-hash integrity, account-binding,
 *      single-use atomic claim, and TTL. This layer is DOMAIN-AGNOSTIC and MAY be
 *      reused by any future confirmation-gated write (favourites, lists, slots, …):
 *      a caller supplies an `operation` + a domain payload and gets back a
 *      single-use plan artifact. Favourites already ride this layer via the generic
 *      `payload`+`preconditions` envelope.
 *
 *   2. The CART SNAPSHOT / RECONCILE LOGIC (whole-cart capture, fingerprint,
 *      per-mode reconcile) lives in cart-mutate.ts and is NOT reusable. It exists
 *      only because the captured `/api/v3/carts/update` contract has NO
 *      server-enforced optimistic concurrency (Oracle ruling r4, RULING B). Each
 *      new domain MUST bring its OWN payload schema and its OWN reconcile — do not
 *      shoehorn cart snapshot semantics onto addresses, modes, checkout, or orders.
 *
 * The cart flow is explicitly NON-atomic / last-writer-wins: a competing writer
 * between the guard read and the POST can still cause a lost update. That residual
 * race matches the app's own behavior, the domain is a reversible personal cart,
 * and no purchase is made. This machinery MUST NEVER gate an IRREVERSIBLE action
 * (place-order / payment): those require a real server-side contract, not this
 * best-effort reconcile.
 */

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_CANON = "json-sorted-v1";
export const PLAN_TTL_MS = 15 * 60 * 1000;
/** Tolerance for a plan whose createdAt is slightly ahead of this clock. */
const CLOCK_SKEW_MS = 60 * 1000;

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

/**
 * A confirmation-bound plan. The envelope (schema/id/timestamps/account/operation)
 * plus the hardened single-use artifact lifecycle are domain-agnostic. Cart plans
 * carry `snapshot`+`mutation`; other domains (e.g. favourites) carry a discriminated
 * `payload`+`preconditions`. Exactly one of the two payload shapes is populated.
 */
export interface Plan {
  schemaVersion: number;
  canon: string;
  planId: string;
  createdAt: number;
  expiresAt: number;
  account: PlanAccount;
  /** Discriminator: "cart.add" | "cart.remove" | "cart.clear" | "fav.add" | "fav.remove" | … */
  operation: string;
  /** Cart-domain payload. */
  snapshot?: PlanSnapshot;
  mutation?: MutationIntent;
  /** Generic-domain resolved write inputs (favourites, lists, …). */
  payload?: Record<string, unknown>;
  /** Generic-domain preconditions re-validated at confirm. */
  preconditions?: Record<string, unknown>;
}

/** The body a caller supplies to {@link writePlan}: exactly one domain shape. */
export interface PlanBody {
  snapshot?: PlanSnapshot;
  mutation?: MutationIntent;
  payload?: Record<string, unknown>;
  preconditions?: Record<string, unknown>;
}

/** The identity-bearing subset of a plan — everything the planId hashes over (timestamps included). */
type PlanCore = Pick<
  Plan,
  | "schemaVersion"
  | "canon"
  | "account"
  | "operation"
  | "snapshot"
  | "mutation"
  | "payload"
  | "preconditions"
  | "createdAt"
  | "expiresAt"
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

// ── Domain shape (single-domain enforcement) ────────────────────────────────

type PlanDomain = "cart" | "generic";

/** Envelope keys every plan carries, regardless of domain. */
const BASE_PLAN_KEYS = [
  "account",
  "canon",
  "createdAt",
  "expiresAt",
  "operation",
  "planId",
  "schemaVersion",
] as const;
/** Exact key set of a cart plan (sorted). */
const CART_PLAN_KEYS = [...BASE_PLAN_KEYS, "mutation", "snapshot"].sort();
/** Exact key set of a generic plan (sorted). */
const GENERIC_PLAN_KEYS = [...BASE_PLAN_KEYS, "payload", "preconditions"].sort();
/** Exact key set of a cart / generic BODY (the domain payload the caller supplies). */
const CART_BODY_KEYS = ["mutation", "snapshot"];
const GENERIC_BODY_KEYS = ["payload", "preconditions"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function keySetEquals(sortedKeys: string[], allowedSorted: string[]): boolean {
  return (
    sortedKeys.length === allowedSorted.length &&
    sortedKeys.every((k, i) => k === allowedSorted[i])
  );
}

/** Which domain an operation belongs to. `cart.*` ⇒ cart; everything else ⇒ generic. */
function domainForOperation(operation: string): PlanDomain {
  return operation.startsWith("cart.") ? "cart" : "generic";
}

/**
 * Classify a caller-supplied body into exactly one domain, rejecting a
 * mixed/incomplete/unknown-key shape. A cart body carries ONLY snapshot+mutation
 * (both plain objects); a generic body carries ONLY payload+preconditions. Anything
 * else is a {@link PlanStaleError}.
 */
function classifyBody(body: PlanBody): PlanDomain {
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  if (keySetEquals(keys, CART_BODY_KEYS)) {
    if (!isPlainObject(body.snapshot) || !isPlainObject(body.mutation)) {
      throw new PlanStaleError("Cart plan body has an invalid snapshot/mutation.");
    }
    return "cart";
  }
  if (keySetEquals(keys, GENERIC_BODY_KEYS)) {
    if (!isPlainObject(body.payload) || !isPlainObject(body.preconditions)) {
      throw new PlanStaleError("Generic plan body has an invalid payload/preconditions.");
    }
    return "generic";
  }
  throw new PlanStaleError("Plan body must be exactly one domain shape (cart or generic).");
}

/** Clamp a caller-supplied max-age to (0, PLAN_TTL_MS]; undefined → the full TTL. */
function clampTtl(maxAgeMs?: number): number {
  if (maxAgeMs === undefined) return PLAN_TTL_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new PlanStaleError("Invalid plan max-age. Refusing.");
  }
  return Math.min(maxAgeMs, PLAN_TTL_MS);
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
  operation: string,
  body: PlanBody,
  opts: { maxAgeMs?: number } = {}
): Plan {
  // Reject a mixed/incomplete domain shape BEFORE anything is persisted, and bind
  // the payload domain to the operation (a cart.* op can never carry a generic
  // payload, and vice versa).
  if (classifyBody(body) !== domainForOperation(operation)) {
    throw new PlanStaleError("Plan operation does not match its payload domain.");
  }

  const dir = ensureDir();
  sweep(dir);

  // Payload-size guard: a plan artifact holds resolved inputs, never bulk data.
  if (JSON.stringify(body).length > 256 * 1024) {
    throw new PlanStaleError("Plan payload too large. Refusing.");
  }

  // Timestamps are part of the hashed identity, so the planId, the stored expiry,
  // and the displayed expiry can never disagree. A caller may pin the plan to a
  // shorter life (e.g. below a slot token's expiry), but never longer than the TTL.
  const now = Date.now();
  const core: PlanCore = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    canon: PLAN_CANON,
    account,
    operation,
    snapshot: body.snapshot,
    mutation: body.mutation,
    payload: body.payload,
    preconditions: body.preconditions,
    createdAt: now,
    expiresAt: now + clampTtl(opts.maxAgeMs),
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
      return loadPlan(planId, account, operation);
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
export function loadPlan(
  planId: string,
  account: PlanAccount,
  expectedOperation: string
): Plan {
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

  if (!isPlainObject(plan)) {
    throw new PlanStaleError("Plan artifact has an invalid shape. Run the preview again.");
  }

  // Exact-key-set enforcement: the top-level keys must be EXACTLY a cart plan's or
  // EXACTLY a generic plan's — no more, no less. This rejects unknown/injected
  // top-level fields (which would otherwise be trusted but omitted from the hash)
  // AND any mixed or incomplete domain shape in one check.
  const topKeys = Object.keys(plan).sort();
  const isCart = keySetEquals(topKeys, CART_PLAN_KEYS);
  const isGeneric = keySetEquals(topKeys, GENERIC_PLAN_KEYS);
  if (!isCart && !isGeneric) {
    throw new PlanStaleError("Plan artifact has an unexpected shape. Run the preview again.");
  }

  // Runtime envelope validation BEFORE any nested access — a hand-crafted or
  // corrupt file must never reach domain logic with the wrong shape.
  const okEnvelope =
    typeof plan.schemaVersion === "number" &&
    typeof plan.canon === "string" &&
    typeof plan.operation === "string" &&
    typeof plan.planId === "string" &&
    typeof plan.createdAt === "number" &&
    typeof plan.expiresAt === "number" &&
    plan.account !== null &&
    typeof plan.account === "object" &&
    typeof plan.account.userId === "string" &&
    typeof plan.account.uuid === "string" &&
    typeof plan.account.mobileHash === "string";
  if (!okEnvelope) {
    throw new PlanStaleError("Plan artifact has an invalid shape. Run the preview again.");
  }

  // Domain payload must be well-typed objects, matching the discriminated key set,
  // AND the domain must match the operation (no cart op with a generic payload).
  if (isCart) {
    if (!isPlainObject(plan.snapshot) || !isPlainObject(plan.mutation)) {
      throw new PlanStaleError("Plan artifact has an invalid cart payload. Run the preview again.");
    }
  } else if (!isPlainObject(plan.payload) || !isPlainObject(plan.preconditions)) {
    throw new PlanStaleError("Plan artifact has an invalid payload. Run the preview again.");
  }
  if ((isCart ? "cart" : "generic") !== domainForOperation(plan.operation)) {
    throw new PlanStaleError("Plan operation does not match its payload domain. Run the preview again.");
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
    payload: plan.payload,
    preconditions: plan.preconditions,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  });
  if (recomputed !== plan.planId || plan.planId !== planId) {
    throw new PlanStaleError("Plan artifact failed integrity verification. Run the preview again.");
  }
  // Timestamp ordering/bounds against a single captured `now`: finite, well-ordered,
  // not created in the future (beyond a small clock-skew tolerance — which would let
  // a forged plan outlive the TTL), and never claiming a life longer than the ceiling.
  const now = Date.now();
  if (
    !Number.isFinite(plan.createdAt) ||
    !Number.isFinite(plan.expiresAt) ||
    plan.createdAt <= 0 ||
    plan.createdAt > now + CLOCK_SKEW_MS ||
    plan.createdAt > plan.expiresAt ||
    plan.expiresAt - plan.createdAt > PLAN_TTL_MS
  ) {
    throw new PlanStaleError("Plan has invalid timestamps. Run the preview again.");
  }
  if (plan.expiresAt < now) {
    throw new PlanStaleError("Plan has expired. Run the preview again.");
  }
  // Account binding is checked before the operation mismatch so a plan that isn't
  // yours never reveals which operation it was for.
  if (
    plan.account.userId !== account.userId ||
    plan.account.uuid !== account.uuid ||
    plan.account.mobileHash !== account.mobileHash
  ) {
    throw new PlanStaleError("Plan belongs to a different account. Refusing.");
  }
  // A plan for one operation must never be consumed by another command.
  if (plan.operation !== expectedOperation) {
    throw new PlanStaleError(
      `Plan is for ${plan.operation}, not ${expectedOperation}. Run the preview again.`
    );
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
 * Acquire an account-scoped local lock so two concurrent `--confirm`s for the
 * SAME account can't both validate-and-execute. The lock file is keyed by a hash
 * of the account's userId, so confirms for different accounts use different lock
 * targets and never serialize against each other. Returns a release function.
 */
export async function acquireConfirmLock(
  account: PlanAccount
): Promise<() => Promise<void>> {
  const dir = ensureDir();
  const scope = createHash("sha256").update(account.userId).digest("hex").slice(0, 16);
  const lockTarget = join(dir, `.confirm-${scope}.lock`);
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
