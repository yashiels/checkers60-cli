import chalk from "chalk";
import { CheckersAPI } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface ProfileOptions {
  json?: boolean;
}

export async function profile(options: ProfileOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching profile…");

  const api = new CheckersAPI();
  const user = await api.getUserProfile();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(user ?? null, null, 2)}\n`);
    return;
  }

  if (!user) {
    process.stdout.write(`${chalk.yellow("No profile data returned.")}\n`);
    return;
  }

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "(no name)";
  process.stdout.write(`\n${chalk.bold(fullName)}\n`);
  if (user.mobileNumber) process.stdout.write(`${chalk.dim(`  Mobile: ${user.mobileNumber}`)}\n`);
  if (user.email) process.stdout.write(`${chalk.dim(`  Email:  ${user.email}`)}\n`);
  process.stdout.write("\n");
}
