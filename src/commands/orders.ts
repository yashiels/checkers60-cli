import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI, type OrderGroup } from "../lib/api.js";
import { formatRand } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export interface OrdersOptions {
  all?: boolean;
  json?: boolean;
}

export async function orders(options: OrdersOptions = {}): Promise<void> {
  const { all = false, json = false } = options;
  const spinner = json ? null : startSpinner("Fetching orders…");

  const api = new CheckersAPI();
  const groups = await api.getOrders(!all);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
    return;
  }

  if (groups.length === 0) {
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

  for (const group of groups) {
    const order = group.orders?.[0];
    const ref = group.reference ?? "—";
    const status = order?.status?.orderStatus ?? "unknown";
    const total = order?.total?.totalOwing;
    table.push([ref, formatStatus(status), total !== undefined ? formatRand(total) : chalk.dim("—")]);
  }

  process.stdout.write(`\n${table.toString()}\n\n`);
}

function formatStatus(status: string): string {
  const s = status.toLowerCase();
  if (/cancel|fail/.test(s)) return chalk.red(status);
  if (/deliver|complete|fulfil/.test(s)) return chalk.green(status);
  return chalk.yellow(status);
}

export type { OrderGroup };
