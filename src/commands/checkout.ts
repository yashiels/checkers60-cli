import chalk from "chalk";
import { UsageError } from "../lib/errors.js";
import { formatRand } from "../lib/format.js";
import { getCheckoutPreview, type CheckoutPreviewDTO } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface CheckoutOptions {
  preview?: boolean;
  json?: boolean;
}

/**
 * Read-only checkout totals preview. `--preview` is MANDATORY: this is a
 * read-only domain, so no place-order / tip / payment path exists. The totals
 * come from the existing pre-order call (surfaced for the CURRENT populated
 * cart); an empty cart reports a clean "add items first" message.
 */
export async function checkout(options: CheckoutOptions = {}): Promise<void> {
  const { preview = false, json = false } = options;

  if (!preview) {
    throw new UsageError(
      "checkout is preview-only in this version — pass --preview. (Placing an order is not supported by this CLI.)"
    );
  }

  const spinner = json ? null : startSpinner("Fetching checkout totals…");
  const dto = await getCheckoutPreview();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }

  renderHuman(dto);
}

function renderHuman(dto: CheckoutPreviewDTO): void {
  if (!dto.populated) {
    process.stdout.write(`${chalk.yellow(dto.message ?? "Cart is empty.")}\n`);
    return;
  }

  const lines: string[] = ["", chalk.bold("Checkout preview")];
  lines.push(`  Subtotal: ${formatRand(dto.subtotal)}`);
  for (const fee of dto.fees) {
    lines.push(`  ${fee.name}: ${formatRand(fee.amount)}`);
  }
  lines.push(`  ${chalk.bold("Total")}: ${chalk.bold(formatRand(dto.total))} ${chalk.dim(dto.currency)}`);

  const { value, met, shortfall } = dto.minimumOrder;
  if (value !== null) {
    if (met === false) {
      lines.push(
        chalk.yellow(
          `  Below minimum order (${formatRand(value)}) — add ${formatRand(shortfall)} more.`
        )
      );
    } else if (met === true) {
      lines.push(chalk.green(`  Minimum order met (${formatRand(value)}).`));
    } else {
      lines.push(chalk.dim(`  Minimum order: ${formatRand(value)}.`));
    }
  }

  if (dto.violations.length > 0) {
    lines.push(chalk.red("  Issues:"));
    for (const v of dto.violations) lines.push(chalk.red(`    • ${v}`));
  }

  if (dto.quoteId || dto.quoteExpiry) {
    const parts: string[] = [];
    if (dto.quoteId) parts.push(`quote ${dto.quoteId}`);
    if (dto.quoteExpiry) parts.push(`expires ${dto.quoteExpiry}`);
    lines.push(chalk.dim(`  ${parts.join(", ")}`));
  }

  process.stdout.write(`${lines.join("\n")}\n\n`);
}
