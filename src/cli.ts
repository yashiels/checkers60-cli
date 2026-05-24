#!/usr/bin/env node

import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configureOutput } from "./lib/output.js";
import { wrap, EXIT_USAGE } from "./lib/errors.js";

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
  .version(version)
  .addOption(new Option("--no-color", "disable colored output (respects NO_COLOR)"))
  .addOption(new Option("-q, --quiet", "suppress non-essential output").default(false))
  .addOption(new Option("-v, --verbose", "show extra debug info").default(false))
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{
      color?: boolean;
      quiet?: boolean;
      verbose?: boolean;
    }>();
    configureOutput({
      // Commander negates --no-color into opts.color === false
      noColor: opts.color === false,
      quiet: opts.quiet,
      verbose: opts.verbose,
    });
  })
  .showHelpAfterError()
  .exitOverride((err) => {
    // Invalid usage → exit 2 per clig.dev
    if (err.code === "commander.unknownCommand" || err.code === "commander.unknownOption") {
      process.exit(EXIT_USAGE);
    }
    process.exit(err.exitCode ?? 0);
  });

program.addHelpText(
  "after",
  `
Quick start:
  $ checkers60 login          # Log in with your phone number
  $ checkers60 search "milk"  # Search for products
  $ checkers60 slots          # Check delivery times
  $ checkers60 status         # Check your session

Exit codes:
  0  success
  1  runtime failure
  2  invalid usage
`
);

// ── login ──────────────────────────────────────────────────────────────
program
  .command("login")
  .description("Log in to Checkers via browser (phone + OTP)")
  .option("--headless", "Run browser in headless mode", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 login              # Open a visible browser to enter your OTP
  $ checkers60 login --headless   # Reuse an existing session without UI
`
  )
  .action(
    wrap(async (opts: { headless?: boolean }) => {
      const { login } = await import("./commands/login.js");
      await login({ headless: opts.headless });
    })
  );

// ── logout ─────────────────────────────────────────────────────────────
program
  .command("logout")
  .description("Clear saved session and config")
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 logout
`
  )
  .action(
    wrap(async () => {
      const { logout } = await import("./commands/logout.js");
      await logout();
    })
  );

// ── status ─────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show login status and config")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 status
  $ checkers60 status --json
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { status } = await import("./commands/status.js");
      await status({ json: opts.json });
    })
  );

// ── search ─────────────────────────────────────────────────────────────
program
  .command("search <query>")
  .description("Search for products")
  .option("-p, --page <n>", "Page number", "1")
  .option("-l, --limit <n>", "Results per page", "20")
  .option(
    "-s, --sort <sort>",
    "Sort by: Relevance, PriceLowToHigh, PriceHighToLow",
    "Relevance"
  )
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 search "milk"
  $ checkers60 search "bread" --limit 10 --sort PriceLowToHigh
`
  )
  .action(
    wrap(
      async (
        query: string,
        opts: { page: string; limit: string; sort: string; json?: boolean }
      ) => {
        const { search } = await import("./commands/search.js");
        await search(query, {
          page: parseInt(opts.page, 10),
          limit: parseInt(opts.limit, 10),
          sort: opts.sort,
          json: opts.json,
        });
      }
    )
  );

// ── slots ──────────────────────────────────────────────────────────────
program
  .command("slots")
  .description("Show available delivery time slots")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 slots
  $ checkers60 slots --json
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { slots } = await import("./commands/slots.js");
      await slots({ json: opts.json });
    })
  );

// ── categories ─────────────────────────────────────────────────────────
program
  .command("categories")
  .description("Browse product categories")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 categories
  $ checkers60 categories --json
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { categories } = await import("./commands/categories.js");
      await categories({ json: opts.json });
    })
  );

// ── trending ───────────────────────────────────────────────────────────
program
  .command("trending")
  .description("Show popular/trending searches")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 trending
  $ checkers60 trending --json
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { trending } = await import("./commands/trending.js");
      await trending({ json: opts.json });
    })
  );

program.parseAsync().catch(() => {
  // wrap()/exitOverride() already handle exit codes; this guards
  // against unexpected commander errors.
  process.exit(1);
});
