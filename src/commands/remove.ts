import chalk from "chalk";
import { CheckersAPI, type CartItemInput } from "../lib/api.js";
import { isProductId } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";
import { resolveNames } from "./cart.js";

export interface RemoveOptions {
  json?: boolean;
}

export async function remove(target: string, options: RemoveOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner(`Removing "${target}"…`);

  const api = new CheckersAPI();
  const state = await api.getCart();

  if (!state.cartId || state.items.length === 0) {
    spinner?.stop();
    if (json) {
      process.stdout.write(`${JSON.stringify({ removed: null, reason: "empty-cart" }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${chalk.yellow("Your cart is empty.")}\n`);
    return;
  }

  // Match by product id, or by case-insensitive name substring.
  const byId = isProductId(target);
  const names = byId ? new Map<string, string>() : await resolveNames(api, state.items.map((i) => i.productId));
  const match = state.items.find((i) =>
    byId
      ? i.productId === target
      : (names.get(i.productId) ?? "").toLowerCase().includes(target.toLowerCase())
  );

  if (!match) {
    spinner?.stop();
    if (json) {
      process.stdout.write(`${JSON.stringify({ removed: null, reason: "not-found" }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${chalk.yellow(`"${target}" not found in cart.`)}\n`);
    return;
  }

  // Send the matched item with quantity 0; the API ignores omitted items.
  const updatedItems: CartItemInput[] = state.items.map((i) => ({
    productId: i.productId,
    quantity: i.productId === match.productId ? 0 : i.quantity,
    price: i.price,
    storeId: i.storeId,
    lineItemId: i.id,
  }));

  const updated = await api.updateCart(state.cartId, updatedItems);
  spinner?.stop();

  const removedName = names.get(match.productId) ?? match.productId;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ removed: match.productId, itemCount: updated.items.length }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.green("✅ Removed")} ${removedName}. ${chalk.dim(`Cart now has ${updated.items.length} item(s).`)}\n`
  );
}
