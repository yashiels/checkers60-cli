import chalk from "chalk";
import { CheckersAPI } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface TrendingOptions {
  json?: boolean;
}

export async function trending(options: TrendingOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching popular searches…");

  const api = new CheckersAPI();
  const raw = await api.getPopularSearches();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
    return;
  }

  const terms = extractTerms(raw);
  if (terms.length === 0) {
    process.stdout.write(`${chalk.yellow("No trending searches returned.")}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold("Popular searches")}\n\n`);
  const width = String(terms.length).length;
  terms.forEach((term, i) => {
    const idx = String(i + 1).padStart(width, " ");
    process.stdout.write(`  ${chalk.dim(`${idx}.`)} ${term}\n`);
  });
  process.stdout.write("\n");
}

function extractTerms(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(termFrom).filter(Boolean) as string[];
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.popularSearches,
    obj.searches,
    obj.terms,
    obj.items,
    (obj.data as Record<string, unknown> | undefined)?.popularSearches,
    (obj.data as Record<string, unknown> | undefined)?.searches,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.map(termFrom).filter(Boolean) as string[];
  }
  return [];
}

function termFrom(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const v = o.term ?? o.text ?? o.query ?? o.name ?? o.label;
    if (typeof v === "string") return v;
  }
  return null;
}
