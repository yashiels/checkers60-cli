import { randomBytes } from "node:crypto";
import { CONFIG } from "./config.js";
import {
  readCredentials,
  withCredentialsLock,
  updateDeviceIdLocked,
} from "./creds-store.js";

/**
 * Per-install device id + awaited runtime initialization (§3.4).
 *
 * The device id is resolved ONCE, before any header/API-client construction, and
 * cached in module state. Header builders read it through {@link getDeviceId},
 * which throws if {@link initRuntime} has not run — fail-fast rather than
 * silently sending a shared hardcoded default.
 *
 * Precedence: `CHECKERS60_DEVICE_ID` env → persisted `device_id` → generate
 * `randomBytes(8).hex` once and persist. The env override is used for the session
 * but is NEVER persisted (it does not overwrite a persisted id). Generation is
 * serialized by the credential lock so two first-run processes converge to ONE
 * id; the common path (env set, or already persisted) stays read-only.
 */

let resolvedDeviceId: string | undefined;
let initInFlight: Promise<string> | undefined;

/**
 * Resolve the per-install device id by precedence. Read-only on the common path;
 * only a true first run (no env, no persisted id) takes the write lock.
 */
export async function resolveDeviceId(): Promise<string> {
  const envId = process.env.CHECKERS60_DEVICE_ID;
  if (envId) return envId;

  // Read-only fast path: adopt an already-persisted id without locking.
  const disk = await readCredentials(CONFIG.CREDS_PATH, true).catch(
    () => ({}) as Awaited<ReturnType<typeof readCredentials>>
  );
  if (disk.device_id) return disk.device_id;

  // First run: generate under the lock. Double-check inside the lock so a
  // concurrent first-run process that persisted first wins, and both converge.
  return withCredentialsLock(async (ctx) => {
    const fresh = await ctx.read();
    if (fresh.device_id) return fresh.device_id;
    const committed = await updateDeviceIdLocked(ctx, randomBytes(8).toString("hex"));
    if (!committed.device_id) throw new Error("Failed to persist device id");
    return committed.device_id;
  });
}

/**
 * Idempotently resolve the device id and store it in module state. Call once,
 * before any header/API-client construction (a commander `preAction` hook). Safe
 * to call concurrently — a single in-flight resolution is shared.
 */
export function initRuntime(): Promise<string> {
  if (resolvedDeviceId !== undefined) return Promise.resolve(resolvedDeviceId);
  if (!initInFlight) {
    initInFlight = resolveDeviceId()
      .then((id) => {
        resolvedDeviceId = id;
        return id;
      })
      .finally(() => {
        initInFlight = undefined;
      });
  }
  return initInFlight;
}

/**
 * The resolved per-install device id. Throws (fail-fast) if {@link initRuntime}
 * has not resolved it, so no request can ever fall back to a shared default.
 */
export function getDeviceId(): string {
  if (resolvedDeviceId === undefined) {
    throw new Error(
      "Runtime not initialized: initRuntime() must resolve the device id before building request headers"
    );
  }
  return resolvedDeviceId;
}

/** Test-only: reset resolved runtime state so a fresh resolution can be exercised. */
export function resetRuntimeForTests(): void {
  resolvedDeviceId = undefined;
  initInFlight = undefined;
}
