import chalk from "chalk";
import { getCartSavings, type CartDealDTO, type SavingsDTO } from "../lib/orders.js";
import { formatRand } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export interface SavingsOptions {
  json?: boolean;
}

/**
 * `savings` — the bonus-buy deals the current cart touches. An awareness view:
 * it lists each active deal a cart item qualifies for, its human terms, and the
 * other qualifying products as eligible OPTIONS. It never claims a deal is
 * complete, never shows a threshold or progress, and never invents a saving.
 */
export async function savings(options: SavingsOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Checking cart deals…");

  const dto = await getCartSavings();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }

  if (dto.message) {
    process.stdout.write(`${chalk.yellow(dto.message)}\n`);
    return;
  }

  printCartSavings(dto);

  if (dto.deals.length === 0) {
    process.stdout.write(
      `${chalk.dim("No bonus-buy deals apply to items in your cart.")}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.bold(`🏷  Bonus-buy deals your cart touches (${dto.deals.length})`)}\n`
  );
  for (const deal of dto.deals) printDeal(deal);
  process.stdout.write(
    `\n${chalk.dim("  Terms (buy-quantity & saving) live in each deal's description.")}\n` +
      `${chalk.dim("  Eligible options are hints — add them via ")}${chalk.cyan("checkers60 add")}${chalk.dim(".")}\n\n`
  );
}

/** Print the server's verbatim already-applied cart savings, when reported. */
function printCartSavings(dto: SavingsDTO): void {
  const s = dto.cartSavings;
  if (!s || s.totalSavings === null || s.totalSavings <= 0) return;
  process.stdout.write(
    `${chalk.green(`  Already saved in this cart: ${formatRand(s.totalSavings)}`)} ` +
      `${chalk.dim("(server-reported)")}\n`
  );
}

function printDeal(deal: CartDealDTO): void {
  process.stdout.write(`\n  ${chalk.bold(deal.title || deal.dealId)}`);
  if (deal.membersOnly) process.stdout.write(` ${chalk.cyan("[Xtra Savings]")}`);
  process.stdout.write("\n");
  if (deal.terms && deal.terms !== deal.title) {
    process.stdout.write(`    ${chalk.dim(deal.terms)}\n`);
  }
  if (deal.validUntil) {
    process.stdout.write(`    ${chalk.dim(`valid until ${deal.validUntil.slice(0, 10)}`)}\n`);
  }
  process.stdout.write(`    ${chalk.dim("Qualifying items in your cart:")}\n`);
  for (const item of deal.qualifyingItemsInCart) {
    const qty = item.quantity > 1 ? chalk.dim(` ×${item.quantity}`) : "";
    process.stdout.write(`      • ${item.name ?? item.productId}${qty}\n`);
  }
  if (deal.eligibleOptionProductIds.length > 0) {
    process.stdout.write(
      `    ${chalk.dim(`Eligible options (product ids): ${deal.eligibleOptionProductIds.join(", ")}`)}\n`
    );
  }
}
