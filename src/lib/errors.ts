import chalk from "chalk";
import { APIError } from "./api.js";
import { isVerbose, logError } from "./output.js";

/**
 * Exit codes (clig.dev):
 *   0 — success
 *   1 — runtime failure
 *   2 — invalid usage
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export class UsageError extends Error {
  readonly isUsage = true;
}

export function handleError(err: unknown): never {
  if (err instanceof UsageError) {
    logError(err.message);
    process.exit(EXIT_USAGE);
  }

  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) {
      logError(`Authentication failed (HTTP ${err.status}).`);
      process.stderr.write(
        `${chalk.dim("   Your session may have expired. Run: ")}${chalk.cyan("checkers60 login")}\n`
      );
    } else {
      logError(`Request failed: HTTP ${err.status} ${err.statusText}`);
      if (isVerbose() && err.body) {
        process.stderr.write(chalk.dim(`   ${err.body.slice(0, 500)}\n`));
      }
    }
    process.exit(EXIT_FAILURE);
  }

  if (err instanceof Error) {
    if (/Not logged in/i.test(err.message)) {
      logError(err.message);
      process.stderr.write(
        `${chalk.dim("   Run: ")}${chalk.cyan("checkers60 login")}\n`
      );
      process.exit(EXIT_FAILURE);
    }
    logError(err.message);
    if (isVerbose() && err.stack) {
      process.stderr.write(chalk.dim(`${err.stack}\n`));
    }
    process.exit(EXIT_FAILURE);
  }

  logError(String(err));
  process.exit(EXIT_FAILURE);
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
