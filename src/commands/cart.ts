import chalk from "chalk";
import Table from "cli-table3";
import {
  CheckersAPI,
  type Cart,
  type CartLineItem,
  type CartState,
  type Product,
} from "../lib/api.js";
import { startSpinner } from "../lib/output.js";
import { UsageError } from "../lib/errors.js";

export interface CartCommonOptions {
  json?: boolean;
}

export interface CartAddOptions extends CartCommonOptions {
  qty?: number;
  hyper?: boolean;
}

export interface CartClearOptions extends CartCommonOptions {
  confirm?: boolean;
}

const SIXTY_MIN = "sixty-min-delivery" as const;
const ONE_DAY = "one-day-delivery" as const;

export async function view(options: CartCommonOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching cart…");

  const api = new CheckersAPI();
  const state = await api.fetchCart();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  renderCart(state);
}

export async function add(
  productId: string,
  options: CartAddOptions = {}
): Promise<void> {
  if (!productId || productId.trim().length === 0) {
    throw new UsageError("Product ID is required.");
  }
  const qty = options.qty ?? 1;
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new UsageError("--qty must be a positive number.");
  }
  const serviceOption = options.hyper ? ONE_DAY : SIXTY_MIN;

  const spinner = options.json ? null : startSpinner("Looking up product…");
  const api = new CheckersAPI();
  const product = await api.getProduct(productId);
  spinner?.stop();

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "stub",
          action: "add",
          product,
          quantity: qty,
          serviceOptionId: serviceOption,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const name = product.name ?? product.displayName ?? "Unknown product";
  const price = priceField(product);
  const priceStr = price !== null ? `R${price.toFixed(2)}` : chalk.dim("—");
  process.stdout.write(
    `${chalk.yellow(
      "Cart add is not yet implemented for safety."
    )}\n`
  );
  process.stdout.write(
    `${chalk.dim("Would add:")} ${chalk.bold(name)} × ${qty} @ ${priceStr} (${
      options.hyper ? "Hyper / one-day" : "Sixty60"
    })\n`
  );
  process.stdout.write(
    `${chalk.dim(`Product found: ${name} ${priceStr}`)}\n`
  );
}

export async function remove(
  itemId: string,
  options: CartCommonOptions = {}
): Promise<void> {
  if (!itemId || itemId.trim().length === 0) {
    throw new UsageError("Item ID is required.");
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        { status: "stub", action: "remove", itemId },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.yellow("Cart remove is not yet implemented for safety.")}\n`
  );
  process.stdout.write(`${chalk.dim(`Would remove line item: ${itemId}`)}\n`);
}

export async function clear(options: CartClearOptions = {}): Promise<void> {
  if (!options.confirm) {
    throw new UsageError(
      "Refusing to clear without --confirm. Re-run with: checkers60 cart clear --confirm"
    );
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ status: "stub", action: "clear" }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.yellow("Cart clear is not yet implemented for safety.")}\n`
  );
  process.stdout.write(`${chalk.dim("Would clear all line items.")}\n`);
}

export async function suggestions(
  options: CartCommonOptions = {}
): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching suggestions…");

  const api = new CheckersAPI();
  const state = await api.fetchCart();
  const { cartIds, storeIds } = collectCartAndStoreIds(state);
  const raw = await api.getCartSuggestions(cartIds, storeIds);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
    return;
  }

  const items = extractSuggestionProducts(raw);
  if (items.length === 0) {
    process.stdout.write(`${chalk.yellow("No suggestions returned.")}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold("Have you forgotten…")}\n\n`);
  const width = String(items.length).length;
  items.forEach((p, i) => {
    const idx = String(i + 1).padStart(width, " ");
    const name = p.name ?? p.displayName ?? "Unknown";
    const price = priceField(p);
    const priceStr = price !== null ? chalk.green(`R${price.toFixed(2)}`) : chalk.dim("—");
    const category = (p.category as string | undefined) ?? "";
    const catStr = category ? chalk.dim(` · ${category}`) : "";
    process.stdout.write(`  ${chalk.dim(`${idx}.`)} ${name} ${priceStr}${catStr}\n`);
  });
  process.stdout.write("\n");
}

export async function promos(options: CartCommonOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching cart promotions…");

  const api = new CheckersAPI();
  const state = await api.fetchCart();
  const cartId = state.sixtyMinCart?.id ?? state.oneDayCart?.id;
  if (!cartId) {
    spinner?.stop();
    if (json) {
      process.stdout.write(`${JSON.stringify({ promotions: [] }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${chalk.yellow("No cart found to fetch promotions for.")}\n`);
    return;
  }

  const raw = await api.getCartPromotions(cartId);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
    return;
  }

  const list = extractPromotions(raw);
  if (list.length === 0) {
    process.stdout.write(`${chalk.yellow("No active cart promotions.")}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold("Cart promotions")}\n\n`);
  list.forEach((promo, i) => {
    const name =
      (promo.title as string | undefined) ??
      (promo.name as string | undefined) ??
      (promo.description as string | undefined) ??
      `Promotion ${i + 1}`;
    process.stdout.write(`  ${chalk.cyan("•")} ${name}\n`);
    const desc = promo.description as string | undefined;
    if (desc && desc !== name) {
      process.stdout.write(`    ${chalk.dim(desc)}\n`);
    }
  });
  process.stdout.write("\n");
}

// ── helpers ────────────────────────────────────────────────────────────

export function renderCart(state: CartState): void {
  const sixty = state.sixtyMinCart;
  const oneDay = state.oneDayCart;

  const sixtyEmpty = !sixty || sixty.lineItems.length === 0;
  const oneDayEmpty = !oneDay || oneDay.lineItems.length === 0;

  if (sixtyEmpty && oneDayEmpty) {
    process.stdout.write(`${chalk.yellow("Your cart is empty.")}\n`);
    return;
  }

  if (sixty && sixty.lineItems.length > 0) {
    renderCartSection("Sixty60", sixty);
  }
  if (oneDay && oneDay.lineItems.length > 0) {
    renderCartSection("Hyper / One-day", oneDay);
  }

  const grand =
    (sixty?.lineItemTotals?.cartTotalAfterDiscounts ?? 0) +
    (oneDay?.lineItemTotals?.cartTotalAfterDiscounts ?? 0);
  process.stdout.write(
    `\n${chalk.bold("Grand total:")} ${chalk.green(formatCents(grand))}\n\n`
  );
}

function renderCartSection(label: string, cart: Cart): void {
  const max = cart.maximumCartSize;
  const headerSuffix = max
    ? chalk.dim(` (${cart.lineItems.length} / ${max} items)`)
    : chalk.dim(` (${cart.lineItems.length} items)`);
  process.stdout.write(`\n${chalk.bold(label)}${headerSuffix}\n`);

  const table = new Table({
    head: [
      chalk.bold("Product"),
      chalk.bold("Qty"),
      chalk.bold("Price"),
      chalk.bold("Total"),
      chalk.dim("Item ID"),
    ],
    colWidths: [40, 6, 12, 12, 12],
    wordWrap: true,
    style: { head: [], border: [] },
  });

  for (const item of cart.lineItems) {
    table.push([
      formatLineItemName(item),
      String(item.quantity),
      formatCents(item.price),
      formatCents(item.price * item.quantity),
      chalk.dim(item.id.slice(-8)),
    ]);
  }
  process.stdout.write(`${table.toString()}\n`);

  const totals = cart.lineItemTotals;
  if (totals) {
    process.stdout.write(
      `${chalk.dim("  Subtotal:")} ${formatCents(totals.productTotal)}\n`
    );
    if (totals.discountTotal && totals.discountTotal > 0) {
      process.stdout.write(
        `${chalk.dim("  Savings: ")} ${chalk.green(`-${formatCents(totals.discountTotal)}`)}\n`
      );
    }
    process.stdout.write(
      `${chalk.bold("  Total:    ")} ${chalk.green(formatCents(totals.cartTotalAfterDiscounts))}\n`
    );
  }
}

export function formatCents(cents: number | undefined | null): string {
  if (cents === undefined || cents === null || !Number.isFinite(cents)) {
    return "R0.00";
  }
  return `R${(cents / 100).toFixed(2)}`;
}

export function formatLineItemName(item: CartLineItem): string {
  const product = item.product as
    | (Product & { displayName?: string; unitOfMeasure?: string })
    | undefined;
  const name = product?.displayName ?? product?.name ?? "Unknown";
  const uom = product?.unitOfMeasure;
  return uom ? `${name} ${chalk.dim(`(${uom})`)}` : name;
}

export function isCartFull(cart: Cart): boolean {
  if (!cart.maximumCartSize) return false;
  return cart.lineItems.length >= cart.maximumCartSize;
}

function priceField(product: Product): number | null {
  const p =
    product.price ??
    (product as { sellingPrice?: number }).sellingPrice ??
    null;
  if (p === null || p === undefined || !Number.isFinite(p)) return null;
  return p;
}

function collectCartAndStoreIds(state: CartState): {
  cartIds: string[];
  storeIds: string[];
} {
  const cartIds: string[] = [];
  const storeIds = new Set<string>();
  for (const cart of [state.sixtyMinCart, state.oneDayCart]) {
    if (!cart) continue;
    if (cart.id) cartIds.push(cart.id);
    for (const li of cart.lineItems) {
      if (li.storeId) storeIds.add(li.storeId);
    }
  }
  return { cartIds, storeIds: Array.from(storeIds) };
}

function extractSuggestionProducts(raw: unknown): Product[] {
  if (Array.isArray(raw)) return raw as Product[];
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.products,
    obj.suggestions,
    obj.items,
    (obj.data as Record<string, unknown> | undefined)?.products,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Product[];
  }
  return [];
}

function extractPromotions(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.promotions,
    obj.cartPromotions,
    obj.items,
    (obj.data as Record<string, unknown> | undefined)?.promotions,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Array<Record<string, unknown>>;
  }
  return [];
}
