import chalk from "chalk";
import { CheckersAPI, type CartItemInput } from "../lib/api.js";
import { formatRand, isProductId } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export interface AddOptions {
  json?: boolean;
}

interface Pick {
  id: string;
  name: string;
  price: number;
  storeId?: string;
}

export async function add(
  target: string,
  qty = 1,
  options: AddOptions = {}
): Promise<void> {
  const { json = false } = options;
  if (!Number.isFinite(qty) || qty < 1) qty = 1;

  const spinner = json ? null : startSpinner(`Finding "${target}"…`);
  const api = new CheckersAPI();

  const pick = await resolvePick(api, target);

  spinner?.stop();
  if (!json) {
    process.stdout.write(
      `${chalk.dim("Found: ")}${pick.name} ${chalk.dim(`— ${formatRand(pick.price)}`)}\n`
    );
  }

  const addSpinner = json ? null : startSpinner("Updating cart…");
  const state = await api.getCart();
  if (!state.cartId) {
    addSpinner?.stop();
    throw new Error("No cart available for your account.");
  }

  // Preserve existing line items, then add/increment the picked product.
  const merged: CartItemInput[] = state.items.map((i) => ({
    productId: i.productId,
    quantity: i.quantity,
    price: i.price,
    storeId: i.storeId,
    lineItemId: i.id,
  }));

  const existing = merged.find((m) => m.productId === pick.id);
  if (existing) {
    existing.quantity += qty;
  } else {
    merged.push({ productId: pick.id, quantity: qty, price: pick.price, storeId: pick.storeId });
  }

  const updated = await api.updateCart(state.cartId, merged);
  addSpinner?.stop();

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ added: pick, itemCount: updated.items.length }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.green("✅ Added")} ${qty} × ${pick.name}. ${chalk.dim(`Cart now has ${updated.items.length} item(s).`)}\n`
  );
}

async function resolvePick(api: CheckersAPI, target: string): Promise<Pick> {
  if (isProductId(target)) {
    const details = await api.getProductDetails([target]);
    const d = details[0];
    if (!d) throw new Error(`Product ${target} not found.`);
    if (d.priceWithoutDecimal === undefined) {
      throw new Error(`Product ${target} has no price and cannot be added.`);
    }
    return {
      id: d.id,
      name: (d.name ?? d.displayName ?? d.id) as string,
      price: d.priceWithoutDecimal,
      storeId: d.storeId,
    };
  }

  const results = await api.searchProducts(target, { pageSize: 5 });
  const p = results[0];
  if (!p) throw new Error(`No results for "${target}".`);
  if (p.price === undefined) {
    throw new Error(`"${p.name}" has no price and cannot be added.`);
  }
  return { id: p.id, name: p.name, price: p.price, storeId: p.storeId };
}
