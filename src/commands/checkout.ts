import chalk from "chalk";
import { UsageError } from "../lib/errors.js";
import { checkoutPreviewDTO } from "../lib/orders.js";

export interface CheckoutOptions {
  preview?: boolean;
  json?: boolean;
}

/**
 * Read-only checkout totals preview. `--preview` is MANDATORY: this is a
 * read-only domain, so no place-order / tip / payment path exists. The pre-order
 * totals contract was never captured (pre-order only returns totals for a
 * populated cart, and no write may populate one), so the preview is DEFERRED —
 * a fixed "not supported yet" notice, no network call, no guessed totals.
 */
export async function checkout(options: CheckoutOptions = {}): Promise<void> {
  const { preview = false, json = false } = options;

  if (!preview) {
    throw new UsageError(
      "checkout is preview-only in this version — pass --preview. (Placing an order is not supported by this CLI.)"
    );
  }

  const dto = checkoutPreviewDTO();

  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${chalk.yellow(dto.message)}\n`);
}
