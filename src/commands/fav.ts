import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI } from "../lib/api.js";
import { runFavMutation, type FavOptions as FavMutateOptions } from "../lib/favourites-mutate.js";
import { formatRand } from "../lib/format.js";
import { getFavourites } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface FavOptions {
  json?: boolean;
}

/** `fav add <product>` — favourite a product (preview by default; --confirm to apply). */
export async function favAdd(target: string, options: FavMutateOptions = {}): Promise<void> {
  await runFavMutation(new CheckersAPI(), "fav.add", target, options);
}

/** `fav remove <product>` — un-favourite a product (preview by default; --confirm to apply). */
export async function favRemove(target: string, options: FavMutateOptions = {}): Promise<void> {
  await runFavMutation(new CheckersAPI(), "fav.remove", target, options);
}

export async function fav(options: FavOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching favourites…");

  const items = await getFavourites();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write(`${chalk.yellow("No favourites found.")}\n`);
    return;
  }

  const table = new Table({
    head: [chalk.bold("Product"), chalk.bold("Price")],
    colWidths: [48, 14],
    style: { head: [], border: [] },
  });
  for (const item of items) {
    table.push([
      item.name || chalk.dim(item.productId),
      item.price !== null ? formatRand(item.price) : chalk.dim("—"),
    ]);
  }
  process.stdout.write(`\n${table.toString()}\n\n`);
}
