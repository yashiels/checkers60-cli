import chalk from "chalk";
import Table from "cli-table3";
import { formatRand } from "../lib/format.js";
import { getDiscover } from "../lib/discovery.js";
import { startSpinner } from "../lib/output.js";
import { formatValidUntil } from "./deals.js";

export interface DiscoverOptions {
  json?: boolean;
  /** Force Xtra Savings membership on/off; omitted → derived from the profile. */
  member?: boolean;
}

/** Personalized promotions ("promotions for you"): deals plus surfaced products. */
export async function discover(options: DiscoverOptions = {}): Promise<void> {
  const { json = false, member } = options;
  const spinner = json ? null : startSpinner("Discovering promotions for you…");

  const result = await getDiscover(member);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (result.promotions.length === 0 && result.products.length === 0) {
    process.stdout.write(`${chalk.yellow("No personalized promotions right now.")}\n`);
    return;
  }

  if (result.promotions.length > 0) {
    process.stdout.write(`${chalk.bold("Promotions for you")}\n`);
    const table = new Table({
      head: [chalk.bold("Promotion"), chalk.bold("Valid until"), chalk.bold("Members")],
      colWidths: [46, 14, 10],
      wordWrap: true,
      style: { head: [], border: [] },
    });
    for (const d of result.promotions) {
      table.push([
        d.title || d.description || d.id,
        formatValidUntil(d),
        d.membersOnly ? chalk.cyan("Xtra") : chalk.dim("all"),
      ]);
    }
    process.stdout.write(`${table.toString()}\n\n`);
  }

  if (result.products.length > 0) {
    process.stdout.write(`${chalk.bold("Featured products")}\n`);
    const table = new Table({
      head: [chalk.bold("Product"), chalk.bold("Price")],
      colWidths: [48, 14],
      style: { head: [], border: [] },
    });
    for (const p of result.products) {
      table.push([
        p.name || chalk.dim(p.productId),
        p.price !== null ? formatRand(p.price) : chalk.dim("—"),
      ]);
    }
    process.stdout.write(`${table.toString()}\n\n`);
  }
}
