import chalk from "chalk";
import { CheckersAPI } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface AddressesOptions {
  json?: boolean;
}

export async function addresses(options: AddressesOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching addresses…");

  const api = new CheckersAPI();
  const items = await api.getAddresses();
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
    const id = a._id ?? a.identifier ?? "—";
    const name = a.name ?? "(unnamed)";
    process.stdout.write(`  ${chalk.cyan("●")} ${chalk.bold(name)}\n`);
    if (a.fullAddress) process.stdout.write(`    ${chalk.dim(a.fullAddress)}\n`);
    process.stdout.write(`    ${chalk.dim(`id: ${id}`)}\n`);
  }
  process.stdout.write("\n");
}
