import chalk from "chalk";
import { APIError, CheckersAPI, type Address, type AddressStoreContext } from "./api.js";
import {
  acquireConfirmLock,
  claimPlan,
  loadPlan,
  mobileHash,
  PLAN_CANON,
  PLAN_SCHEMA_VERSION,
  PlanStaleError,
  writePlan,
  type PlanAccount,
  type PlanSnapshot,
} from "./confirm.js";
import { DivergentOutcomeError, EXIT_CONFIRM, UsageError } from "./errors.js";
import { startSpinner } from "./output.js";

/**
 * Confirmation-gated delivery-address SWITCH. Mirrors the preview → `--confirm`
 * → reconcile safety model of cart-mutate.ts, but drives the 4-call address flow
 * (use → store-contexts → update-address → transfer-dummies) instead of the
 * whole-cart `/carts/update` contract. It reuses the generic `payload` +
 * `preconditions` plan envelope (operation `address.use`); it deliberately does
 * NOT route through `runCartMutation`, which is hard-wired to line-item mutation.
 *
 * The switch is reversible (it re-selects a saved address and rotates cart ids;
 * no order is placed), so the same best-effort reconcile posture applies: claim
 * before the first POST, never auto-retry, never continue past a failed call, and
 * decide the outcome AUTHORITATIVELY by re-reading — success only when the target
 * address is active on EVERY cart, the new store context matches, and cart
 * CONTENTS are preserved; partial completion is divergent, not success.
 */

export type AddressOperation = "address.use";

export interface AddressUseOptions {
  json?: boolean;
  confirm?: string;
}

function account(session: { userId: string; uuid: string; mobile: string }): PlanAccount {
  return { userId: session.userId, uuid: session.uuid, mobileHash: mobileHash(session.mobile) };
}

/** The saved address's stable id — matches how orders.ts derives it (`_id` then `identifier`). */
function addressId(a: Address): string {
  if (typeof a._id === "string" && a._id.length > 0) return a._id;
  if (typeof a.identifier === "string" && a.identifier.length > 0) return a.identifier;
  return "";
}

interface ResolvedAddress {
  addressId: string;
  latitude: number;
  longitude: number;
  name: string;
}

/**
 * Locate the target among the account's own saved addresses and read its
 * coordinates. Unknown id → {@link UsageError} (exit 2); a known id with no usable
 * geocode can't resolve store contexts, so it is also a usage error rather than a
 * guessed switch.
 */
function resolveTarget(addresses: Address[], id: string): ResolvedAddress {
  const found = addresses.find((a) => addressId(a) === id);
  if (!found) {
    throw new UsageError(`Address ${id} not found in your saved addresses.`);
  }
  const lat = found.coordinates?.latitude;
  const lng = found.coordinates?.longitude;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    throw new UsageError(`Address ${id} has no usable coordinates. Re-save it in the app first.`);
  }
  return { addressId: id, latitude: lat, longitude: lng, name: typeof found.name === "string" ? found.name : "" };
}

// ── Cart state helpers ───────────────────────────────────────────────────────

/** Two carts sharing a delivery mode make targeting/reconciliation ambiguous. */
function hasDupModes(snapshot: PlanSnapshot): boolean {
  const seen = new Set<string>();
  for (const c of snapshot.carts) {
    if (seen.has(c.serviceOptionId)) return true;
    seen.add(c.serviceOptionId);
  }
  return false;
}

function assertNoDupModes(snapshot: PlanSnapshot): void {
  if (hasDupModes(snapshot)) {
    throw new PlanStaleError(
      "Ambiguous cart state: two carts share a delivery mode. Run the preview again."
    );
  }
}

/**
 * Server-assigned line fields that legitimately change when the switch re-homes a
 * line to a new store — the ONLY keys excluded from content-equivalence. Everything
 * else is business-meaningful and compared by default (a DENYLIST, not a whitelist),
 * so a newly-added meaningful field is caught automatically rather than missed.
 */
const SERVER_LINE_KEYS = new Set([
  "id",
  "storeId",
  "price",
  "previousPrice",
  "priceFactor",
  "cartVersion",
]);

/**
 * True for a server-managed timestamp-shaped key. Covers camelCase (`updatedOn`,
 * `createdAt`, `endTime`), snake_case (`created_at`, `updated_on`, `synced_ts`),
 * any `*timestamp*`, and any `created`/`updated`/`modified` variant — so a
 * server-assigned time field never triggers a spurious divergence.
 */
function isTimestampKey(k: string): boolean {
  return (
    /(?:On|At|Time|Date)$/.test(k) ||
    /_(?:at|on|time|ts)$/i.test(k) ||
    /timestamp/i.test(k) ||
    /(?:created|updated|modified)/i.test(k)
  );
}

/** Stable, key-sorted canonical serialization so field order never affects equality. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/**
 * Canonical signature of a cart line's business-meaningful fields for content-
 * equivalence: EVERY field except the server-assigned ones (ids, prices, factors,
 * versions, timestamps). Comparing the whole line (minus that denylist) means a
 * silently changed OR dropped meaningful field — including one this code has never
 * heard of — reads as divergent, never as success.
 */
function lineSignature(li: Record<string, unknown>): string {
  const meaningful: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(li)) {
    if (SERVER_LINE_KEYS.has(k) || isTimestampKey(k)) continue;
    meaningful[k] = v;
  }
  return canonical(meaningful);
}

/** Per-mode multiset of line signatures (keyed by service option so id rotation is tolerated). */
function contentByMode(snapshot: PlanSnapshot): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of snapshot.carts) {
    const sigs = (out[c.serviceOptionId] ??= []);
    for (const li of c.lineItems) sigs.push(lineSignature(li));
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/** True when both snapshots hold the same line contents per delivery mode. */
function contentEquivalent(a: PlanSnapshot, b: PlanSnapshot): boolean {
  const ca = contentByMode(a);
  const cb = contentByMode(b);
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  for (const k of keys) {
    if (JSON.stringify(ca[k] ?? []) !== JSON.stringify(cb[k] ?? [])) return false;
  }
  return true;
}

/** Every post-switch cart's mode is served by the resolved store contexts. */
function modesCovered(snapshot: PlanSnapshot, contexts: AddressStoreContext[]): boolean {
  const modes = new Set<string>();
  for (const ctx of contexts) {
    for (const m of ctx.serviceOptionIds ?? []) if (typeof m === "string") modes.add(m);
  }
  return snapshot.carts.every((c) => modes.has(c.serviceOptionId));
}

/**
 * Strict drift fingerprint for the pre-write guard: any change to the carts (ids,
 * versions, per-cart address, or ANY meaningful line field) between preview and
 * confirm refuses. Nothing should have rotated yet, so it pins the stable line id
 * AND the full meaningful line signature — a replacement-preference, instruction,
 * or option-selection change between preview and confirm is rejected, not silently
 * carried into the switch.
 */
function driftFingerprint(snapshot: PlanSnapshot): string {
  const carts = snapshot.carts
    .map((c) => ({
      cartId: c.cartId,
      serviceOptionId: c.serviceOptionId,
      cartVersion: c.cartVersion,
      deliveryAddressId: c.deliveryAddressId,
      lines: c.lineItems
        .map((li) => ({ id: li.id, sig: lineSignature(li) }))
        .sort((x, y) => String(x.id).localeCompare(String(y.id))),
    }))
    .sort((x, y) => x.cartId.localeCompare(y.cartId));
  return JSON.stringify({ carts, deliveryAddressId: snapshot.deliveryAddressId });
}

// ── Plan payload validation ──────────────────────────────────────────────────

export interface AddressPayload {
  addressId: string;
  latitude: number;
  longitude: number;
  name?: string;
}

export function readAddressPayload(payload: Record<string, unknown> | undefined): AddressPayload {
  if (
    !payload ||
    typeof payload.addressId !== "string" ||
    typeof payload.latitude !== "number" ||
    typeof payload.longitude !== "number" ||
    !Number.isFinite(payload.latitude) ||
    !Number.isFinite(payload.longitude)
  ) {
    throw new PlanStaleError("Plan is missing its address payload. Run the preview again.");
  }
  return {
    addressId: payload.addressId,
    latitude: payload.latitude,
    longitude: payload.longitude,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

export function readAddressPreconditions(
  pre: Record<string, unknown> | undefined
): { fromAddressId: string; fingerprint: string } {
  if (!pre || typeof pre.fromAddressId !== "string" || typeof pre.fingerprint !== "string") {
    throw new PlanStaleError("Plan is missing its preconditions. Run the preview again.");
  }
  return { fromAddressId: pre.fromAddressId, fingerprint: pre.fingerprint };
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/**
 * Authoritative outcome from the COMPLETE post-switch snapshot. Success ONLY when
 * every cart's delivery address is the target, the FRESHLY re-read store context
 * (resolved again for the target coordinates AFTER dispatch — never the pre-write
 * response) covers every cart's mode, and cart contents are preserved. All carts
 * still on the original address (contents preserved) is "unchanged" (stale /
 * last-writer-wins). Anything else — a partial switch, changed contents, an
 * ambiguous duplicate mode, or a stale/uncovering store context — is divergent.
 */
function reconcileAddress(
  after: PlanSnapshot,
  before: PlanSnapshot,
  targetId: string,
  fromAddressId: string,
  freshContexts: AddressStoreContext[]
): "success" | "unchanged" | "divergent" {
  if (after.carts.length === 0) return "divergent";
  if (hasDupModes(after) || hasDupModes(before)) return "divergent";
  const contentOk = contentEquivalent(before, after);
  const allTarget = after.carts.every((c) => c.deliveryAddressId === targetId);
  const allOriginal = after.carts.every((c) => c.deliveryAddressId === fromAddressId);
  const storeOk = freshContexts.length > 0 && modesCovered(after, freshContexts);
  if (allTarget && contentOk && storeOk) return "success";
  if (allOriginal && contentOk) return "unchanged";
  return "divergent";
}

/** Sanitized description of a dispatch error — never interpolates a response body. */
function safeErr(err: unknown): string {
  if (err instanceof APIError) return `HTTP ${err.status} ${err.statusText}`;
  if (err instanceof Error) return err.name || "error";
  return "error";
}

const RECONCILE_HINT = "checkers60 addresses --json";

function printPreview(
  plan: { planId: string; expiresAt: number },
  target: ResolvedAddress,
  options: AddressUseOptions
): void {
  process.exitCode = EXIT_CONFIRM;
  const label = target.name || target.addressId;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          confirmationRequired: true,
          code: EXIT_CONFIRM,
          plan: {
            operation: "address.use",
            planId: plan.planId,
            expiresAt: plan.expiresAt,
            addressId: target.addressId,
            name: target.name || null,
          },
          confirm: `checkers60 addresses use ${target.addressId} --confirm ${plan.planId}`,
        },
        null,
        2
      )}\n`
    );
    return;
  }
  process.stdout.write(
    `${chalk.yellow("⚠ Confirmation required")} — no change has been made.\n` +
      `  ${chalk.bold("Switch delivery address")} to ${chalk.cyan(label)}\n` +
      `  ${chalk.dim("To apply, re-run with:")} ${chalk.green(`--confirm ${plan.planId}`)}\n` +
      `  ${chalk.dim("Plan expires in 15 minutes. This rotates your cart ids; contents are preserved.")}\n`
  );
}

/**
 * The full preview → confirm → reconcile flow for a delivery-address switch.
 * Preview (no `options.confirm`) makes ZERO writes: it reads the saved addresses
 * and carts, stages a single-use plan artifact, and exits 5. The confirm path is
 * the only writer.
 */
export async function runAddressUse(
  api: CheckersAPI,
  id: string,
  options: AddressUseOptions
): Promise<void> {
  const session = await api.tokens.getSession();
  const acct = account(session);

  if (!options.confirm) {
    // ── Preview: reads only ──
    const spinner = options.json ? null : startSpinner("Checking address…");
    try {
      const addresses = await api.getAddresses();
      const target = resolveTarget(addresses, id);
      const before = await api.getCarts();
      assertNoDupModes(before);
      const fromAddressId = before.deliveryAddressId;

      if (fromAddressId && fromAddressId === target.addressId) {
        spinner?.stop();
        const msg = `"${target.name || target.addressId}" is already your delivery address.`;
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: true, noop: true, reason: msg }, null, 2)}\n`);
        } else {
          process.stdout.write(`${chalk.dim(msg)}\n`);
        }
        return;
      }

      const plan = writePlan(acct, "address.use", {
        payload: {
          addressId: target.addressId,
          latitude: target.latitude,
          longitude: target.longitude,
          name: target.name,
        },
        preconditions: { fromAddressId, fingerprint: driftFingerprint(before) },
      });
      spinner?.stop();
      printPreview(plan, target, options);
    } finally {
      spinner?.stop();
    }
    return;
  }

  // ── Confirm: load + verify artifact, re-read, guard, claim, dispatch, reconcile ──
  const plan = loadPlan(options.confirm, acct, "address.use");
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.canon !== PLAN_CANON) {
    throw new PlanStaleError("Plan is from an incompatible version. Run the preview again.");
  }
  const payload = readAddressPayload(plan.payload);
  const pre = readAddressPreconditions(plan.preconditions);

  const release = await acquireConfirmLock(acct);
  const spinner = options.json ? null : startSpinner("Switching delivery address…");
  try {
    // Re-read: the target must still exist with the same coordinates, and the
    // carts must be exactly as previewed (no drift) before we write anything.
    const addresses = await api.getAddresses();
    const found = addresses.find((a) => addressId(a) === payload.addressId);
    if (!found) {
      throw new PlanStaleError("The target address no longer exists. Run the preview again.");
    }
    if (
      found.coordinates?.latitude !== payload.latitude ||
      found.coordinates?.longitude !== payload.longitude
    ) {
      throw new PlanStaleError("The target address changed since the preview. Run the preview again.");
    }

    const before = await api.getCarts();
    assertNoDupModes(before);
    if (driftFingerprint(before) !== pre.fingerprint) {
      throw new PlanStaleError("The cart changed since the preview. Run the preview again.");
    }
    const fromCartIds = before.carts.map((c) => c.cartId);

    // Single-use: atomically claim BEFORE the first POST. After this the plan is spent.
    claimPlan(plan.planId);

    // The 4-call switch. Any throw STOPS the sequence (no continuation, no retry);
    // whether it threw or not, we reconcile authoritatively before deciding.
    let dispatchFailed = false;
    let dispatchError: unknown;
    try {
      await api.useAddress(payload.addressId);
      const contexts = await api.getAddressStoreContexts(payload.latitude, payload.longitude);
      const toCartIds = await api.updateCartAddress(contexts);
      await api.transferCartDummies({
        fromCartIds,
        toCartIds,
        newDeliveryAddressId: payload.addressId,
        storeContexts: contexts,
      });
    } catch (err) {
      dispatchFailed = true;
      dispatchError = err;
    }

    const cause = dispatchFailed ? ` (${safeErr(dispatchError)})` : "";

    let after: PlanSnapshot;
    try {
      after = await api.getCarts();
    } catch {
      throw new DivergentOutcomeError(
        `Address switch was dispatched${cause} but the cart could not be re-read to confirm the outcome.`,
        RECONCILE_HINT
      );
    }

    // Reconcile store coverage against a FRESH post-dispatch re-read, never the
    // pre-write response — a later/partial context change must not read as success.
    // Inability to re-read the coverage is itself an unconfirmable outcome (divergent).
    let freshContexts: AddressStoreContext[];
    try {
      freshContexts = await api.getAddressStoreContexts(payload.latitude, payload.longitude);
    } catch {
      throw new DivergentOutcomeError(
        `Address switch was dispatched${cause} but store contexts could not be re-read to confirm the outcome.`,
        RECONCILE_HINT
      );
    }

    const outcome = reconcileAddress(after, before, payload.addressId, pre.fromAddressId, freshContexts);

    // A multi-step switch can partially apply, so a DISPATCH ERROR can never read
    // as a clean success — even when the post-dispatch reads happen to look right.
    // Clean success requires BOTH no dispatch error AND a reconciled success; a
    // dispatch error under an apparent success is unconfirmable → divergent.
    if (outcome === "divergent" || (dispatchFailed && outcome === "success")) {
      throw new DivergentOutcomeError(
        `Address switch dispatched${cause} but the outcome can't be confirmed as a clean success — reconcile manually.`,
        RECONCILE_HINT
      );
    }
    if (outcome === "unchanged") {
      throw new PlanStaleError(
        dispatchFailed
          ? `The switch failed${cause} and the delivery address is unchanged. Run the preview again.`
          : "The switch did not change the delivery address (a concurrent change likely intervened). Run the preview again."
      );
    }
    // success ONLY when !dispatchFailed && outcome === "success"
    const label = payload.name || payload.addressId;
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, operation: "address.use", planId: plan.planId, addressId: payload.addressId }, null, 2)}\n`
      );
    } else {
      process.stdout.write(
        `${chalk.green("✅ Done.")} ${chalk.dim(`Delivery address switched to ${label}.`)}\n`
      );
    }
  } finally {
    spinner?.stop();
    await release();
  }
}
