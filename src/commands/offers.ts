import chalk from "chalk";
import Table from "cli-table3";
import { getOffers } from "../lib/discovery.js";
import { startSpinner } from "../lib/output.js";
import { formatValidUntil } from "./deals.js";

export interface OffersOptions {
  json?: boolean;
}

/** List the personalized bonus-buy offers ("offers for you") for the account. */
export async function offers(options: OffersOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching your offers…");

  const items = await getOffers();
  spinner?.stop();

  // Distinct by id, stable order.
  const seen = new Set<string>();
  const distinct = items.filter((d) => !seen.has(d.id) && seen.add(d.id));

  if (json) {
    process.stdout.write(`${JSON.stringify(distinct, null, 2)}\n`);
    return;
  }

  if (distinct.length === 0) {
    process.stdout.write(`${chalk.yellow("No personalized offers right now.")}\n`);
    return;
  }

  const table = new Table({
    head: [chalk.bold("Offer"), chalk.bold("Valid until"), chalk.bold("Members")],
    colWidths: [46, 14, 10],
    wordWrap: true,
    style: { head: [], border: [] },
  });
  for (const d of distinct) {
    table.push([
      d.title || d.description || d.id,
      formatValidUntil(d),
      d.membersOnly ? chalk.cyan("Xtra") : chalk.dim("all"),
    ]);
  }
  process.stdout.write(`\n${table.toString()}\n\n`);
}
