import chalk from "chalk";
import Table from "cli-table3";
import { formatRand } from "../lib/format.js";
import { getOrderDetail, getOrderSummaries } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface OrdersOptions {
  all?: boolean;
  json?: boolean;
}

export async function orders(options: OrdersOptions = {}): Promise<void> {
  const { all = false, json = false } = options;
  const spinner = json ? null : startSpinner("Fetching orders…");

  const summaries = await getOrderSummaries(all);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
    return;
  }

  if (summaries.length === 0) {
    process.stdout.write(
      `${chalk.yellow(all ? "No orders found." : "No active orders. Try --all for history.")}\n`
    );
    return;
  }

  const table = new Table({
    head: [chalk.bold("Reference"), chalk.bold("Status"), chalk.bold("Total")],
    colWidths: [22, 24, 14],
    style: { head: [], border: [] },
  });
  for (const s of summaries) {
    table.push([
      s.reference || "—",
      formatStatus(s.status ?? "unknown"),
      s.total !== null ? formatRand(s.total) : chalk.dim("—"),
    ]);
  }
  process.stdout.write(`\n${table.toString()}\n\n`);
}

/** `orders show <ref>` — IDOR-guarded: the ref must be in the account's list. */
export async function ordersShow(ref: string, options: OrdersOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching order…");

  const detail = await getOrderDetail(ref);
  spinner?.stop();

  if (!detail) {
    throw new Error(`Order ${ref} not found in your account.`);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold(`Order ${detail.reference}`)}\n`);
  process.stdout.write(`  Status: ${formatStatus(detail.status ?? "unknown")}\n`);
  process.stdout.write(
    `  Total:  ${detail.total !== null ? formatRand(detail.total) : chalk.dim("—")}\n\n`
  );

  if (detail.items.length === 0) {
    process.stdout.write(`${chalk.dim("  No line items.")}\n\n`);
    return;
  }

  const table = new Table({
    head: [chalk.bold("Qty"), chalk.bold("Product"), chalk.bold("Price")],
    colWidths: [6, 46, 14],
    style: { head: [], border: [] },
  });
  for (const item of detail.items) {
    table.push([
      String(item.quantity),
      item.name || chalk.dim(item.productId),
      item.price !== null ? formatRand(item.price) : chalk.dim("—"),
    ]);
  }
  process.stdout.write(`${table.toString()}\n\n`);
}

function formatStatus(status: string): string {
  const s = status.toLowerCase();
  if (/cancel|fail/.test(s)) return chalk.red(status);
  if (/deliver|complete|fulfil/.test(s)) return chalk.green(status);
  return chalk.yellow(status);
}
