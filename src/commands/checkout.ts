import chalk from "chalk";
import { UsageError } from "../lib/errors.js";
import { formatRand } from "../lib/format.js";
import {
  getCheckoutPreview,
  type CheckoutPreviewDTO,
  type PreviewSlotDTO,
} from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface CheckoutOptions {
  preview?: boolean;
  json?: boolean;
}

/**
 * Read-only checkout totals preview. `--preview` is MANDATORY: this is a
 * read-only domain, so no place-order / tip / payment path exists. The totals
 * come from the existing pre-order call (surfaced for the CURRENT populated
 * cart), plus an informational slot/tip block — the delivery slot and driver
 * tip are chosen in the app at payment time and are NOT stored by this CLI. An
 * empty cart reports a clean "add items first" message.
 */
export async function checkout(options: CheckoutOptions = {}): Promise<void> {
  const { preview = false, json = false } = options;

  if (!preview) {
    throw new UsageError(
      "checkout is preview-only in this version — pass --preview. (Placing an order is not supported by this CLI.)"
    );
  }

  const spinner = json ? null : startSpinner("Fetching checkout totals…");
  let dto: CheckoutPreviewDTO;
  try {
    dto = await getCheckoutPreview();
  } finally {
    spinner?.stop();
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    return;
  }

  renderHuman(dto);
}

function renderHuman(dto: CheckoutPreviewDTO): void {
  if (!dto.populated) {
    process.stdout.write(`${chalk.yellow(dto.message ?? CHECKOUT_EMPTY_FALLBACK)}\n`);
    return;
  }

  const lines: string[] = ["", chalk.bold("Checkout preview")];
  lines.push(`  Subtotal: ${formatRand(dto.subtotal)}`);
  if (dto.discountTotal !== null && dto.discountTotal > 0) {
    lines.push(chalk.green(`  Discount: -${formatRand(dto.discountTotal)}`));
  }
  for (const fee of dto.fees) {
    lines.push(`  Delivery (${fee.name}): ${formatRand(fee.amount)}`);
  }
  if (dto.tipAmount !== null && dto.tipAmount > 0) {
    lines.push(`  Driver tip: ${formatRand(dto.tipAmount)}`);
  }
  lines.push(
    `  ${chalk.bold("Total payable")}: ${chalk.bold(formatRand(dto.total))} ${chalk.dim(dto.currency)}`
  );

  const available = dto.deliverySlots;
  if (dto.allowASAPDelivery || available.length > 0) {
    lines.push("", chalk.bold("Delivery slots"));
    if (dto.allowASAPDelivery) lines.push(`  ${chalk.green("ASAP")} available`);
    for (const s of available.slice(0, 6)) lines.push(`  ${formatSlot(s)}`);
  }

  if (dto.availablePaymentMethods.length > 0) {
    lines.push("", `${chalk.bold("Payment methods")}: ${dto.availablePaymentMethods.join(", ")}`);
  }

  lines.push("", chalk.bold("Selected in the app when you pay"));
  const presets = dto.tipPresetsCents.map((c) => formatRand(c));
  presets.push("custom");
  lines.push(`  Driver tip (examples): ${presets.join(", ")}`);
  lines.push(chalk.dim(`  ${dto.note}`));

  process.stdout.write(`${lines.join("\n")}\n\n`);
}

const CHECKOUT_EMPTY_FALLBACK = "Add items to your cart before previewing checkout totals.";

function formatSlot(s: PreviewSlotDTO): string {
  const when = s.displayName ?? `${formatSlotTs(s.from)} – ${formatSlotTs(s.to)}`;
  return when;
}

function formatSlotTs(value: string | null): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
