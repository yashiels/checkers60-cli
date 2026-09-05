import chalk from "chalk";
import Table from "cli-table3";
import { getReturnDetail, getReturns } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface ReturnsOptions {
  json?: boolean;
}

export async function returns(options: ReturnsOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching returns…");

  const items = await getReturns();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write(`${chalk.yellow("No returns found.")}\n`);
    return;
  }

  const table = new Table({
    head: [chalk.bold("Return"), chalk.bold("Reference"), chalk.bold("Status"), chalk.bold("Items")],
    colWidths: [26, 22, 18, 8],
    style: { head: [], border: [] },
  });
  for (const r of items) {
    table.push([
      r.id,
      r.reference ?? chalk.dim("—"),
      r.status ?? chalk.dim("—"),
      String(r.itemCount),
    ]);
  }
  process.stdout.write(`\n${table.toString()}\n\n`);
}

export async function returnsShow(id: string, options: ReturnsOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching return…");

  const r = await getReturnDetail(id);
  spinner?.stop();

  if (!r) {
    throw new Error(`Return ${id} not found in your account.`);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold(`Return ${r.id}`)}\n`);
  process.stdout.write(`  Reference: ${r.reference ?? chalk.dim("—")}\n`);
  process.stdout.write(`  Status:    ${r.status ?? chalk.dim("—")}\n\n`);

  if (r.items.length === 0) {
    process.stdout.write(`${chalk.dim("  No line items.")}\n\n`);
    return;
  }

  const table = new Table({
    head: [chalk.bold("Qty"), chalk.bold("Product")],
    colWidths: [6, 48],
    style: { head: [], border: [] },
  });
  for (const item of r.items) {
    table.push([String(item.quantity), item.name || chalk.dim(item.productId ?? "—")]);
  }
  process.stdout.write(`${table.toString()}\n\n`);
}
