import chalk from "chalk";
import { config } from "../lib/config.js";
import { isSessionValid, loadSession } from "../lib/session.js";

export interface StatusOptions {
  json?: boolean;
}

export async function status(options: StatusOptions = {}): Promise<void> {
  const { json = false } = options;

  const sessionValid = isSessionValid();
  const session = loadSession();
  const displayName = config.get("displayName");
  const customerId = config.get("customerId");
  const addressId = config.get("addressId");
  const storeContexts = config.get("storeContexts") ?? [];

  const data = {
    loggedIn: sessionValid,
    displayName: displayName ?? null,
    customerId: customerId ?? null,
    addressId: addressId ?? null,
    storeCount: storeContexts.length,
    sessionSavedAt: session?.savedAt ?? null,
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log("");
  if (sessionValid) {
    console.log(chalk.green("✅ Logged in"));
  } else {
    console.log(chalk.red("❌ Not logged in"));
    console.log(chalk.dim('   Run: checkers60 login'));
    return;
  }

  if (displayName) console.log(chalk.dim(`   User: ${displayName}`));
  if (customerId) console.log(chalk.dim(`   Customer: ${customerId}`));
  if (addressId) console.log(chalk.dim(`   Address: ${addressId}`));
  console.log(chalk.dim(`   Stores: ${storeContexts.length} nearby`));
  if (session?.savedAt) {
    const age = Date.now() - new Date(session.savedAt).getTime();
    const hours = Math.round(age / (60 * 60 * 1000));
    console.log(chalk.dim(`   Session age: ${hours}h`));
  }
  console.log("");
}
