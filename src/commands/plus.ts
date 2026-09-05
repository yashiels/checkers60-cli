import chalk from "chalk";
import { formatRand } from "../lib/format.js";
import { getMembership } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface PlusOptions {
  json?: boolean;
}

/**
 * Xtra Savings membership status. Surfaces the account's own membership flag and
 * card number only — never the Xtra Savings access/id tokens. Lifetime savings
 * has no field in the profile contract, so it is reported as unavailable rather
 * than guessed.
 */
export async function plus(options: PlusOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching membership…");

  const dto = await getMembership();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold("Xtra Savings")}\n\n`);
  process.stdout.write(
    `  Member: ${dto.isMember ? chalk.green("yes") : chalk.yellow("no")}\n`
  );
  if (dto.memberNumber) {
    process.stdout.write(`  Card:   ${chalk.dim(dto.memberNumber)}\n`);
  }
  process.stdout.write(
    `  Lifetime savings: ${
      dto.lifetimeSavings !== null ? formatRand(dto.lifetimeSavings) : chalk.dim("not available")
    }\n\n`
  );
}
