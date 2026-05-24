#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  );
  version = pkg.version;
} catch {}

const program = new Command()
  .name("checkers60")
  .description("CLI for Checkers Sixty60 grocery delivery")
  .version(version);

// ── login ──────────────────────────────────────────────────────────────
program
  .command("login")
  .description("Log in to Checkers via browser (phone + OTP)")
  .option("--headless", "Run browser in headless mode", false)
  .action(async (opts) => {
    const { login } = await import("./commands/login.js");
    await login({ headless: opts.headless });
  });

// ── logout ─────────────────────────────────────────────────────────────
program
  .command("logout")
  .description("Clear saved session and config")
  .action(async () => {
    const { logout } = await import("./commands/logout.js");
    await logout();
  });

// ── status ─────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show login status and config")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const { status } = await import("./commands/status.js");
    await status({ json: opts.json });
  });

// ── search ─────────────────────────────────────────────────────────────
program
  .command("search <query>")
  .description("Search for products")
  .option("-p, --page <n>", "Page number", "1")
  .option("-l, --limit <n>", "Results per page", "20")
  .option("-s, --sort <sort>", "Sort by: Relevance, PriceLowToHigh, PriceHighToLow", "Relevance")
  .option("--json", "Output JSON", false)
  .action(async (query, opts) => {
    const { search } = await import("./commands/search.js");
    await search(query, {
      page: parseInt(opts.page, 10),
      limit: parseInt(opts.limit, 10),
      sort: opts.sort,
      json: opts.json,
    });
  });

// ── slots ──────────────────────────────────────────────────────────────
program
  .command("slots")
  .description("Show available delivery time slots")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const { CheckersAPI } = await import("./lib/api.js");
    const api = new CheckersAPI();
    const slots = await api.getDeliverySlots();
    if (opts.json) {
      console.log(JSON.stringify(slots, null, 2));
    } else {
      console.log(JSON.stringify(slots, null, 2)); // TODO: pretty print
    }
  });

// ── categories ─────────────────────────────────────────────────────────
program
  .command("categories")
  .description("Browse product categories")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const { CheckersAPI } = await import("./lib/api.js");
    const api = new CheckersAPI();
    const tree = await api.getCategoryTree();
    if (opts.json) {
      console.log(JSON.stringify(tree, null, 2));
    } else {
      console.log(JSON.stringify(tree, null, 2)); // TODO: pretty print
    }
  });

// ── trending ───────────────────────────────────────────────────────────
program
  .command("trending")
  .description("Show popular/trending searches")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const { CheckersAPI } = await import("./lib/api.js");
    const api = new CheckersAPI();
    const popular = await api.getPopularSearches();
    if (opts.json) {
      console.log(JSON.stringify(popular, null, 2));
    } else {
      console.log(JSON.stringify(popular, null, 2)); // TODO: pretty print
    }
  });

program.parse();
