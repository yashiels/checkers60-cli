import chalk from "chalk";
import { clearCredentials } from "../lib/credentials.js";

export async function logout(): Promise<void> {
  const cleared = clearCredentials();
  if (cleared) {
    process.stdout.write(`${chalk.green("✅ Logged out. Saved tokens cleared.")}\n`);
  } else {
    process.stdout.write(`${chalk.dim("No saved tokens to clear.")}\n`);
  }
}
