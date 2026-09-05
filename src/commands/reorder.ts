import chalk from "chalk";
import Table from "cli-table3";
import { UsageError } from "../lib/errors.js";
import { formatRand } from "../lib/format.js";
import { getReorderPreview, toReorderPreviewDTO } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface ReorderOptions {
  preview?: boolean;
  json?: boolean;
}

/**
 * Preview a past order's line items. `--preview` is MANDATORY this increment:
 * there is no cart-writing path here, so the command can never fall through to
 * a mutation. Prices are the order's historical prices and may be stale.
 */
export async function reorder(ref: string, options: ReorderOptions = {}): Promise<void> {
  const { preview = false, json = false } = options;

  if (!preview) {
    throw new UsageError(
      "reorder is preview-only in this version — pass --preview. (Adding a past order to the cart is a later, confirm-gated feature.)"
    );
  }

  const spinner = json ? null : startSpinner("Fetching order…");
  const order = await getReorderPreview(ref);
  spinner?.stop();

  if (!order) {
    throw new Error(`Order ${ref} not found in your completed orders.`);
  }

  const dto = toReorderPreviewDTO(order);

  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }

  const previewOrder = dto.order;
  const date = previewOrder.date ? new Date(previewOrder.date).toLocaleDateString() : "—";
  process.stdout.write(
    `\n${chalk.bold(`Order ${previewOrder.id}`)}  ${chalk.dim(date)}  ${chalk.dim(previewOrder.status ?? "")}\n`
  );
  process.stdout.write(`${chalk.dim("Preview only — prices may be stale, nothing added to cart.")}\n`);

  const table = new Table({
    head: [chalk.bold("Qty"), chalk.bold("Product"), chalk.bold("Price")],
    colWidths: [6, 46, 14],
    style: { head: [], border: [] },
  });
  for (const item of previewOrder.items) {
    table.push([
      String(item.quantity),
      item.name || chalk.dim(item.productId),
      item.price !== null ? formatRand(item.price) : chalk.dim("—"),
    ]);
  }
  process.stdout.write(`\n${table.toString()}\n\n`);
}
