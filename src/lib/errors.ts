import chalk from "chalk";
import { writeSync } from "node:fs";
import { APIError } from "./api.js";
import { PlanStaleError } from "./confirm.js";
import { isJson, isVerbose, logError } from "./output.js";

/**
 * Exit codes:
 *   0 — success
 *   1 — generic runtime failure
 *   2 — invalid usage
 *   3 — authentication (401/403, not logged in)
 *   4 — network (timeout, DNS, connection reset/refused)
 *   5 — confirmation required / plan stale (re-run the preview)
 *   6 — outcome unknown/divergent after a dispatched write (reconcile manually)
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_NETWORK = 4;
export const EXIT_CONFIRM = 5;
export const EXIT_DIVERGENT = 6;

export class UsageError extends Error {
  readonly isUsage = true;
}

/**
 * A dispatched cart write whose outcome could not be reconciled to either the
 * intended state or the original state. NEVER auto-retried. Carries a read-only
 * reconcile hint so a human/agent can inspect the true cart state.
 */
export class DivergentOutcomeError extends Error {
  readonly isDivergent = true;
  constructor(
    message: string,
    readonly reconcile = "checkers60 cart --json"
  ) {
    super(message);
  }
}

interface Classified {
  /** User-facing message. Never contains a response body or secret. */
  message: string;
  code: number;
  /** HTTP status, when the failure came from a server response. */
  status?: number;
  /** Verbose-only, URL-redacted status line (never a body). */
  verboseLine?: string;
  /** Read-only reconcile hint (divergent-outcome only). */
  reconcile?: string;
}

const NETWORK_RE =
  /(fetch failed|ENOTFOUND|EAI_AGAIN|ECONN(?:REFUSED|RESET|ABORTED)?|ETIMEDOUT|network|timed out|The (?:user aborted|operation was aborted)|This operation was aborted|AbortError)/i;

function isNetworkError(err: Error): boolean {
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT)$/.test(code)) {
    return true;
  }
  return NETWORK_RE.test(err.message);
}

/**
 * Maps an unknown error to a user-facing message + exit code, WITHOUT ever
 * leaking a response body or secret. APIError.message embeds up to 200 chars
 * of the raw response body, so it is never surfaced — a clean message is built
 * from status/statusText instead.
 */
export function classifyError(err: unknown): Classified {
  if (err instanceof UsageError) {
    return { message: err.message, code: EXIT_USAGE };
  }

  if (err instanceof PlanStaleError) {
    return { message: err.message, code: EXIT_CONFIRM };
  }

  if (err instanceof DivergentOutcomeError) {
    return { message: err.message, code: EXIT_DIVERGENT, reconcile: err.reconcile };
  }

  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) {
      return {
        message: `Authentication failed (HTTP ${err.status}).`,
        code: EXIT_AUTH,
        status: err.status,
      };
    }
    return {
      message: `Request failed: HTTP ${err.status} ${err.statusText}`,
      code: EXIT_FAILURE,
      status: err.status,
      verboseLine: `${err.status} ${err.statusText} on ${err.path}`,
    };
  }

  if (err instanceof Error) {
    if (/Not logged in/i.test(err.message)) {
      return { message: err.message, code: EXIT_AUTH };
    }
    if (isNetworkError(err)) {
      return { message: err.message, code: EXIT_NETWORK };
    }
    return { message: err.message, code: EXIT_FAILURE };
  }

  return { message: String(err), code: EXIT_FAILURE };
}

/**
 * Terminal error handler. Sets process.exitCode and returns — NEVER calls
 * process.exit(), so buffered stdout is allowed to flush.
 *
 * In JSON mode it writes exactly one `{error, code, status?}` object to stdout
 * (synchronous) and emits nothing else. In human mode it prints a friendly
 * message (and, when verbose, a URL-redacted status line — never a body).
 */
export function handleError(err: unknown): void {
  const c = classifyError(err);
  process.exitCode = c.code;

  if (isJson()) {
    const envelope: { error: string; code: number; status?: number; reconcile?: string } = {
      error: c.message,
      code: c.code,
    };
    if (c.status !== undefined) envelope.status = c.status;
    if (c.reconcile !== undefined) envelope.reconcile = c.reconcile;
    writeSync(1, `${JSON.stringify(envelope)}\n`);
    return;
  }

  logError(c.message);

  if (c.reconcile) {
    process.stderr.write(`${chalk.dim("   Reconcile: ")}${chalk.cyan(c.reconcile)}\n`);
  }

  if (c.code === EXIT_AUTH && (err instanceof APIError || /Not logged in/i.test(c.message))) {
    process.stderr.write(
      `${chalk.dim("   Run: ")}${chalk.cyan("checkers60 login")}${chalk.dim(", then ")}${chalk.cyan("checkers60 otp-verify <reference> <code>")}\n`
    );
  }

  if (isVerbose() && c.verboseLine) {
    process.stderr.write(chalk.dim(`   ${c.verboseLine}\n`));
  }
}

/**
 * Wraps an async command handler so any thrown error funnels through
 * handleError() with proper exit codes and user-friendly messages.
 */
export function wrap<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<void>
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await fn(...args);
    } catch (err) {
      handleError(err);
    }
  };
}
