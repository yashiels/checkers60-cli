import chalk from "chalk";
import { clearSession } from "../lib/session.js";

export async function logout(): Promise<void> {
  clearSession();
  console.log(chalk.green("✅ Logged out. Session and config cleared."));
}
