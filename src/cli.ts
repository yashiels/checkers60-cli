#!/usr/bin/env node

import { Command, CommanderError, Option } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configureOutput, isJson } from "./lib/output.js";
import { initRuntime } from "./lib/runtime.js";
import { wrap, handleError, UsageError, EXIT_USAGE } from "./lib/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  );
  version = pkg.version;
} catch {}

/** Detect JSON mode from argv (`--json` anywhere) or `CHECKERS60_JSON` env. */
function detectJson(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes("--json")) return true;
  const v = env.CHECKERS60_JSON;
  return (
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
  );
}

// Resolve JSON mode BEFORE commander parses, so usage errors are JSON too and
// commander's own output is buffered/suppressed appropriately.
const jsonMode = detectJson(process.argv, process.env);
configureOutput({ json: jsonMode });

// In JSON mode we buffer commander's own writes (help/version/error text) so it
// can never leak before our single JSON envelope. On help/version success we
// flush; on any usage failure we discard and emit exactly one envelope.
const outBuffer: string[] = [];
const errBuffer: string[] = [];

/** Merge the global/env JSON flag with a per-command `--json` (explicit OR). */
function mergeJson(opts?: { json?: boolean }): boolean {
  return isJson() || Boolean(opts?.json);
}

const program = new Command()
  .name("checkers60")
  .description("CLI for Checkers Sixty60 grocery delivery (mobile-app API)")
  .version(version)
  .addOption(new Option("--no-color", "disable colored output (respects NO_COLOR)"))
  .addOption(new Option("-q, --quiet", "suppress non-essential output").default(false))
  .addOption(new Option("-v, --verbose", "show extra debug info").default(false))
  .addOption(new Option("--json", "output machine-readable JSON").default(false))
  .hook("preAction", async (thisCommand) => {
    const opts = thisCommand.opts<{
      color?: boolean;
      quiet?: boolean;
      verbose?: boolean;
      json?: boolean;
    }>();
    configureOutput({
      // Commander negates --no-color into opts.color === false
      noColor: opts.color === false,
      quiet: opts.quiet,
      verbose: opts.verbose,
      json: isJson() || Boolean(opts.json),
    });
    // Resolve the per-install device id once, before any command action builds
    // headers or an API client. Runs after arg parse; not for --help/--version.
    await initRuntime();
  })
  .showHelpAfterError()
  .configureOutput({
    writeOut: (str) => {
      if (isJson()) outBuffer.push(str);
      else process.stdout.write(str);
    },
    writeErr: (str) => {
      if (isJson()) errBuffer.push(str);
      else process.stderr.write(str);
    },
  })
  // Throw commander errors so the single try/catch around parseAsync owns exit
  // codes and (in JSON mode) the error envelope. Never process.exit here.
  .exitOverride();

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

Global flags:
  --json  Emit machine-readable JSON (also via CHECKERS60_JSON=1). Errors become
          a single {"error","code","status?"} object on stdout.

Exit codes:
  0  success
  1  runtime failure
  2  invalid usage
  3  authentication (not logged in / 401 / 403)
  4  network (timeout, DNS, connection reset)
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
      await otpTrigger({ json: mergeJson(opts) });
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
      await otpVerify(reference, code, { json: mergeJson(opts) });
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
      await status({ json: mergeJson(opts) });
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
        json: mergeJson(opts),
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
      await cart({ json: mergeJson(opts) });
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
      await add(target, qty ? parseInt(qty, 10) : 1, { json: mergeJson(opts) });
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
      await remove(target, { json: mergeJson(opts) });
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
      await clear({ json: mergeJson(opts) });
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
      await addresses({ json: mergeJson(opts) });
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
      await cards({ json: mergeJson(opts) });
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
      await orders({ all: opts.all, json: mergeJson(opts) });
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
      await profile({ json: mergeJson(opts) });
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
      await slots({ json: mergeJson(opts) });
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
      await categories({ json: mergeJson(opts) });
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
      await trending({ json: mergeJson(opts) });
    })
  );

function flushBuffers(): void {
  if (outBuffer.length) {
    process.stdout.write(outBuffer.join(""));
    outBuffer.length = 0;
  }
  if (errBuffer.length) {
    process.stderr.write(errBuffer.join(""));
    errBuffer.length = 0;
  }
}

function discardBuffers(): void {
  outBuffer.length = 0;
  errBuffer.length = 0;
}

// Single entry point: route EVERY error through handleError, which sets
// process.exitCode and never calls process.exit — so buffered stdout flushes.
try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    if (err.exitCode === 0) {
      // Successful --help / --version: not an error. Flush any buffered
      // help/version text (buffered only in JSON mode) and exit 0.
      flushBuffers();
      process.exitCode = 0;
    } else {
      // Any commander usage failure (unknown command/option, missing
      // argument, …) → discard buffered text, exit 2. In JSON mode emit
      // exactly one envelope; in human mode commander already wrote the
      // message straight to stderr.
      discardBuffers();
      if (isJson()) {
        handleError(new UsageError(err.message.replace(/^error:\s*/i, "")));
      } else {
        process.exitCode = EXIT_USAGE;
      }
    }
  } else {
    handleError(err);
  }
}
