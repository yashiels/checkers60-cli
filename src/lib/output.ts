import chalk from "chalk";
import ora, { type Ora } from "ora";

export interface GlobalFlags {
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
}

let state: Required<GlobalFlags> = {
  noColor: false,
  quiet: false,
  verbose: false,
  json: false,
};

export function configureOutput(flags: GlobalFlags = {}): void {
  const noColor =
    flags.noColor === true ||
    process.env.NO_COLOR !== undefined ||
    !process.stdout.isTTY;

  state = {
    noColor,
    quiet: flags.quiet === true,
    verbose: flags.verbose === true,
    // json is sticky: once enabled (e.g. detected before commander parse) it
    // stays on unless the caller explicitly passes a new value.
    json: flags.json ?? state.json,
  };

  if (noColor) {
    chalk.level = 0;
  }
}

export function isQuiet(): boolean {
  return state.quiet;
}

export function isVerbose(): boolean {
  return state.verbose;
}

export function isJson(): boolean {
  return state.json;
}

export function isInteractive(): boolean {
  return process.stdout.isTTY === true && !state.quiet && !state.json;
}

export function startSpinner(text: string): Ora | null {
  // No spinners in JSON mode or when non-interactive.
  if (state.json || !isInteractive()) return null;
  return ora({ text, stream: process.stderr }).start();
}

export function logInfo(msg: string): void {
  if (state.quiet || state.json) return;
  process.stderr.write(`${msg}\n`);
}

export function logVerbose(msg: string): void {
  if (!state.verbose || state.json) return;
  process.stderr.write(`${chalk.dim("[debug]")} ${msg}\n`);
}

export function logError(msg: string): void {
  process.stderr.write(`${chalk.red(msg)}\n`);
}

export function logWarn(msg: string): void {
  if (state.quiet || state.json) return;
  process.stderr.write(`${chalk.yellow(msg)}\n`);
}
