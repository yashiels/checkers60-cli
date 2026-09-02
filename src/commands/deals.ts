import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI, type BonusBuy, type Product } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface DealsOptions {
  json?: boolean;
}

/** Count, per deal id, how many returned products qualify for it. */
function qualifyingCounts(products: Product[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of products) {
    for (const id of p.bonusBuyIds ?? []) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** List the current bonus-buy deals for a search term. */
export async function deals(
  query: string,
  options: DealsOptions = {}
): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner(`Finding deals for "${query}"…`);

  const api = new CheckersAPI();
  const { deals: found, products } = await api.getDeals(query);
  spinner?.stop();

  // Distinct deals by id, stable order.
  const seen = new Set<string>();
  const distinct = found.filter((d) => !seen.has(d.id) && seen.add(d.id));

  if (json) {
    process.stdout.write(`${JSON.stringify(distinct, null, 2)}\n`);
    return;
  }

  if (distinct.length === 0) {
    process.stdout.write(`${chalk.yellow(`No deals found for "${query}".`)}\n`);
    return;
  }

  const counts = qualifyingCounts(products);

  process.stdout.write(
    `${chalk.dim(`${distinct.length} deal(s) for "${query}"`)}\n\n`
  );

  const table = new Table({
    head: [
      chalk.bold("Deal"),
      chalk.bold("Valid until"),
      chalk.bold("Members"),
      chalk.bold("In results"),
    ],
    colWidths: [40, 14, 10, 12],
    wordWrap: true,
    style: { head: [], border: [] },
  });

  for (const d of distinct) {
    table.push([
      d.title || d.description || d.id,
      formatValidUntil(d),
      d.membersOnly ? chalk.cyan("Xtra") : chalk.dim("all"),
      String(counts.get(d.id) ?? 0),
    ]);
  }

  process.stdout.write(`${table.toString()}\n`);
  process.stdout.write(
    `\n${chalk.dim('  Terms live in each deal\'s title/description — e.g. "Buy 2 & Save 20%".')}\n`
  );
}

/** Render a deal's `validUntil` ISO string as a plain YYYY-MM-DD, or a dash. */
export function formatValidUntil(deal: BonusBuy): string {
  if (!deal.validUntil) return chalk.dim("—");
  return deal.validUntil.slice(0, 10);
}
