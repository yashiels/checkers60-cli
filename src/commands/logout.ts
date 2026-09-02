import chalk from "chalk";
import { clearCredentials } from "../lib/credentials.js";

export interface LogoutOptions {
  json?: boolean;
}

export async function logout(options: LogoutOptions = {}): Promise<void> {
  const { json = false } = options;
  const cleared = await clearCredentials();

  if (json) {
    process.stdout.write(`${JSON.stringify({ cleared })}\n`);
    return;
  }

  if (cleared) {
    process.stdout.write(`${chalk.green("✅ Logged out. Saved tokens cleared.")}\n`);
  } else {
    process.stdout.write(`${chalk.dim("No saved tokens to clear.")}\n`);
  }
}
