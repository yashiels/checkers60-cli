import chalk from "chalk";
import { CheckersAPI, mapCatalogProduct } from "../lib/api.js";
import { formatRand } from "../lib/format.js";
import { formatValidUntil } from "./deals.js";
import { startSpinner } from "../lib/output.js";

export interface ShowOptions {
  json?: boolean;
}

/** Show product detail plus any bonus-buy deals the product belongs to. */
export async function show(id: string, options: ShowOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner(`Fetching ${id}…`);

  const api = new CheckersAPI();
  const { raw, deals } = await api.getProductDetail(id);
  spinner?.stop();

  if (!raw) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ error: "not-found", id }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${chalk.yellow(`Product ${id} not found.`)}\n`);
    return;
  }

  const product = mapCatalogProduct(raw);

  if (json) {
    process.stdout.write(`${JSON.stringify({ product, deals }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold(product.name || product.id)}\n`);
  process.stdout.write(`${chalk.dim("ID:      ")}${product.id}\n`);
  process.stdout.write(`${chalk.dim("Price:   ")}${formatRand(product.price)}\n`);
  if (product.oldPrice !== undefined && product.oldPrice !== product.price) {
    process.stdout.write(`${chalk.dim("Was:     ")}${formatRand(product.oldPrice)}\n`);
  }
  process.stdout.write(
    `${chalk.dim("Stock:   ")}${
      typeof product.stock === "number" ? String(product.stock) : "—"
    }\n`
  );

  if (deals.length === 0) {
    process.stdout.write(`\n${chalk.dim("No bonus-buy deals for this product.")}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold(`🏷  Deals (${deals.length})`)}\n`);
  for (const d of deals) {
    process.stdout.write(`  ${chalk.bold(d.title || d.id)}\n`);
    if (d.description && d.description !== d.title) {
      process.stdout.write(`    ${chalk.dim(d.description)}\n`);
    }
    const bits: string[] = [];
    if (d.membersOnly) bits.push("Xtra Savings members only");
    if (d.validUntil) bits.push(`valid until ${formatValidUntil(d)}`);
    if (bits.length) process.stdout.write(`    ${chalk.dim(bits.join(" · "))}\n`);
  }
}
