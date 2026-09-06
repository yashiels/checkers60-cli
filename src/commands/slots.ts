import chalk from "chalk";
import Table from "cli-table3";
import { getSlots, hyperSlotsDTO } from "../lib/orders.js";
import { startSpinner } from "../lib/output.js";

export interface SlotsOptions {
  mode?: string;
  json?: boolean;
}

/**
 * First available delivery slot per service option (via first-delivery-slots —
 * cart-independent). Three fulfilment modes exist: `sixty-min` and `one-day`
 * are slot-based and shown here; `hyper` (large/bulk goods) uses a delivery
 * ESTIMATE + minimum order value — an uncaptured contract, so `--mode hyper` is
 * recognized but DEFERRED (no network call, no guess). The default shows every
 * slot-based mode (fastest first). No PII in the output.
 */
export async function slots(options: SlotsOptions = {}): Promise<void> {
  const { mode, json = false } = options;

  // Hyper is deferred: short-circuit BEFORE any request — never guess its
  // estimate contract, never hit the slots endpoint on its behalf.
  if (mode === "hyper") {
    const dto = hyperSlotsDTO();
    if (json) {
      process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`);
    } else {
      process.stdout.write(`${chalk.yellow(dto.message)}\n`);
    }
    return;
  }

  const spinner = json ? null : startSpinner("Fetching delivery slots…");

  let items;
  try {
    items = await getSlots(mode);
  } finally {
    spinner?.stop();
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  const available = items.filter((s) => s.available || s.asap);
  if (available.length === 0) {
    process.stdout.write(`${chalk.yellow("No delivery slots available.")}\n`);
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("Mode"),
      chalk.bold("From"),
      chalk.bold("To"),
      chalk.bold("Fee"),
      chalk.bold("Min"),
    ],
    colWidths: [20, 24, 24, 8, 8],
    style: { head: [], border: [] },
  });
  for (const s of items) {
    const from = s.asap ? chalk.green("ASAP") : formatTs(s.from);
    table.push([
      s.mode,
      from,
      formatTs(s.to),
      s.deliveryFee !== null ? `R${s.deliveryFee}` : chalk.dim("—"),
      s.minimumOrderValue !== null ? `R${s.minimumOrderValue}` : chalk.dim("—"),
    ]);
  }
  process.stdout.write(`\n${table.toString()}\n\n`);
}

function formatTs(value: string | null): string {
  if (!value) return chalk.dim("—");
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
