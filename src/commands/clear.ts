import chalk from "chalk";
import { CheckersAPI } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface ClearOptions {
  json?: boolean;
}

export async function clear(options: ClearOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Clearing cart…");

  const api = new CheckersAPI();
  const state = await api.getCart();

  if (!state.cartId || state.items.length === 0) {
    spinner?.stop();
    if (json) {
      process.stdout.write(`${JSON.stringify({ cleared: false, reason: "empty-cart" }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${chalk.dim("Cart is already empty.")}\n`);
    return;
  }

  const removed = state.items.length;
  await api.clearCart(state.cartId);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify({ cleared: true, removed }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${chalk.green(`✅ Cart cleared (${removed} item(s) removed).`)}\n`);
}
