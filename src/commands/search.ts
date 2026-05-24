import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import { CheckersAPI, type Product, type SearchResult } from "../lib/api.js";

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

  const spinner = json ? null : ora(`Searching for "${query}"…`).start();

  try {
    const api = new CheckersAPI();
    const result = await api.searchProducts(query, {
      page,
      pageSize: limit,
      sortBy: sort,
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    spinner?.stop();

    const products = extractProducts(result);

    if (!products || products.length === 0) {
      console.log(chalk.yellow(`No results for "${query}"`));
      return;
    }

    const total = (result as any).totalCount ?? products.length;
    console.log(
      chalk.dim(`${total} results for "${query}" (page ${page})\n`)
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

    console.log(table.toString());

    if (total > page * limit) {
      console.log(
        chalk.dim(`\n  Next page: checkers60 search "${query}" --page ${page + 1}`)
      );
    }
  } catch (err) {
    spinner?.fail("Search failed");
    if (err instanceof Error) {
      console.error(chalk.red(err.message));
    }
    process.exit(1);
  }
}

function extractProducts(result: SearchResult): Product[] {
  // The API response structure may vary — try common patterns
  if (Array.isArray(result.products)) return result.products;
  if (Array.isArray((result as any).items)) return (result as any).items;
  if (Array.isArray((result as any).data?.products))
    return (result as any).data.products;

  // Walk one level deep looking for an array of objects with 'name' and 'price'
  for (const val of Object.values(result)) {
    if (Array.isArray(val) && val.length > 0 && val[0]?.name) {
      return val as Product[];
    }
  }

  return [];
}

function formatPrice(product: Product): string {
  const price = product.price ?? (product as any).sellingPrice;
  if (!price) return chalk.dim("—");

  const original =
    product.originalPrice ?? (product as any).wasPrice ?? (product as any).originalSellingPrice;

  if (original && original > price) {
    return `${chalk.green(`R${price.toFixed(2)}`)} ${chalk.dim.strikethrough(
      `R${original.toFixed(2)}`
    )}`;
  }

  return `R${price.toFixed(2)}`;
}

function formatDeal(product: Product): string {
  const promos = product.promotions ?? (product as any).promotion;
  if (!promos) return chalk.dim("—");

  if (Array.isArray(promos) && promos.length > 0) {
    return chalk.yellow(promos[0].description ?? promos[0].type ?? "Deal");
  }
  if (typeof promos === "object" && promos.description) {
    return chalk.yellow(promos.description);
  }

  return chalk.dim("—");
}

function formatName(product: Product): string {
  let name = product.name ?? "Unknown";
  if (product.isVitality || (product as any).vitalityEligible) {
    name = `💚 ${name}`;
  }
  return name;
}
