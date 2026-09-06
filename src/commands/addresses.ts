import chalk from "chalk";
import { getAddresses } from "../lib/orders.js";
import { EXIT_USAGE, UsageError } from "../lib/errors.js";
import { startSpinner } from "../lib/output.js";

export interface AddressesOptions {
  json?: boolean;
}

const USE_UNSUPPORTED_MESSAGE =
  "Switching the delivery address from the CLI is not supported yet — set it in the app.";

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

/**
 * `addresses use <id>` — CONSERVATIVE. A multi-address delivery SWITCH has no
 * captured cart/store/slot transformation, so this command dispatches NO
 * mutation and makes no network write. It validates the id against the account's
 * own saved addresses (unknown → UsageError, exit 2), and for a known id prints
 * an allowlisted LABEL only (name/city — never the full address or coordinates),
 * reports `supported:false`, and exits non-zero so a script cannot read it as a
 * successful switch.
 */
export async function addressesUse(
  id: string,
  options: AddressesOptions = {}
): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Checking address…");

  const items = await getAddresses();
  spinner?.stop();

  const found = items.find((a) => a.id === id);
  if (!found) {
    throw new UsageError(`Address ${id} not found in your saved addresses.`);
  }

  process.exitCode = EXIT_USAGE;

  if (json) {
    const body = {
      id: found.id,
      name: found.name,
      city: found.city,
      supported: false,
      message: USE_UNSUPPORTED_MESSAGE,
    };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  const label = found.city ? `${found.name || "(unnamed)"} — ${found.city}` : found.name || "(unnamed)";
  process.stdout.write(`\n${chalk.bold(label)}\n`);
  process.stdout.write(`${chalk.yellow(USE_UNSUPPORTED_MESSAGE)}\n\n`);
}
