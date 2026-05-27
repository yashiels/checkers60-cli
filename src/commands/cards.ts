import chalk from "chalk";
import { CheckersAPI } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface CardsOptions {
  json?: boolean;
}

export async function cards(options: CardsOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching cards…");

  const api = new CheckersAPI();
  const items = await api.getPaymentCards();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write(`${chalk.yellow("No saved payment cards.")}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.bold("Payment cards")}\n\n`);
  for (const c of items) {
    const issuer = c.issuer ?? "Card";
    const masked = c.maskedCardNumber ?? "••••";
    const exp =
      c.expiryMonth && c.expiryYear ? ` ${chalk.dim(`(exp ${c.expiryMonth}/${c.expiryYear})`)}` : "";
    process.stdout.write(`  ${chalk.cyan("●")} ${issuer} ${masked}${exp}\n`);
    if (c.token) process.stdout.write(`    ${chalk.dim(`token: ${c.token}`)}\n`);
  }
  process.stdout.write("\n");
}
