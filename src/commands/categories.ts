import chalk from "chalk";
import Table from "cli-table3";
import { getCategories } from "../lib/discovery.js";
import { startSpinner } from "../lib/output.js";

export interface CategoriesOptions {
  json?: boolean;
}

/**
 * List the product categories (department facets) for a search term. The catalog
 * only exposes categories scoped to a query — there is no global department tree
 * endpoint — so a query is required.
 */
export async function categories(
  query: string,
  options: CategoriesOptions = {}
): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner(`Finding categories for "${query}"…`);

  const items = await getCategories(query);
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write(`${chalk.yellow(`No categories found for "${query}".`)}\n`);
    return;
  }

  const table = new Table({
    head: [chalk.bold("Category"), chalk.bold("Items")],
    colWidths: [46, 10],
    style: { head: [], border: [] },
  });
  for (const c of items) {
    table.push([c.name || chalk.dim(c.id), c.count !== null ? String(c.count) : chalk.dim("—")]);
  }
  process.stdout.write(`\n${table.toString()}\n\n`);
}
