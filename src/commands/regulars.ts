import chalk from "chalk";
import Table from "cli-table3";
import { formatRand } from "../lib/format.js";
import { getRegulars } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface RegularsOptions {
  top?: number;
  json?: boolean;
}

export async function regulars(options: RegularsOptions = {}): Promise<void> {
  const { top = 20, json = false } = options;
  const spinner = json ? null : startSpinner("Fetching your regulars…");

  const items = await getRegulars(top);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write(`${chalk.yellow("No regular products found.")}\n`);
    return;
  }

  const table = new Table({
    head: [chalk.bold("#"), chalk.bold("Product"), chalk.bold("Price"), chalk.bold("Bought")],
    colWidths: [4, 44, 12, 9],
    style: { head: [], border: [] },
  });
  items.forEach((item, i) => {
    table.push([
      String(i + 1),
      item.name || chalk.dim(item.productId),
      item.price !== null ? formatRand(item.price) : chalk.dim("—"),
      `${item.count}×`,
    ]);
  });
  process.stdout.write(`\n${table.toString()}\n\n`);
}
