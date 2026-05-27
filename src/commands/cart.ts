import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI, type CartLineItem } from "../lib/api.js";
import { formatRand } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export interface CartOptions {
  json?: boolean;
}

/** Resolve product ids to display names (best-effort; tolerates failures). */
export async function resolveNames(
  api: CheckersAPI,
  productIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (productIds.length === 0) return map;
  try {
    const details = await api.getProductDetails(productIds);
    for (const d of details) {
      map.set(d.id, (d.name ?? d.displayName ?? d.id) as string);
    }
  } catch {
    // names are a nicety — fall back to ids on failure
  }
  return map;
}

export function cartTotal(items: CartLineItem[]): number {
  return items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

export async function cart(options: CartOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching cart…");

  const api = new CheckersAPI();
  const state = await api.getCart();
  const names = await resolveNames(
    api,
    state.items.map((i) => i.productId)
  );
  spinner?.stop();

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cartId: state.cartId,
          cartVersion: state.cartVersion,
          itemCount: state.items.length,
          total: cartTotal(state.items),
          items: state.items.map((i) => ({
            productId: i.productId,
            name: names.get(i.productId) ?? null,
            quantity: i.quantity,
            price: i.price,
          })),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (state.items.length === 0) {
    process.stdout.write(`${chalk.yellow("Your cart is empty.")}\n`);
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("Product"),
      chalk.bold("Qty"),
      chalk.bold("Unit"),
      chalk.bold("Subtotal"),
    ],
    colWidths: [44, 6, 12, 12],
    wordWrap: true,
    style: { head: [], border: [] },
  });

  for (const item of state.items) {
    const name = names.get(item.productId) ?? item.productId;
    table.push([
      name,
      String(item.quantity),
      formatRand(item.price),
      formatRand(item.price * item.quantity),
    ]);
  }

  process.stdout.write(`\n${table.toString()}\n`);
  process.stdout.write(
    `${chalk.bold(`  Total: ${formatRand(cartTotal(state.items))}`)} ${chalk.dim(`(${state.items.length} items)`)}\n\n`
  );
}
