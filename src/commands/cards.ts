import chalk from "chalk";
import { getCards } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface CardsOptions {
  json?: boolean;
}

/**
 * List saved payment cards. Only issuer + masked number + expiry + default flag
 * are emitted — never the card token, cardholder name, or usage flags.
 */
export async function cards(options: CardsOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching cards…");

  const items = await getCards();
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
      c.expiryMonth && c.expiryYear
        ? ` ${chalk.dim(`(exp ${c.expiryMonth}/${c.expiryYear})`)}`
        : "";
    const dflt = c.isDefault ? ` ${chalk.green("(default)")}` : "";
    process.stdout.write(`  ${chalk.cyan("●")} ${issuer} ${masked}${exp}${dflt}\n`);
  }
  process.stdout.write("\n");
}
