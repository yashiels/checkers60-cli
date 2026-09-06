import chalk from "chalk";
import { formatRand } from "../lib/format.js";
import { getTrack, type TrackDTO } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface TrackOptions {
  json?: boolean;
  /** Poll until the order reaches a terminal status (delivered/cancelled). */
  watch?: boolean;
  /** Seconds between polls in --watch mode (floored to MIN_INTERVAL_S). */
  interval?: number;
}

/** Injectable seams so the watch loop is testable without real timers/network. */
export interface TrackDeps {
  fetch?: (ref: string) => Promise<TrackDTO | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Hard cap on polls (safety valve against an order that never terminates). */
  maxPolls?: number;
}

const MIN_INTERVAL_S = 10;
const MAX_INTERVAL_S = 3600; // 1h ceiling — also prevents interval*1000 overflow
const DEFAULT_INTERVAL_S = 30;
/** ~3h at the default interval — a delivery is long done by then; prevents a runaway loop. */
const DEFAULT_MAX_POLLS = 360;

/**
 * A status is terminal when the order has been delivered or cancelled — there is
 * nothing left to watch. Matched loosely (substring, case-insensitive) because the
 * exact server enum wording isn't pinned; an unknown/degraded status keeps polling
 * rather than stopping early.
 */
export function isTerminalStatus(status: string | null): boolean {
  if (!status) return false;
  // Whole-word terminal states only, so in-progress lookalikes never stop the watch:
  // "out-for-delivery" (not "delivered"), "undelivered", "cancellation-pending",
  // "refund-pending", "incomplete" all stay non-terminal. The exact server enum
  // isn't captured yet (needs a live out-for-delivery order), so this set is
  // provisional — pin it to the real values when order-groups-info is captured.
  return /\b(delivered|cancelled|canceled|refunded|completed)\b/i.test(status);
}

/**
 * Explicit output allowlist. The tracking read can carry driver PII (name, phone,
 * coordinates) in fields we never want to print, so JSON mode serializes ONLY these
 * safe fields rather than the whole DTO — a new PII-bearing field can't leak by default.
 */
function safeJson(info: TrackDTO, at?: string): string {
  const { reference, status, eta, slotFrom, slotTo, itemCount, total } = info;
  const out: Record<string, unknown> = { reference, status, eta, slotFrom, slotTo, itemCount, total };
  if (at !== undefined) out.at = at;
  return JSON.stringify(out);
}

function stamp(now: () => number): string {
  return new Date(now()).toLocaleTimeString();
}

/** One rendered status line (human mode). */
function renderLine(info: TrackDTO, now: () => number): string {
  const status = info.status ?? chalk.dim("unknown");
  const eta = info.eta ? `  ETA: ${info.eta}` : "";
  return `${chalk.dim(`[${stamp(now)}]`)} ${chalk.bold(status)}${eta}`;
}

/**
 * Order status by reference. The ref is validated against the account's own
 * orders list (IDOR guard) before any detail is shown. Driver name/phone/
 * coordinates are never emitted.
 *
 * `--watch` polls order status on an interval and prints each change until the
 * order is delivered/cancelled. Status + one-hour delivery slot come from the
 * captured `orders/groups` read. Richer LIVE tracking — the driver's position and
 * a precise live ETA — is served by the app over `POST /api/v3/orders/order-groups-info`
 * plus a websocket channel; both require an order that is actively out for delivery
 * to capture, so they are intentionally not wired here (see orders.ts). This watch
 * gives you status progression without any of that.
 */
export async function track(
  ref: string,
  options: TrackOptions = {},
  deps: TrackDeps = {}
): Promise<void> {
  const { json = false, watch = false } = options;
  const fetch = deps.fetch ?? ((r: string) => getTrack(r));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const now = deps.now ?? Date.now;
  // Coerce to a finite positive integer so Infinity/NaN/fractional can't cause an
  // unbounded loop or a miscounted cap.
  const rawMax = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  const maxPolls = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : DEFAULT_MAX_POLLS;

  if (!watch) {
    const spinner = json ? null : startSpinner("Fetching order status…");
    let info: TrackDTO | null;
    try {
      info = await fetch(ref);
    } finally {
      spinner?.stop();
    }
    if (!info) throw new Error(`Order ${ref} not found in your account.`);
    if (json) {
      process.stdout.write(`${safeJson(info)}\n`);
      return;
    }
    renderOneShot(info);
    return;
  }

  // ── watch mode ──
  const rawInterval = options.interval ?? DEFAULT_INTERVAL_S;
  // Clamp to [MIN, MAX] so a huge finite input can't overflow `*1000` toward
  // Infinity (which setTimeout treats as ~0 → runaway polling).
  const intervalS = Number.isFinite(rawInterval)
    ? Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Math.floor(rawInterval)))
    : DEFAULT_INTERVAL_S;
  const intervalMs = intervalS * 1000;

  // First fetch also serves as the IDOR/existence check — a missing order errors, never loops.
  let info = await fetch(ref);
  if (!info) throw new Error(`Order ${ref} not found in your account.`);

  let lastKey = "";
  const emit = (i: TrackDTO): void => {
    if (json) process.stdout.write(`${safeJson(i, new Date(now()).toISOString())}\n`);
    else process.stdout.write(`${renderLine(i, now)}\n`);
  };

  if (!json) {
    process.stdout.write(
      `${chalk.bold(`Watching order ${info.reference}`)} ${chalk.dim(
        `(every ${intervalS}s — Ctrl-C to stop)`
      )}\n`
    );
  }

  // Process EVERY fetched snapshot (including the last before the cap): emit on change,
  // stop on terminal, otherwise sleep + re-fetch. Guarantees no fetched value is dropped.
  let polls = 0;
  for (;;) {
    const key = `${info.status ?? ""}|${info.eta ?? ""}`;
    if (key !== lastKey) {
      emit(info);
      lastKey = key;
    }
    if (isTerminalStatus(info.status)) {
      if (!json) process.stdout.write(`${chalk.green("✓ Order reached a final status — done.")}\n`);
      return;
    }
    if (++polls >= maxPolls) break;
    await sleep(intervalMs);
    const next = await fetch(ref);
    // A transient null (order briefly unreadable) is skipped, not treated as "gone".
    if (next) info = next;
  }
  if (!json) {
    process.stdout.write(
      `${chalk.yellow(`Stopped after ${maxPolls} polls without a final status.`)}\n`
    );
  }
}

function renderOneShot(info: TrackDTO): void {
  process.stdout.write(`\n${chalk.bold(`Order ${info.reference}`)}\n`);
  process.stdout.write(`  Status:    ${info.status ?? chalk.dim("unknown")}\n`);
  process.stdout.write(`  Items:     ${info.itemCount}\n`);
  process.stdout.write(
    `  Total:     ${info.total !== null ? formatRand(info.total) : chalk.dim("—")}\n`
  );
  if (info.eta) process.stdout.write(`  ETA:       ${info.eta}\n`);
  else process.stdout.write(`  ${chalk.dim("Live ETA not available for this order.")}\n`);
  process.stdout.write("\n");
}
