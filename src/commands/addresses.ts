import chalk from "chalk";
import { getAddresses } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface AddressesOptions {
  json?: boolean;
}

/**
 * List saved delivery addresses. Only id + label + city are emitted — never the
 * unit number, delivery notes, coordinates, street, suburb, or full address.
 */
export async function addresses(options: AddressesOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching addresses…");

  const items = await getAddresses();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write(`${chalk.yellow("No delivery addresses found.")}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold("Delivery addresses")}\n\n`);
  for (const a of items) {
    process.stdout.write(`  ${chalk.cyan("●")} ${chalk.bold(a.name || "(unnamed)")}\n`);
    if (a.city) process.stdout.write(`    ${chalk.dim(a.city)}\n`);
    process.stdout.write(`    ${chalk.dim(`id: ${a.id || "—"}`)}\n`);
  }
  process.stdout.write("\n");
}
