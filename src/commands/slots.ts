import chalk from "chalk";
import Table from "cli-table3";
import { CheckersAPI } from "../lib/api.js";
import { startSpinner } from "../lib/output.js";

export interface SlotsOptions {
  json?: boolean;
}

interface DeliverySlot {
  date?: string;
  day?: string;
  label?: string;
  startTime?: string;
  endTime?: string;
  from?: string;
  to?: string;
  available?: boolean;
  isAvailable?: boolean;
  capacity?: number | string;
  [key: string]: unknown;
}

export async function slots(options: SlotsOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Fetching delivery slots…");

  const api = new CheckersAPI();
  const raw = await api.getDeliverySlots();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
    return;
  }

  const groups = extractSlotGroups(raw);
  if (groups.length === 0) {
    process.stdout.write(`${chalk.yellow("No delivery slots returned.")}\n`);
    return;
  }

  for (const group of groups) {
    process.stdout.write(`\n${chalk.bold(group.label)}\n`);
    const table = new Table({
      head: [chalk.bold("Time"), chalk.bold("Status")],
      colWidths: [22, 18],
      style: { head: [], border: [] },
    });
    for (const slot of group.slots) {
      const time = formatSlotTime(slot);
      const status = formatSlotStatus(slot);
      table.push([time, status]);
    }
    process.stdout.write(`${table.toString()}\n`);
  }
  process.stdout.write("\n");
}

interface SlotGroup {
  label: string;
  slots: DeliverySlot[];
}

function extractSlotGroups(raw: unknown): SlotGroup[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;

  // Common shape: { deliverySlots: [{ date, slots: [...] }] }
  const candidates = [
    obj.deliverySlots,
    obj.slots,
    obj.days,
    (obj.data as Record<string, unknown> | undefined)?.deliverySlots,
    (obj.data as Record<string, unknown> | undefined)?.slots,
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      // Grouped (per-day)
      if (
        typeof c[0] === "object" &&
        c[0] !== null &&
        Array.isArray((c[0] as Record<string, unknown>).slots)
      ) {
        return (c as Array<Record<string, unknown>>).map((g) => ({
          label: labelForGroup(g),
          slots: (g.slots as DeliverySlot[]) ?? [],
        }));
      }
      // Flat array of slots
      return [{ label: "Available slots", slots: c as DeliverySlot[] }];
    }
  }

  return [];
}

function labelForGroup(g: Record<string, unknown>): string {
  const label = (g.label as string) ?? (g.day as string) ?? (g.date as string);
  if (typeof label !== "string") return "Slots";
  // Try to humanize ISO dates
  const d = new Date(label);
  if (!Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}/.test(label)) {
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }
  return label;
}

function formatSlotTime(slot: DeliverySlot): string {
  const start = slot.startTime ?? slot.from;
  const end = slot.endTime ?? slot.to;
  if (start && end) return `${formatTime(start)} – ${formatTime(end)}`;
  if (slot.label) return slot.label;
  return chalk.dim("—");
}

function formatTime(value: string): string {
  // Trim seconds from HH:MM:SS, or return ISO-time portion
  const m = /^(\d{2}):(\d{2})/.exec(value);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return value;
}

function formatSlotStatus(slot: DeliverySlot): string {
  const available = slot.available ?? slot.isAvailable;
  if (available === false) return chalk.dim("Full");
  if (available === true) return chalk.green("Available");
  if (slot.capacity !== undefined) {
    return chalk.green(String(slot.capacity));
  }
  return chalk.dim("—");
}
