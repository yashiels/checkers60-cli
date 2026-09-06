import { afterEach, describe, expect, it, vi } from "vitest";
import { track, isTerminalStatus, type TrackDeps } from "../commands/track.js";
import type { TrackDTO } from "../lib/orders.js";

function dto(status: string | null, over: Partial<TrackDTO> = {}): TrackDTO {
  return {
    reference: "ABC123",
    status,
    eta: null,
    slotFrom: null,
    slotTo: null,
    itemCount: 3,
    total: 17197,
    ...over,
  };
}

/** Capture stdout writes for the duration of one test. */
function captureStdout(): { lines: () => string[]; restore: () => void } {
  const buf: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    buf.push(String(chunk));
    return true;
  });
  return { lines: () => buf.join("").split("\n").filter(Boolean), restore: () => spy.mockRestore() };
}

/** Deterministic deps: a scripted fetch sequence, no-op sleep, fixed clock. */
function deps(sequence: (TrackDTO | null)[], extra: Partial<TrackDeps> = {}): TrackDeps {
  let i = 0;
  return {
    fetch: async () => sequence[Math.min(i++, sequence.length - 1)],
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    ...extra,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("isTerminalStatus", () => {
  it.each(["Delivered", "delivered", "CANCELLED", "Order Cancelled", "refunded", "Completed"])(
    "%j is terminal",
    (s) => expect(isTerminalStatus(s)).toBe(true)
  );
  it.each(["Picking", "out-for-delivery", "On the way", "Preparing", null, ""])(
    "%j is NOT terminal",
    (s) => expect(isTerminalStatus(s as string | null)).toBe(false)
  );
});

describe("track --watch", () => {
  it("emits each status change and stops at a terminal status", async () => {
    const cap = captureStdout();
    const sleep = vi.fn(async () => {});
    await track("ABC123", { watch: true }, deps([dto("Preparing"), dto("Dispatched"), dto("Delivered")], { sleep }));
    cap.restore();
    const out = cap.lines().join("\n");
    expect(out).toContain("Preparing");
    expect(out).toContain("Dispatched");
    expect(out).toContain("Delivered");
    expect(out).toMatch(/final status/i);
    // Two sleeps: after Preparing and after Dispatched; none after the terminal Delivered.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("dedupes unchanged status (no repeat line)", async () => {
    const cap = captureStdout();
    await track("ABC123", { watch: true, json: true }, deps([dto("Preparing"), dto("Preparing"), dto("Delivered")]));
    cap.restore();
    const changes = cap.lines().filter((l) => l.trim().startsWith("{"));
    // Preparing (once) + Delivered — the duplicate Preparing is suppressed.
    expect(changes).toHaveLength(2);
    expect(JSON.parse(changes[0]).status).toBe("Preparing");
    expect(JSON.parse(changes[1]).status).toBe("Delivered");
    expect(JSON.parse(changes[1]).at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("throws (never loops) when the order is not found on the first fetch", async () => {
    const cap = captureStdout();
    await expect(track("NOPE", { watch: true }, deps([null]))).rejects.toThrow(/not found/i);
    cap.restore();
  });

  it("skips a transient null mid-watch rather than treating it as gone", async () => {
    const cap = captureStdout();
    await track("ABC123", { watch: true }, deps([dto("Preparing"), null, dto("Delivered")]));
    cap.restore();
    const out = cap.lines().join("\n");
    expect(out).toContain("Preparing");
    expect(out).toContain("Delivered");
  });

  it("stops after maxPolls when a terminal status never arrives", async () => {
    const cap = captureStdout();
    const sleep = vi.fn(async () => {});
    await track("ABC123", { watch: true }, deps([dto("Preparing")], { sleep, maxPolls: 4 }));
    cap.restore();
    expect(cap.lines().join("\n")).toMatch(/stopped after 4 polls/i);
    // 4 polls = 4 status checks with 3 waits between them (no sleep after the last).
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("coerces a non-finite maxPolls to the safe default (never loops forever)", async () => {
    const cap = captureStdout();
    const sleep = vi.fn(async () => {});
    // Infinity would loop forever if not coerced; a single non-terminal status + a
    // capped sleep count proves the guard. Use a small finite cap via a spy on sleep.
    let calls = 0;
    const sleepGuard = vi.fn(async () => {
      if (++calls > 500) throw new Error("unbounded loop");
    });
    await track(
      "ABC123",
      { watch: true },
      deps([dto("Preparing")], { sleep: sleepGuard, maxPolls: Infinity })
    );
    cap.restore();
    // DEFAULT_MAX_POLLS is 360 → 359 sleeps, well under the 500 guard.
    expect(sleepGuard.mock.calls.length).toBeLessThan(400);
    expect(sleepGuard.mock.calls.length).toBeGreaterThan(300);
    void sleep;
  });

  it("floors the poll interval to 10s", async () => {
    const cap = captureStdout();
    const sleep = vi.fn(async () => {});
    await track("ABC123", { watch: true, interval: 2 }, deps([dto("Preparing"), dto("Delivered")], { sleep }));
    cap.restore();
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it("one-shot (no --watch) renders a single snapshot and does not poll", async () => {
    const cap = captureStdout();
    const sleep = vi.fn(async () => {});
    await track("ABC123", {}, deps([dto("Preparing")], { sleep }));
    cap.restore();
    expect(sleep).not.toHaveBeenCalled();
    expect(cap.lines().join("\n")).toContain("Order ABC123");
  });
});
