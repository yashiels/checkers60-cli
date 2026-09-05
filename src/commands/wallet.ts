import chalk from "chalk";
import { formatRand } from "../lib/format.js";
import { getWallet } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface WalletOptions {
  json?: boolean;
}

/**
 * Account wallet/credit balance. Shows the API-reported account balance only; a
 * null balance means the field was absent (reported as unavailable, never as an
 * empty R0.00 balance).
 */
export async function wallet(options: WalletOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching wallet…");

  const dto = await getWallet();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }

  const balance =
    dto.balance !== null ? formatRand(dto.balance) : chalk.dim("not available");
  process.stdout.write(`\n${chalk.bold("Wallet balance")}: ${balance}\n\n`);
}
