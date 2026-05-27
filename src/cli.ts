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
  .description("CLI for Checkers Sixty60 grocery delivery (mobile-app API)")
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
Setup (environment variables):
  CHECKERS60_MOBILE         Your mobile number, e.g. +27821234567 (required to log in)
  CHECKERS60_USER_ID        Sixty60 user id (needed for addresses, cards, orders)
  CHECKERS60_SHOPRITE_UUID  Shoprite customer UUID
  CHECKERS60_EMAIL          Account email
  CHECKERS60_ADDRESS_ID     Default delivery address id
  CHECKERS60_STORES         JSON array of store contexts (defaults to Rondebosch)

Quick start:
  $ checkers60 login                 # Send an OTP to your phone
  $ checkers60 otp-verify <ref> 1234 # Verify the code from the SMS
  $ checkers60 search "milk"         # Search for products
  $ checkers60 add "milk" 2          # Add to cart
  $ checkers60 cart                  # View your cart

Cart management:
  $ checkers60 cart                    # View your cart
  $ checkers60 cart suggestions        # See recommended items
  $ checkers60 cart promos             # See cart promotions

Exit codes:
  0  success
  1  runtime failure
  2  invalid usage
`
);

// ── login / otp-trigger ──────────────────────────────────────────────────
program
  .command("otp-trigger")
  .alias("login")
  .description("Send a login OTP to your phone (step 1 of 2)")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 login          # sends an SMS and prints a reference
  $ checkers60 otp-trigger    # same as login
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { otpTrigger } = await import("./commands/login.js");
      await otpTrigger({ json: opts.json });
    })
  );

// ── otp-verify ─────────────────────────────────────────────────────────────
program
  .command("otp-verify <reference> <code>")
  .description("Verify the OTP code and save your session (step 2 of 2)")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 otp-verify 4f1a9c2e 1234
`
  )
  .action(
    wrap(async (reference: string, code: string, opts: { json?: boolean }) => {
      const { otpVerify } = await import("./commands/login.js");
      await otpVerify(reference, code, { json: opts.json });
    })
  );

// ── logout ─────────────────────────────────────────────────────────────
program
  .command("logout")
  .description("Clear saved tokens")
  .action(
    wrap(async () => {
      const { logout } = await import("./commands/logout.js");
      await logout();
    })
  );

// ── status ─────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show login status, token expiry and cart summary")
  .option("--json", "Output JSON", false)
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
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 search "milk"
  $ checkers60 search "bread" --limit 10 --page 2
`
  )
  .action(
    wrap(async (query: string, opts: { page: string; limit: string; json?: boolean }) => {
      const { search } = await import("./commands/search.js");
      await search(query, {
        page: parseInt(opts.page, 10),
        limit: parseInt(opts.limit, 10),
        json: opts.json,
      });
    })
  );

// ── cart ───────────────────────────────────────────────────────────────
program
  .command("cart")
  .description("Show cart contents")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { cart } = await import("./commands/cart.js");
      await cart({ json: opts.json });
    })
  );

// ── add ────────────────────────────────────────────────────────────────
program
  .command("add <target> [qty]")
  .description("Add a product to the cart by search term or product id")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 add "simple truth coconut water" 3
  $ checkers60 add 5d3b1d78e2f18700089552a8
`
  )
  .action(
    wrap(async (target: string, qty: string | undefined, opts: { json?: boolean }) => {
      const { add } = await import("./commands/add.js");
      await add(target, qty ? parseInt(qty, 10) : 1, { json: opts.json });
    })
  );

// ── remove ─────────────────────────────────────────────────────────────
program
  .command("remove <target>")
  .description("Remove a product from the cart by name or product id")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 remove "coconut water"
  $ checkers60 remove 5d3b1d78e2f18700089552a8
`
  )
  .action(
    wrap(async (target: string, opts: { json?: boolean }) => {
      const { remove } = await import("./commands/remove.js");
      await remove(target, { json: opts.json });
    })
  );

// ── clear ──────────────────────────────────────────────────────────────
program
  .command("clear")
  .description("Empty the cart")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { clear } = await import("./commands/clear.js");
      await clear({ json: opts.json });
    })
  );

// ── addresses ──────────────────────────────────────────────────────────
program
  .command("addresses")
  .description("List delivery addresses")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { addresses } = await import("./commands/addresses.js");
      await addresses({ json: opts.json });
    })
  );

// ── cards ──────────────────────────────────────────────────────────────
program
  .command("cards")
  .description("List saved payment cards")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { cards } = await import("./commands/cards.js");
      await cards({ json: opts.json });
    })
  );

// ── orders ─────────────────────────────────────────────────────────────
program
  .command("orders")
  .description("Show your orders (active by default)")
  .option("--all", "Include past orders", false)
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 orders
  $ checkers60 orders --all
`
  )
  .action(
    wrap(async (opts: { all?: boolean; json?: boolean }) => {
      const { orders } = await import("./commands/orders.js");
      await orders({ all: opts.all, json: opts.json });
    })
  );

// ── profile ────────────────────────────────────────────────────────────
program
  .command("profile")
  .description("Show your user profile")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { profile } = await import("./commands/profile.js");
      await profile({ json: opts.json });
    })
  );

// ── slots ──────────────────────────────────────────────────────────────
program
  .command("slots")
  .description("Show delivery slots for the current cart")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { slots } = await import("./commands/slots.js");
      await slots({ json: opts.json });
    })
  );

// ── categories ─────────────────────────────────────────────────────────
program
  .command("categories")
  .description("Browse product categories (not exposed by the mobile API)")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { categories } = await import("./commands/categories.js");
      await categories({ json: opts.json });
    })
  );

// ── trending ───────────────────────────────────────────────────────────
program
  .command("trending")
  .description("Show trending searches (not exposed by the mobile API)")
  .option("--json", "Output JSON", false)
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
