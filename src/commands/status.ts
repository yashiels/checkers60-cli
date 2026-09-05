import chalk from "chalk";
import { TokenManager, loadCredentials } from "../lib/credentials.js";
import { CheckersAPI } from "../lib/api.js";
import { CONFIG } from "../lib/config.js";
import { formatRand } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export interface StatusOptions {
  json?: boolean;
}

interface CartSummary {
  cartId: string | null;
  itemCount: number;
  total: number; // cents
}

export async function status(options: StatusOptions = {}): Promise<void> {
  const { json = false } = options;

  const tokens = new TokenManager();
  const loggedIn = tokens.isAuthenticated();
  const creds = loadCredentials();
  const sessionExpiry = tokens.sessionExpiry || null;
  const bffExpiry = tokens.bffExpiry || null;

  // Best-effort cart summary — only attempt when authenticated.
  let cart: CartSummary | null = null;
  let cartError: string | null = null;
  if (loggedIn) {
    const spinner = json ? null : startSpinner("Checking cart…");
    try {
      const api = new CheckersAPI(tokens);
      const state = await api.getCart();
      const total = state.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      cart = { cartId: state.cartId, itemCount: state.items.length, total };
    } catch (err) {
      cartError = err instanceof Error ? err.message : String(err);
    } finally {
      spinner?.stop();
    }
  }

  const data = {
    loggedIn,
    mobile: creds.mobile || CONFIG.MOBILE || null,
    sixty60UserId: creds.sixty60_user_id || null,
    shopriteUuid: creds.shoprite_uuid || null,
    customerUid: creds.customer_uid || null,
    storeCount: CONFIG.DEFAULT_STORES.length,
    sessionExpiry: sessionExpiry ? new Date(sessionExpiry).toISOString() : null,
    bffTokenExpiry: bffExpiry ? new Date(bffExpiry).toISOString() : null,
    cart: cart ?? null,
    cartError,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  process.stdout.write("\n");
  if (!loggedIn) {
    process.stdout.write(`${chalk.red("❌ Not logged in")}\n`);
    process.stdout.write(`${chalk.dim("   Run: checkers60 login")}\n\n`);
    return;
  }

  process.stdout.write(`${chalk.green("✅ Logged in")}\n`);
  const mobile = creds.mobile || CONFIG.MOBILE;
  if (mobile) process.stdout.write(`${chalk.dim(`   Mobile: ${mobile}`)}\n`);
  if (creds.sixty60_user_id) {
    process.stdout.write(`${chalk.dim(`   User ID: ${creds.sixty60_user_id}`)}\n`);
  }
  process.stdout.write(`${chalk.dim(`   Stores: ${CONFIG.DEFAULT_STORES.length} configured`)}\n`);
  process.stdout.write(`${chalk.dim(`   Session expiry: ${formatExpiry(sessionExpiry)}`)}\n`);

  if (cart) {
    process.stdout.write(
      `${chalk.dim(`   Cart: ${cart.itemCount} item(s), ${formatRand(cart.total)}`)}\n`
    );
  } else if (cartError) {
    process.stdout.write(`${chalk.yellow(`   Cart: unavailable (${cartError})`)}\n`);
  }
  process.stdout.write("\n");
}

function formatExpiry(expiry: number | null): string {
  if (!expiry) return "unknown";
  const now = Date.now();
  if (expiry <= now) return "expired (log in again)";
  const mins = Math.round((expiry - now) / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}
