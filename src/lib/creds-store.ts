import { randomBytes } from "node:crypto";
import { openSync, fsyncSync, closeSync, renameSync, existsSync } from "node:fs";
import {
  open,
  mkdir,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG } from "./config.js";

/**
 * Shape of the on-disk credentials file
 * (~/.openclaw/credentials/checkers60.json). This is the canonical definition;
 * `credentials.ts` re-exports it for backwards compatibility.
 */
export interface CredentialsFile {
  bff_token?: string | null;
  bff_expiry?: number;
  user_token?: string | null;
  refresh_token?: string | null;
  user_expiry?: number;
  mobile?: string;
  customer_id?: string;
  sixty60_user_id?: string;
  profile_token?: string;
  device_id?: string;
  updated_at?: string;
}

const DEFAULT_TX_DEADLINE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** Heartbeat interval — well under `stale` so a live tx keeps its lock fresh. */
const LOCK_UPDATE_MS = 10_000;
/** `stale` must sit strictly above the deadline so a runaway tx cannot renew past it. */
const STALE_MARGIN_MS = 15_000;

function txDeadlineMs(): number {
  const raw = process.env.CHECKERS60_TX_DEADLINE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TX_DEADLINE_MS;
}

function lockTimeoutMs(): number {
  const raw = process.env.CHECKERS60_LOCK_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_TIMEOUT_MS;
}

/** Regex matching this store's own temp files: `.<basename>.tmp.<pid>.<rand>`. */
function orphanPattern(path: string): RegExp {
  const base = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${base}\\.tmp\\.\\d+\\.[0-9a-f]+$`);
}

function tempName(path: string): string {
  return `.${basename(path)}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
}

async function ensureCredsDir(path: string): Promise<string> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function bestEffortFsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort — not all platforms support it.
  }
}

/**
 * Atomically write JSON to `path`:
 *  - create the temp file IN the destination dir with `open(tmp, "wx", 0o600)`
 *    (mode at creation — never write-then-chmod, which briefly exposes secrets
 *    under a permissive umask),
 *  - write, `fsync` the fd,
 *  - run the optional synchronous commit `gate` (no `await` before `rename`),
 *  - `renameSync` into place, best-effort `fsync` the parent dir,
 *  - on any failure best-effort `unlink` the temp.
 *
 * A crash between temp-create and rename can leave an orphan; it is acceptable
 * because it is mode `0600` (never exposes secrets) and a later {@link sweepOrphans}
 * removes it.
 */
export async function atomicWriteJson(
  path: string,
  data: CredentialsFile,
  gate?: () => void
): Promise<void> {
  const dir = await ensureCredsDir(path);
  const tmp = join(dir, tempName(path));
  const json = `${JSON.stringify(data, null, 2)}\n`;

  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmp, "wx", 0o600);
    await fh.writeFile(json, "utf8");
    await fh.sync();
    await fh.close();
    fh = undefined;
    // Commit gate: synchronous check with NO await before renameSync, closing
    // the theft-to-write race so a timed-out/stolen tx can never commit.
    if (gate) gate();
    renameSync(tmp, path);
  } catch (err) {
    if (fh) {
      try {
        await fh.close();
      } catch {
        // ignore
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // best-effort temp cleanup
    }
    throw err;
  }

  bestEffortFsyncDir(dir);
}

export class CredentialsCorruptError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Credentials file is corrupt and cannot be parsed: ${basename(path)}`);
    this.name = "CredentialsCorruptError";
    this.cause = cause;
  }
}

export class TransactionAbortedError extends Error {
  constructor(reason: string) {
    super(`Credential transaction aborted: ${reason}`);
    this.name = "TransactionAbortedError";
  }
}

/**
 * Read the credentials file. Missing file → `{}`. A parse error is a HARD error
 * (`CredentialsCorruptError`) so a write transaction never treats corruption as
 * `{}` and overwrites recoverable tokens. Read-only callers can pass
 * `lenient: true` to degrade to logged-out on corruption.
 */
export async function readCredentials(
  path: string,
  lenient = false
): Promise<CredentialsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as CredentialsFile;
  } catch (err) {
    if (lenient) return {};
    throw new CredentialsCorruptError(path, err);
  }
}

/**
 * Remove crash-orphan temp files for `path`. MUST be called only while holding
 * the credential lock (writes are serialized, so no other writer has a live
 * temp), and matches ONLY this store's validated pattern
 * `.<basename>.tmp.<pid>.<rand>` — so it can never delete another writer's temp.
 */
async function sweepOrphans(path: string): Promise<void> {
  const dir = dirname(path);
  const pattern = orphanPattern(path);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => pattern.test(name))
      .map((name) =>
        unlink(join(dir, name)).catch(() => {
          // best-effort — another process may have swept it first
        })
      )
  );
}

/** Locked transaction context handed to `withCredentialsLock` callbacks. */
export interface LockedContext {
  /** Fresh read of the on-disk state; hard error on corrupt JSON. */
  read(): Promise<CredentialsFile>;
  /** Merge `patch` onto fresh disk state, atomic-write, return committed state. */
  writePatch(patch: Partial<CredentialsFile>): Promise<CredentialsFile>;
  /** Replace the file wholesale (used by logout to write a device-only file). */
  writeFull(state: CredentialsFile): Promise<CredentialsFile>;
  /** The transaction's abort signal — passed to every in-lock network call. */
  signal: AbortSignal;
}

export interface LockOptions {
  /** Override the transaction deadline (ms). Defaults to CHECKERS60_TX_DEADLINE_MS or 30s. */
  deadlineMs?: number;
}

/**
 * Acquire the credential lock once and run `fn` inside a bounded transaction.
 *
 * A hard `TX_DEADLINE_MS` (default 30s) runs from acquisition through commit; a
 * single deadline timer and `onCompromised` both abort a shared `txAbort`
 * controller and set a `compromised` flag. Every write goes through a synchronous
 * commit gate that rejects if compromised / aborted / past-deadline, with no
 * `await` before the `rename`. Returns whatever `fn` returns; callers that need
 * the committed state have their updaters return it.
 */
export async function withCredentialsLock<T>(
  fn: (ctx: LockedContext) => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const path = CONFIG.CREDS_PATH;
  const deadlineMs = options.deadlineMs ?? txDeadlineMs();
  const staleMs = deadlineMs + STALE_MARGIN_MS;

  // Parent dir must exist BEFORE proper-lockfile creates its `<file>.lock` dir.
  await ensureCredsDir(path);

  let compromised = false;
  const txAbort = new AbortController();

  const release = await lockfile.lock(path, {
    realpath: false,
    stale: staleMs,
    update: LOCK_UPDATE_MS,
    retries: {
      retries: 100,
      factor: 1.5,
      minTimeout: 50,
      maxTimeout: 1_000,
      maxRetryTime: lockTimeoutMs(),
      randomize: true,
    },
    onCompromised: () => {
      // MUST NOT throw — that would surface as an uncaught async rejection.
      compromised = true;
      if (!txAbort.signal.aborted) txAbort.abort();
    },
  });

  const deadlineAt = Date.now() + deadlineMs;
  const deadlineTimer = setTimeout(() => {
    if (!txAbort.signal.aborted) txAbort.abort();
  }, deadlineMs);

  const gate = (): void => {
    if (compromised) throw new TransactionAbortedError("lock compromised");
    if (txAbort.signal.aborted) throw new TransactionAbortedError("aborted");
    if (Date.now() > deadlineAt) throw new TransactionAbortedError("deadline exceeded");
  };

  const ctx: LockedContext = {
    read: () => readCredentials(path),
    writePatch: async (patch) => {
      const disk = await readCredentials(path);
      const next: CredentialsFile = {
        ...disk,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      await atomicWriteJson(path, next, gate);
      return next;
    },
    writeFull: async (state) => {
      const next: CredentialsFile = { ...state, updated_at: new Date().toISOString() };
      await atomicWriteJson(path, next, gate);
      return next;
    },
    signal: txAbort.signal,
  };

  try {
    // Sweep crash orphans while holding the lock, before any temp of ours exists.
    await sweepOrphans(path);
    return await fn(ctx);
  } finally {
    clearTimeout(deadlineTimer);
    await release().catch(() => {
      // lock may already be gone if it was compromised/stolen
    });
  }
}

// ── Field-scoped updaters ──────────────────────────────────────────────────
// Each has a `*Locked(ctx, …)` variant (used inside an existing transaction,
// no re-lock) and a public variant (opens its own `withCredentialsLock`). Each
// merges only its own fields and returns the committed on-disk state.

export interface BffFields {
  bffToken: string | null;
  bffExpiry: number;
}

export function updateBffTokenLocked(
  ctx: LockedContext,
  fields: BffFields
): Promise<CredentialsFile> {
  return ctx.writePatch({ bff_token: fields.bffToken, bff_expiry: fields.bffExpiry });
}

export function updateBffToken(fields: BffFields): Promise<CredentialsFile> {
  return withCredentialsLock((ctx) => updateBffTokenLocked(ctx, fields));
}

export interface UserTokenFields {
  userToken: string | null;
  refreshToken: string | null;
  userExpiry: number;
}

export function updateUserTokensLocked(
  ctx: LockedContext,
  fields: UserTokenFields
): Promise<CredentialsFile> {
  return ctx.writePatch({
    user_token: fields.userToken,
    refresh_token: fields.refreshToken,
    user_expiry: fields.userExpiry,
  });
}

export function updateUserTokens(fields: UserTokenFields): Promise<CredentialsFile> {
  return withCredentialsLock((ctx) => updateUserTokensLocked(ctx, fields));
}

/** OTP verification result: same token triple, persisted as one atomic unit. */
export function updateOtpResultLocked(
  ctx: LockedContext,
  fields: UserTokenFields
): Promise<CredentialsFile> {
  return updateUserTokensLocked(ctx, fields);
}

export function updateOtpResult(fields: UserTokenFields): Promise<CredentialsFile> {
  return withCredentialsLock((ctx) => updateOtpResultLocked(ctx, fields));
}

export interface IdentityFields {
  mobile?: string;
  customer_id?: string;
  sixty60_user_id?: string;
  profile_token?: string;
}

export function updateIdentityLocked(
  ctx: LockedContext,
  fields: IdentityFields
): Promise<CredentialsFile> {
  const patch: Partial<CredentialsFile> = {};
  if (fields.mobile) patch.mobile = fields.mobile;
  if (fields.customer_id) patch.customer_id = fields.customer_id;
  if (fields.sixty60_user_id) patch.sixty60_user_id = fields.sixty60_user_id;
  if (fields.profile_token) patch.profile_token = fields.profile_token;
  return ctx.writePatch(patch);
}

export function updateIdentity(fields: IdentityFields): Promise<CredentialsFile> {
  return withCredentialsLock((ctx) => updateIdentityLocked(ctx, fields));
}

export function updateDeviceIdLocked(
  ctx: LockedContext,
  deviceId: string
): Promise<CredentialsFile> {
  return ctx.writePatch({ device_id: deviceId });
}

export function updateDeviceId(deviceId: string): Promise<CredentialsFile> {
  return withCredentialsLock((ctx) => updateDeviceIdLocked(ctx, deviceId));
}

/**
 * Logout: runs under the lock, deletes token/identity fields but PRESERVES
 * `device_id` (rewrites a device-only file rather than unlinking) so logout does
 * not rotate the installation identity. Returns whether a file existed.
 */
export async function clearCredentialsStore(): Promise<boolean> {
  // File existence MUST be determined independently of parseability: a corrupt
  // file parses to nothing but still holds secrets on disk and must be cleared.
  const existed = existsSync(CONFIG.CREDS_PATH);
  return withCredentialsLock(async (ctx) => {
    // Nothing on disk → nothing to clear; never manufacture an empty creds file.
    if (!existed) return false;
    // Best-effort recover device_id so logout doesn't rotate identity. A corrupt
    // file yields no device_id — but we ALWAYS overwrite, never leave secrets.
    let deviceId: string | undefined;
    try {
      const disk = await readCredentials(CONFIG.CREDS_PATH);
      deviceId = disk.device_id;
    } catch {
      deviceId = undefined;
    }
    const deviceOnly: CredentialsFile = deviceId ? { device_id: deviceId } : {};
    await ctx.writeFull(deviceOnly);
    return true;
  });
}
