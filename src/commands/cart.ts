import chalk from "chalk";
import Table from "cli-table3";
import {
  CheckersAPI,
  type BonusBuy,
  type CartLineItem,
  type Product,
} from "../lib/api.js";
import { formatRand } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export interface CartOptions {
  json?: boolean;
  deals?: boolean;
}

/** One deal and the cart line items whose product qualifies for it. */
interface CartDeal {
  id: string;
  title: string;
  description: string;
  validUntil?: string;
  membersOnly: boolean;
  /** Cart items that belong to this deal — membership only, never a count/threshold. */
  items: { productId: string; name: string | null }[];
}

/**
 * Resolve the cart's line items against their products' bonus-buy deals.
 * Membership only: it reports WHICH cart items qualify for WHICH deal, and never
 * a numeric "X of N" — the buy-threshold lives in the deal's human text, not a
 * clean field, so no progress is fabricated.
 */
async function resolveCartDeals(
  api: CheckersAPI,
  items: CartLineItem[],
  names: Map<string, string>
): Promise<CartDeal[]> {
  const productIds = items.map((i) => i.productId);
  if (productIds.length === 0) return [];

  let products: Product[] = [];
  let dealList: BonusBuy[] = [];
  try {
    const res = await api.getProductsWithDeals(productIds);
    products = res.products;
    dealList = res.deals;
  } catch {
    return [];
  }

  const bonusByProduct = new Map<string, string[]>();
  for (const p of products) {
    if (Array.isArray(p.bonusBuyIds) && p.bonusBuyIds.length > 0) {
      bonusByProduct.set(p.id, p.bonusBuyIds);
    }
  }
  const dealById = new Map(dealList.map((d) => [d.id, d]));

  const byDeal = new Map<string, CartDeal>();
  for (const item of items) {
    for (const dealId of bonusByProduct.get(item.productId) ?? []) {
      const deal = dealById.get(dealId);
      if (!deal) continue;
      let entry = byDeal.get(dealId);
      if (!entry) {
        entry = {
          id: deal.id,
          title: deal.title,
          description: deal.description,
          validUntil: deal.validUntil,
          membersOnly: deal.membersOnly,
          items: [],
        };
        byDeal.set(dealId, entry);
      }
      entry.items.push({
        productId: item.productId,
        name: names.get(item.productId) ?? null,
      });
    }
  }
  return [...byDeal.values()];
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
  const { json = false, deals: withDeals = false } = options;
  const spinner = json ? null : startSpinner("Fetching cart…");

  const api = new CheckersAPI();
  const state = await api.getCart();
  const names = await resolveNames(
    api,
    state.items.map((i) => i.productId)
  );
  const cartDeals = withDeals
    ? await resolveCartDeals(api, state.items, names)
    : [];
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
          ...(withDeals ? { deals: cartDeals } : {}),
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

  if (withDeals) printCartDeals(cartDeals);
}

/** Print the membership-only bonus-buy section for `cart --deals`. */
function printCartDeals(cartDeals: CartDeal[]): void {
  if (cartDeals.length === 0) {
    process.stdout.write(
      `${chalk.dim("  No bonus-buy deals apply to items in your cart.")}\n\n`
    );
    return;
  }

  process.stdout.write(`${chalk.bold(`🏷  Bonus-buy deals (${cartDeals.length})`)}\n`);
  for (const d of cartDeals) {
    process.stdout.write(`\n  ${chalk.bold(d.title || d.id)}`);
    if (d.membersOnly) process.stdout.write(` ${chalk.cyan("[Xtra Savings]")}`);
    process.stdout.write("\n");
    if (d.description && d.description !== d.title) {
      process.stdout.write(`    ${chalk.dim(d.description)}\n`);
    }
    if (d.validUntil) {
      process.stdout.write(`    ${chalk.dim(`valid until ${d.validUntil.slice(0, 10)}`)}\n`);
    }
    process.stdout.write(`    ${chalk.dim("Qualifying items in your cart:")}\n`);
    for (const item of d.items) {
      process.stdout.write(`      • ${item.name ?? item.productId}\n`);
    }
  }
  process.stdout.write(
    `\n${chalk.dim("  Terms (buy-quantity & saving) are in each deal's description.")}\n\n`
  );
}
