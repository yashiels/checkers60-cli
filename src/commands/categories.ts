import chalk from "chalk";
import { CheckersAPI } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface CategoriesOptions {
  json?: boolean;
}

interface CategoryNode {
  id?: string;
  name?: string;
  label?: string;
  title?: string;
  children?: CategoryNode[];
  subCategories?: CategoryNode[];
  categories?: CategoryNode[];
  [key: string]: unknown;
}

export async function categories(options: CategoriesOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching category tree…");

  const api = new CheckersAPI();
  const raw = await api.getCategoryTree();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
    return;
  }

  const roots = extractRoots(raw);
  if (roots.length === 0) {
    process.stdout.write(`${chalk.yellow("No categories returned.")}\n`);
    return;
  }

  process.stdout.write("\n");
  for (const node of roots) {
    printNode(node, 0);
  }
  process.stdout.write("\n");
}

function extractRoots(raw: unknown): CategoryNode[] {
  if (Array.isArray(raw)) return raw as CategoryNode[];
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.categories,
    obj.tree,
    obj.children,
    (obj.data as Record<string, unknown> | undefined)?.categories,
    (obj.data as Record<string, unknown> | undefined)?.tree,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as CategoryNode[];
  }
  return [];
}

function childrenOf(node: CategoryNode): CategoryNode[] {
  return node.children ?? node.subCategories ?? node.categories ?? [];
}

function nameOf(node: CategoryNode): string {
  return node.name ?? node.label ?? node.title ?? "(unnamed)";
}

function printNode(node: CategoryNode, depth: number): void {
  const indent = "  ".repeat(depth);
  const marker = depth === 0 ? chalk.cyan("●") : chalk.dim("○");
  const name = depth === 0 ? chalk.bold(nameOf(node)) : nameOf(node);
  process.stdout.write(`${indent}${marker} ${name}\n`);
  for (const child of childrenOf(node)) {
    printNode(child, depth + 1);
  }
}
