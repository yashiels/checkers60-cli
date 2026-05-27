import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI, type Product } from "../lib/api.js";
import { formatRand } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export interface SearchOptions {
  page?: number;
  limit?: number;
  json?: boolean;
}

export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<void> {
  const { page = 1, limit = 20, json = false } = options;

  const spinner = json ? null : startSpinner(`Searching for "${query}"…`);

  const api = new CheckersAPI();
  // The catalog API is zero-indexed; the CLI exposes 1-indexed pages.
  const products = await api.searchProducts(query, {
    page: Math.max(0, page - 1),
    pageSize: limit,
  });

  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(products, null, 2)}\n`);
    return;
  }

  if (products.length === 0) {
    process.stdout.write(`${chalk.yellow(`No results for "${query}"`)}\n`);
    return;
  }

  process.stdout.write(
    `${chalk.dim(`${products.length} results for "${query}" (page ${page})`)}\n\n`
  );

  const table = new Table({
    head: [
      chalk.dim("#"),
      chalk.bold("Product"),
      chalk.bold("Price"),
      chalk.bold("Stock"),
      chalk.dim("ID"),
    ],
    colWidths: [5, 42, 12, 9, 28],
    wordWrap: true,
    style: { head: [], border: [] },
  });

  products.forEach((product, i) => {
    table.push([
      chalk.dim(`${(page - 1) * limit + i + 1}`),
      formatName(product),
      formatPrice(product),
      formatStock(product),
      chalk.dim(product.id ?? "—"),
    ]);
  });

  process.stdout.write(`${table.toString()}\n`);

  if (products.length === limit) {
    process.stdout.write(
      `\n${chalk.dim(`  Next page: checkers60 search "${query}" --page ${page + 1}`)}\n`
    );
  }
}

/** Format a product's price (cents) as Rand, marking out-of-stock items. */
export function formatPrice(product: Product): string {
  if (product.price === undefined || product.price === null) return chalk.dim("—");
  return formatRand(product.price);
}

export function formatName(product: Product): string {
  let name = product.name || "Unknown";
  if (Array.isArray(product.promotions) && product.promotions.length > 0) {
    name = `🏷️  ${name}`;
  }
  return name;
}

function formatStock(product: Product): string {
  if (product.active === false) return chalk.red("out");
  if (typeof product.stock === "number") {
    return product.stock > 0 ? chalk.green(String(product.stock)) : chalk.red("0");
  }
  return chalk.dim("—");
}
