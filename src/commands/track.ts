import chalk from "chalk";
import { formatRand } from "../lib/format.js";
import { getTrack } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface TrackOptions {
  json?: boolean;
}

/**
 * Order status by reference. The ref is validated against the account's own
 * orders list (IDOR guard) before any detail is shown. Driver name/phone/
 * coordinates are never emitted. Live ETA is deferred (order-groups-info is
 * 405 on GET), so status comes from orders/groups.
 */
export async function track(ref: string, options: TrackOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching order status…");

  const info = await getTrack(ref);
  spinner?.stop();

  if (!info) {
    throw new Error(`Order ${ref} not found in your account.`);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold(`Order ${info.reference}`)}\n`);
  process.stdout.write(`  Status:    ${info.status ?? chalk.dim("unknown")}\n`);
  process.stdout.write(`  Items:     ${info.itemCount}\n`);
  process.stdout.write(
    `  Total:     ${info.total !== null ? formatRand(info.total) : chalk.dim("—")}\n`
  );
  if (info.eta) process.stdout.write(`  ETA:       ${info.eta}\n`);
  else process.stdout.write(`  ${chalk.dim("Live ETA not available for this order.")}\n`);
  process.stdout.write("\n");
}
