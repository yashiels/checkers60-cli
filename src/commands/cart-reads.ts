import chalk from "chalk";
import Table from "cli-table3";
import { formatRand } from "../lib/format.js";
import {
  forgottenDeferredDTO,
  suggestDeferredDTO,
  getBackups,
  type DeferredCartDTO,
} from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface CartReadOptions {
  json?: boolean;
}

/** Emit a deferred-feature DTO (no network call, no guessed request). */
function emitDeferred(dto: DeferredCartDTO, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${chalk.yellow(dto.message)}\n`);
}

/**
 * `cart forgotten` — deferred. The `have-you-forgotten` endpoint exposes no
 * read-only contract in this app version (its GET rejects every cart-id form and
 * its POST is mutation-adjacent), so this recognizes the request and defers
 * rather than guessing a body.
 */
export async function cartForgotten(options: CartReadOptions = {}): Promise<void> {
  emitDeferred(forgottenDeferredDTO(), options.json ?? false);
}

/**
 * `cart suggest` — deferred. `smart-cart/recommendations` is 404 on every host
 * in this app version, so the command defers with no network call.
 */
export async function cartSuggest(options: CartReadOptions = {}): Promise<void> {
  emitDeferred(suggestDeferredDTO(), options.json ?? false);
}

/** `backup <productId>` — replacement/backup candidates for a product. */
export async function backup(
  productId: string,
  options: CartReadOptions = {}
): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Finding backup products…");

  const items = await getBackups(productId);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write(
      `${chalk.yellow(`No backup products found for ${productId}.`)}\n`
    );
    return;
  }

  const table = new Table({
    head: [chalk.bold("#"), chalk.bold("Product"), chalk.bold("Price")],
    colWidths: [4, 48, 12],
    wordWrap: true,
    style: { head: [], border: [] },
  });
  items.forEach((item, i) => {
    table.push([
      String(i + 1),
      item.name || chalk.dim(item.productId),
      item.price !== null ? formatRand(item.price) : chalk.dim("—"),
    ]);
  });
  process.stdout.write(`\n${table.toString()}\n\n`);
}
