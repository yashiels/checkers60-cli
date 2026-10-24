import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI, type BonusBuy, type Product } from "../lib/api.js";
import { formatRand } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";
import { summarizeCart } from "../lib/cart-summary.js";
import { resolveServiceOption } from "../lib/cart-mutate.js";
import { classifyError } from "../lib/errors.js";

export interface CartOptions {
  json?: boolean;
  deals?: boolean;
  mode?: string;
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
  items: { productId: string }[],
  names: Map<string, string>
): Promise<{ deals: CartDeal[]; error: string | null }> {
  const productIds = items.map((i) => i.productId);
  if (productIds.length === 0) return { deals: [], error: null };

  let products: Product[] = [];
  let dealList: BonusBuy[] = [];
  try {
    const res = await api.getProductsWithDeals(productIds);
    products = res.products;
    dealList = res.deals;
  } catch (err) {
    // Never silently report "no deals" on a lookup failure — surface a
    // sanitized reason so the caller can say deals are unavailable, not absent.
    return { deals: [], error: classifyError(err).message };
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
  return { deals: [...byDeal.values()], error: null };
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

export async function cart(options: CartOptions = {}): Promise<void> {
  const { json = false, deals: withDeals = false } = options;
  const serviceOptionId =
    options.mode === undefined ? undefined : resolveServiceOption(options.mode);
  const spinner = json ? null : startSpinner('Fetching carts…');
  const api = new CheckersAPI();
  let carts;
  try {
    const snapshot = await api.getCarts();
    const selected = snapshot.carts.filter(
      (state) => serviceOptionId === undefined || state.serviceOptionId === serviceOptionId,
    );
    const names = await resolveNames(api, [
      ...new Set(
        selected.flatMap((state) => state.lineItems.map((item) => String(item.productId))),
      ),
    ]);
    carts = await Promise.all(
      selected.map(async (state) => {
        const items = state.lineItems.map((item) => ({
          productId: String(item.productId),
          name: names.get(String(item.productId)) ?? null,
          quantity: Number(item.quantity),
          price: Number(item.price),
        }));
        const { deals, error: dealsError } = withDeals
          ? await resolveCartDeals(api, items, names)
          : { deals: [], error: null };
        return {
          ...summarizeCart(state),
          items,
          ...(withDeals ? { deals, dealsError } : {}),
        };
      }),
    );
  } finally {
    spinner?.stop();
  }
  const primary = carts.find((state) => state.serviceOptionId === 'sixty-min-delivery') ?? carts[0];
  const grandTotal = carts.reduce((sum, state) => sum + state.total, 0);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cartId: primary?.cartId ?? null,
          cartVersion: primary?.cartVersion ?? 0,
          itemCount: primary?.itemCount ?? 0,
          total: primary?.total ?? 0,
          items: primary?.items ?? [],
          ...(withDeals
            ? { deals: primary?.deals ?? [], dealsError: primary?.dealsError ?? null }
            : {}),
          carts,
          grandTotal,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (carts.length === 0) {
    process.stdout.write(`${chalk.yellow('No carts available for this selection.')}\n`);
  }
  for (const state of carts) {
    process.stdout.write(`\n${chalk.bold(`${state.mode} cart`)}\n`);
    if (state.items.length === 0) {
      process.stdout.write(`${chalk.yellow('Your cart is empty.')}\n`);
    } else {
      const table = new Table({
        head: ['Product', 'Qty', 'Unit', 'Subtotal'].map((label) => chalk.bold(label)),
        colWidths: [44, 6, 12, 12],
        wordWrap: true,
        style: { head: [], border: [] },
      });
      for (const item of state.items) {
        table.push([
          item.name ?? item.productId,
          String(item.quantity),
          formatRand(item.price),
          formatRand(item.price * item.quantity),
        ]);
      }
      process.stdout.write(`${table.toString()}\n`);
    }
    process.stdout.write(
      `${chalk.bold(`  Total: ${formatRand(state.total)}`)} ${chalk.dim(`(${state.itemCount} items)`)}\n\n`,
    );
    if (withDeals) printCartDeals(state.deals ?? [], state.dealsError ?? null);
  }
  process.stdout.write(`${chalk.bold(`Grand total: ${formatRand(grandTotal)}`)}\n`);
}

/** Print the membership-only bonus-buy section for `cart --deals`. */
function printCartDeals(cartDeals: CartDeal[], dealsError: string | null): void {
  if (dealsError) {
    process.stdout.write(
      `${chalk.yellow(`  Bonus-buy deals unavailable: ${dealsError}`)}\n\n`
    );
    return;
  }
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
