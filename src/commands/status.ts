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
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  process.stdout.write("\n");
  if (sessionValid) {
    process.stdout.write(`${chalk.green("✅ Logged in")}\n`);
  } else {
    process.stdout.write(`${chalk.red("❌ Not logged in")}\n`);
    process.stdout.write(`${chalk.dim("   Run: checkers60 login")}\n`);
    return;
  }

  if (displayName) process.stdout.write(`${chalk.dim(`   User: ${displayName}`)}\n`);
  if (customerId) process.stdout.write(`${chalk.dim(`   Customer: ${customerId}`)}\n`);
  if (addressId) process.stdout.write(`${chalk.dim(`   Address: ${addressId}`)}\n`);
  process.stdout.write(`${chalk.dim(`   Stores: ${storeContexts.length} nearby`)}\n`);
  if (session?.savedAt) {
    const age = Date.now() - new Date(session.savedAt).getTime();
    const hours = Math.round(age / (60 * 60 * 1000));
    process.stdout.write(`${chalk.dim(`   Session age: ${hours}h`)}\n`);
  }
  process.stdout.write("\n");
}
