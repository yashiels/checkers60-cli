import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI, type Product, type SearchResult } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface SearchOptions {
  page?: number;
  limit?: number;
  json?: boolean;
  sort?: string;
}

export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<void> {
  const { page = 1, limit = 20, json = false, sort = "Relevance" } = options;

  const spinner = json ? null : startSpinner(`Searching for "${query}"…`);

  const api = new CheckersAPI();
  const result = await api.searchProducts(query, {
    page,
    pageSize: limit,
    sortBy: sort,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  spinner?.stop();

  const products = extractProducts(result);

  if (!products || products.length === 0) {
    process.stdout.write(`${chalk.yellow(`No results for "${query}"`)}\n`);
    return;
  }

  const total = (result as { totalCount?: number }).totalCount ?? products.length;
  process.stdout.write(
    `${chalk.dim(`${total} results for "${query}" (page ${page})`)}\n\n`
  );

  const table = new Table({
    head: [
      chalk.dim("#"),
      chalk.bold("Product"),
      chalk.bold("Price"),
      chalk.bold("Deal"),
      chalk.dim("ID"),
    ],
    colWidths: [5, 40, 12, 20, 15],
    wordWrap: true,
    style: { head: [], border: [] },
  });

  products.forEach((product, i) => {
    const price = formatPrice(product);
    const deal = formatDeal(product);
    const name = formatName(product);

    table.push([
      chalk.dim(`${(page - 1) * limit + i + 1}`),
      name,
      price,
      deal,
      chalk.dim(product.id?.slice(-8) ?? "—"),
    ]);
  });

  process.stdout.write(`${table.toString()}\n`);

  if (total > page * limit) {
    process.stdout.write(
      `\n${chalk.dim(`  Next page: checkers60 search "${query}" --page ${page + 1}`)}\n`
    );
  }
}

export function extractProducts(result: SearchResult): Product[] {
  if (Array.isArray(result.products)) return result.products;
  const items = (result as { items?: unknown }).items;
  if (Array.isArray(items)) return items as Product[];
  const nested = (result as { data?: { products?: unknown } }).data?.products;
  if (Array.isArray(nested)) return nested as Product[];

  // Walk one level deep looking for an array of objects with 'name'
  for (const val of Object.values(result)) {
    if (
      Array.isArray(val) &&
      val.length > 0 &&
      typeof val[0] === "object" &&
      val[0] !== null &&
      "name" in (val[0] as object)
    ) {
      return val as Product[];
    }
  }

  return [];
}

export function formatPrice(product: Product): string {
  const price =
    product.price ?? (product as { sellingPrice?: number }).sellingPrice;
  if (price === undefined || price === null) return chalk.dim("—");

  const original =
    product.originalPrice ??
    (product as { wasPrice?: number }).wasPrice ??
    (product as { originalSellingPrice?: number }).originalSellingPrice;

  if (original && original > price) {
    return `${chalk.green(`R${price.toFixed(2)}`)} ${chalk.dim.strikethrough(
      `R${original.toFixed(2)}`
    )}`;
  }

  return `R${price.toFixed(2)}`;
}

function formatDeal(product: Product): string {
  const promos =
    product.promotions ??
    (product as { promotion?: unknown }).promotion;
  if (!promos) return chalk.dim("—");

  if (Array.isArray(promos) && promos.length > 0) {
    const first = promos[0] as { description?: string; type?: string };
    return chalk.yellow(first.description ?? first.type ?? "Deal");
  }
  if (typeof promos === "object" && "description" in (promos as object)) {
    return chalk.yellow((promos as { description: string }).description);
  }

  return chalk.dim("—");
}

function formatName(product: Product): string {
  let name = product.name ?? "Unknown";
  if (
    product.isVitality ||
    (product as { vitalityEligible?: boolean }).vitalityEligible
  ) {
    name = `💚 ${name}`;
  }
  return name;
}
