import chalk from "chalk";
import { UsageError } from "../lib/errors.js";
import { formatRand } from "../lib/format.js";
import {
  getCheckoutPreview,
  type CheckoutPreviewDTO,
  type CheckoutSelectionInfoDTO,
  type SlotDTO,
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

  renderSelectionInfo(lines, dto.selectionInfo);

  process.stdout.write(`${lines.join("\n")}\n\n`);
}

/** Informational slot/tip examples — never stored by the CLI, chosen in the app. */
function renderSelectionInfo(lines: string[], info: CheckoutSelectionInfoDTO): void {
  lines.push("", chalk.bold("Selected in the app when you pay"));

  const available = info.deliverySlots.filter((s) => s.available || s.asap);
  if (available.length > 0) {
    lines.push(chalk.dim("  First delivery slots (examples):"));
    for (const s of available) lines.push(`    ${formatSlot(s)}`);
  }

  const presets = info.tipPresetsCents.map((c) => formatRand(c));
  if (info.customTipAllowed) presets.push("custom");
  lines.push(`  Driver tip (examples): ${presets.join(", ")}`);

  lines.push(chalk.dim(`  ${info.note}`));
}

function formatSlot(s: SlotDTO): string {
  const when = s.asap ? "ASAP" : `${formatSlotTs(s.from)} – ${formatSlotTs(s.to)}`;
  const extras: string[] = [];
  if (s.deliveryFee !== null) extras.push(`fee R${s.deliveryFee}`);
  if (s.minimumOrderValue !== null) extras.push(`min R${s.minimumOrderValue}`);
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return `${s.mode}: ${when}${suffix}`;
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
