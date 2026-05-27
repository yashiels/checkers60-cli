import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI, type DeliverySlot } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface SlotsOptions {
  json?: boolean;
}

/**
 * The mobile app only returns delivery slots during pre-order, so slots are
 * derived from the current cart. An empty cart yields no slots.
 */
export async function slots(options: SlotsOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching delivery slots…");

  const api = new CheckersAPI();
  const result = await api.getDeliverySlots();
  spinner?.stop();

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ asap: result.asap, slots: result.slots }, null, 2)}\n`
    );
    return;
  }

  if (result.slots.length === 0 && !result.asap) {
    process.stdout.write(
      `${chalk.yellow("No delivery slots available.")}\n` +
        `${chalk.dim("   The app only returns slots for a non-empty cart — add items first.")}\n`
    );
    return;
  }

  if (result.asap) {
    process.stdout.write(`\n${chalk.green("⚡ ASAP delivery available")}\n`);
  }

  if (result.slots.length > 0) {
    const table = new Table({
      head: [chalk.bold("From"), chalk.bold("To"), chalk.bold("Status")],
      colWidths: [24, 24, 16],
      style: { head: [], border: [] },
    });
    for (const slot of result.slots) {
      table.push([formatTs(slot.start), formatTs(slot.end), formatStatus(slot)]);
    }
    process.stdout.write(`\n${table.toString()}\n`);
  }
  process.stdout.write("\n");
}

function formatTs(value: number | string | undefined): string {
  if (value === undefined) return chalk.dim("—");
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ms)) return String(value);
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatStatus(slot: DeliverySlot): string {
  if (slot.available === false) return chalk.dim("Full");
  if (slot.available === true) return chalk.green("Available");
  return chalk.dim("—");
}
