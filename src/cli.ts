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
  .hook("preAction", async (thisCommand, actionCommand) => {
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
    // `logout` makes no API calls and needs no device id — and a corrupt creds
    // file would make resolveDeviceId throw, blocking the very command meant to
    // clear it — so skip runtime init for logout.
    if (actionCommand.name() !== "logout") {
      await initRuntime();
    }
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
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { logout } = await import("./commands/logout.js");
      await logout({ json: mergeJson(opts) });
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

// ── deals ──────────────────────────────────────────────────────────────
program
  .command("deals <query>")
  .description("List bonus-buy deals for a search term")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 deals "flowers"
  $ checkers60 deals "chocolate" --json
`
  )
  .action(
    wrap(async (query: string, opts: { json?: boolean }) => {
      const { deals } = await import("./commands/deals.js");
      await deals(query, { json: mergeJson(opts) });
    })
  );

// ── offers ─────────────────────────────────────────────────────────────
program
  .command("offers")
  .description("List personalized bonus-buy offers (offers for you)")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 offers
  $ checkers60 offers --json
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { offers } = await import("./commands/offers.js");
      await offers({ json: mergeJson(opts) });
    })
  );

// ── discover ───────────────────────────────────────────────────────────
program
  .command("discover")
  .description("Personalized promotions and featured products (promotions for you)")
  .option("--member", "Force Xtra Savings member pricing")
  .option("--guest", "Force non-member pricing")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Membership is derived from your profile's loyalty card unless --member/--guest is given.

Examples:
  $ checkers60 discover
  $ checkers60 discover --member --json
`
  )
  .action(
    wrap(async (opts: { json?: boolean; member?: boolean; guest?: boolean }) => {
      if (opts.member && opts.guest) {
        throw new UsageError("Pass at most one of --member / --guest.");
      }
      const { discover } = await import("./commands/discover.js");
      // Neither flag → undefined → derive membership from the profile.
      const member = opts.member ? true : opts.guest ? false : undefined;
      await discover({ json: mergeJson(opts), member });
    })
  );

// ── show ───────────────────────────────────────────────────────────────
program
  .command("show <id>")
  .description("Show product detail and any bonus-buy deals it belongs to")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 show 68592087017ec10565d762e3
`
  )
  .action(
    wrap(async (id: string, opts: { json?: boolean }) => {
      const { show } = await import("./commands/show.js");
      await show(id, { json: mergeJson(opts) });
    })
  );

// ── cart ───────────────────────────────────────────────────────────────
const cartCmd = program
  .command("cart")
  .description("Show cart contents")
  .option("--deals", "Show which cart items qualify for bonus-buy deals", false)
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 cart
  $ checkers60 cart forgotten          # products you usually buy but haven't added
  $ checkers60 cart suggest            # smart-cart recommendations
`
  )
  .action(
    wrap(async (opts: { deals?: boolean; json?: boolean }) => {
      const { cart } = await import("./commands/cart.js");
      await cart({ json: mergeJson(opts), deals: opts.deals });
    })
  );

cartCmd
  .command("forgotten")
  .description("Products you usually buy but haven't added this time")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { cartForgotten } = await import("./commands/cart-reads.js");
      await cartForgotten({ json: mergeJson(opts) });
    })
  );

cartCmd
  .command("suggest")
  .alias("suggestions")
  .description("Smart-cart product recommendations")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { cartSuggest } = await import("./commands/cart-reads.js");
      await cartSuggest({ json: mergeJson(opts) });
    })
  );

// ── backup ─────────────────────────────────────────────────────────────
program
  .command("backup <productId>")
  .description("Show replacement/backup candidates for a product")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 backup 5d3af63bf434cf8420737dd6
`
  )
  .action(
    wrap(async (productId: string, opts: { json?: boolean }) => {
      const { backup } = await import("./commands/cart-reads.js");
      await backup(productId, { json: mergeJson(opts) });
    })
  );

// ── add ────────────────────────────────────────────────────────────────
program
  .command("add <target> [qty]")
  .description("Add a product to the cart (preview by default; --confirm <planId> to apply)")
  .option("--json", "Output JSON", false)
  .option("--mode <mode>", "Target cart: sixty-min (default) or one-day")
  .option("--confirm <planId>", "Apply a previously previewed plan")
  .addHelpText(
    "after",
    `
Writes are two-step: preview prints a plan id and exits 5; re-run with --confirm to apply.

Examples:
  $ checkers60 add "simple truth coconut water" 3            # preview → plan id
  $ checkers60 add "simple truth coconut water" 3 --confirm sha256:…
  $ checkers60 add 5d3b1d78e2f18700089552a8 --mode one-day
`
  )
  .action(
    wrap(
      async (
        target: string,
        qty: string | undefined,
        opts: { json?: boolean; mode?: string; confirm?: string }
      ) => {
        const { add } = await import("./commands/add.js");
        await add(target, qty === undefined ? 1 : parseInt(qty, 10), {
          json: mergeJson(opts),
          mode: opts.mode,
          confirm: opts.confirm,
        });
      }
    )
  );

// ── remove ─────────────────────────────────────────────────────────────
program
  .command("remove <target> [qty]")
  .description("Remove a product from the cart (preview by default; --confirm <planId> to apply)")
  .option("--json", "Output JSON", false)
  .option("--mode <mode>", "Target cart: sixty-min (default) or one-day")
  .option("--confirm <planId>", "Apply a previously previewed plan")
  .addHelpText(
    "after",
    `
Omit qty to remove the whole line; give qty to decrement. Preview prints a plan id (exit 5).

Examples:
  $ checkers60 remove "coconut water"                        # preview → plan id
  $ checkers60 remove "coconut water" --confirm sha256:…
  $ checkers60 remove 5d3b1d78e2f18700089552a8 2 --confirm sha256:…
`
  )
  .action(
    wrap(
      async (
        target: string,
        qty: string | undefined,
        opts: { json?: boolean; mode?: string; confirm?: string }
      ) => {
        const { remove } = await import("./commands/remove.js");
        await remove(target, qty === undefined ? undefined : parseInt(qty, 10), {
          json: mergeJson(opts),
          mode: opts.mode,
          confirm: opts.confirm,
        });
      }
    )
  );

// ── clear ──────────────────────────────────────────────────────────────
program
  .command("clear")
  .description("Empty the cart (preview by default; --confirm <planId> to apply)")
  .option("--json", "Output JSON", false)
  .option("--mode <mode>", "Target cart: sixty-min (default) or one-day")
  .option("--confirm <planId>", "Apply a previously previewed plan")
  .action(
    wrap(async (opts: { json?: boolean; mode?: string; confirm?: string }) => {
      const { clear } = await import("./commands/clear.js");
      await clear({ json: mergeJson(opts), mode: opts.mode, confirm: opts.confirm });
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
const ordersCmd = program
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
  $ checkers60 orders show <reference>
`
  )
  .action(
    wrap(async (opts: { all?: boolean; json?: boolean }) => {
      const { orders } = await import("./commands/orders.js");
      await orders({ all: opts.all, json: mergeJson(opts) });
    })
  );

ordersCmd
  .command("show <reference>")
  .description("Show one of your orders by reference (own orders only)")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (reference: string, opts: { json?: boolean }) => {
      const { ordersShow } = await import("./commands/orders.js");
      await ordersShow(reference, { json: mergeJson(opts) });
    })
  );

// ── track ──────────────────────────────────────────────────────────────
program
  .command("track <reference>")
  .description("Show status for one of your orders (own orders only)")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (reference: string, opts: { json?: boolean }) => {
      const { track } = await import("./commands/track.js");
      await track(reference, { json: mergeJson(opts) });
    })
  );

// ── regulars ───────────────────────────────────────────────────────────
program
  .command("regulars")
  .description("Show the products you buy most often")
  .option("-n, --top <n>", "How many to show", "20")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { top?: string; json?: boolean }) => {
      const { regulars } = await import("./commands/regulars.js");
      await regulars({ top: opts.top ? parseInt(opts.top, 10) : 20, json: mergeJson(opts) });
    })
  );

// ── reorder (preview only) ──────────────────────────────────────────────
program
  .command("reorder <reference>")
  .description("Preview a past order's items (--preview required; nothing is added to the cart)")
  .option("--preview", "Preview only — required in this version", false)
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 reorder <order-id> --preview
`
  )
  .action(
    wrap(async (reference: string, opts: { preview?: boolean; json?: boolean }) => {
      const { reorder } = await import("./commands/reorder.js");
      await reorder(reference, { preview: opts.preview, json: mergeJson(opts) });
    })
  );

// ── fav ────────────────────────────────────────────────────────────────
program
  .command("fav")
  .description("List your favourite products")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { fav } = await import("./commands/fav.js");
      await fav({ json: mergeJson(opts) });
    })
  );

// ── returns ────────────────────────────────────────────────────────────
const returnsCmd = program
  .command("returns")
  .description("List your returns")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 returns
  $ checkers60 returns show <id>
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { returns } = await import("./commands/returns.js");
      await returns({ json: mergeJson(opts) });
    })
  );

returnsCmd
  .command("show <id>")
  .description("Show one of your returns by id (own returns only)")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (id: string, opts: { json?: boolean }) => {
      const { returnsShow } = await import("./commands/returns.js");
      await returnsShow(id, { json: mergeJson(opts) });
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
  .description("Show the first available delivery slot per service option")
  .addOption(
    new Option("--mode <mode>", "Filter to one fulfilment mode").choices([
      "sixty-min",
      "one-day",
      "hyper",
    ])
  )
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 slots
  $ checkers60 slots --mode sixty-min
  $ checkers60 slots --mode one-day
  $ checkers60 slots --mode hyper    # large-goods (Hyper) — estimate not yet supported
`
  )
  .action(
    wrap(async (opts: { mode?: string; json?: boolean }) => {
      const { slots } = await import("./commands/slots.js");
      await slots({ mode: opts.mode, json: mergeJson(opts) });
    })
  );

// ── plus / membership ────────────────────────────────────────────────────
program
  .command("plus")
  .alias("membership")
  .description("Show Xtra Savings membership status")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  $ checkers60 plus
  $ checkers60 membership --json
`
  )
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { plus } = await import("./commands/plus.js");
      await plus({ json: mergeJson(opts) });
    })
  );

// ── wallet / credits ─────────────────────────────────────────────────────
program
  .command("wallet")
  .alias("credits")
  .description("Show your account wallet/credit balance")
  .option("--json", "Output JSON", false)
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const { wallet } = await import("./commands/wallet.js");
      await wallet({ json: mergeJson(opts) });
    })
  );

// ── checkout (preview only) ──────────────────────────────────────────────
program
  .command("checkout")
  .description("Preview order totals (--preview required; not supported yet)")
  .option("--preview", "Preview totals only — required in this version", false)
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
Read-only: this CLI never places an order. Totals preview needs the pre-order
totals contract, which is not captured yet, so --preview reports "not supported".

Examples:
  $ checkers60 checkout --preview
`
  )
  .action(
    wrap(async (opts: { preview?: boolean; json?: boolean }) => {
      const { checkout } = await import("./commands/checkout.js");
      await checkout({ preview: opts.preview, json: mergeJson(opts) });
    })
  );

// ── categories ─────────────────────────────────────────────────────────
program
  .command("categories <query>")
  .description("List product categories (department facets) for a search term")
  .option("--json", "Output JSON", false)
  .addHelpText(
    "after",
    `
The catalog exposes categories scoped to a search — there is no global tree.

Examples:
  $ checkers60 categories "milk"
  $ checkers60 categories "coffee" --json
`
  )
  .action(
    wrap(async (query: string, opts: { json?: boolean }) => {
      const { categories } = await import("./commands/categories.js");
      await categories(query, { json: mergeJson(opts) });
    })
  );

// ── trending ───────────────────────────────────────────────────────────
program
  .command("trending")
  .description("Show trending searches (deprecated — not exposed by the mobile API)")
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
