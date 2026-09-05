import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckersAPI } from "../lib/api.js";
import { readPayload, runFavMutation } from "../lib/favourites-mutate.js";
import { plansDir, PlanStaleError } from "../lib/confirm.js";
import { DivergentOutcomeError, EXIT_CONFIRM } from "../lib/errors.js";

let tmp: string;
let outSpy: ReturnType<typeof vi.fn>;

const SESSION = { sessionToken: "s", userId: "u1", uuid: "x1", mobile: "+27820000000", customerId: "C" };
const PROD = "5d3af63ff434cf8420737f84"; // valid 24-hex ObjectId

interface FakeAPI {
  api: CheckersAPI;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  favs: Set<string>;
}

function fakeApi(
  initial: string[] = [],
  opts: {
    onSet?: (id: string, v: boolean) => void;
    throwOnSet?: boolean;
    throwAfterSet?: boolean;
    failReadOnCall?: number;
    session?: typeof SESSION;
  } = {}
): FakeAPI {
  const favs = new Set(initial);
  let reads = 0;
  const get = vi.fn(async () => {
    reads += 1;
    if (opts.failReadOnCall && reads === opts.failReadOnCall) throw new Error("read failed");
    return new Set(favs);
  });
  const set = vi.fn(async (id: string, v: boolean) => {
    if (opts.throwOnSet) throw new Error("connection reset");
    if (opts.onSet) opts.onSet(id, v);
    else if (v) favs.add(id);
    else favs.delete(id);
    if (opts.throwAfterSet) throw new Error("connection reset after apply");
  });
  const api = {
    tokens: { getSession: vi.fn(async () => opts.session ?? SESSION) },
    getFavouriteIds: get,
    setFavourite: set,
    searchProducts: vi.fn(async () => ({ products: [{ id: PROD, name: "Test Product" }] })),
    getProductDetails: vi.fn(async () => [{ id: PROD, name: "Test Product" }]),
  } as unknown as CheckersAPI;
  return { api, get, set, favs };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "c60-favplans-"));
  process.env.CHECKERS60_PLANS_DIR = tmp;
  process.exitCode = 0;
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true) as unknown as ReturnType<typeof vi.fn>;
});
afterEach(() => {
  outSpy.mockRestore();
  delete process.env.CHECKERS60_PLANS_DIR;
  process.exitCode = 0;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function lastJson(): Record<string, unknown> {
  return JSON.parse(outSpy.mock.calls.map((c) => String(c[0])).join(""));
}
async function preview(f: FakeAPI, op: "fav.add" | "fav.remove"): Promise<string> {
  await runFavMutation(f.api, op, PROD, { json: true });
  const id = (lastJson().plan as Record<string, unknown>).planId as string;
  outSpy.mock.calls.length = 0;
  process.exitCode = 0;
  return id;
}

describe("favourites gate — preview", () => {
  it("makes NO write, exits 5, writes a single-use plan", async () => {
    const f = fakeApi([]);
    await runFavMutation(f.api, "fav.add", PROD, { json: true });
    expect(f.set).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CONFIRM);
    expect(lastJson().confirmationRequired).toBe(true);
    expect(readdirSync(plansDir()).filter((x) => x.endsWith(".json"))).toHaveLength(1);
  });

  it("add of an already-favourited product is a clean no-op (no plan, no write)", async () => {
    const f = fakeApi([PROD]);
    await runFavMutation(f.api, "fav.add", PROD, { json: true });
    expect(f.set).not.toHaveBeenCalled();
    expect(lastJson().noop).toBe(true);
    expect(readdirSync(plansDir()).filter((x) => x.endsWith(".json"))).toHaveLength(0);
  });

  it("remove of a non-favourited product is a clean no-op", async () => {
    const f = fakeApi([]);
    await runFavMutation(f.api, "fav.remove", PROD, { json: true });
    expect(f.set).not.toHaveBeenCalled();
    expect(lastJson().noop).toBe(true);
  });
});

describe("favourites gate — confirm", () => {
  it("applies the toggle and reconciles to success", async () => {
    const f = fakeApi([]);
    const id = await preview(f, "fav.add");
    await runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id });
    expect(f.set).toHaveBeenCalledWith(PROD, true);
    expect(lastJson().ok).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("is single-use", async () => {
    const f = fakeApi([]);
    const id = await preview(f, "fav.add");
    await runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id });
    await expect(
      runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id })
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.set).toHaveBeenCalledOnce();
  });

  it("refuses a plan confirmed under a different account", async () => {
    const f = fakeApi([]);
    const id = await preview(f, "fav.add");
    const other = fakeApi([], { session: { ...SESSION, userId: "someone-else", uuid: "z" } });
    await expect(
      runFavMutation(other.api, "fav.add", PROD, { json: true, confirm: id })
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(other.set).not.toHaveBeenCalled();
  });

  it("refuses a corrupt plan artifact", async () => {
    const f = fakeApi([]);
    const id = await preview(f, "fav.add");
    const file = readdirSync(plansDir()).find((x) => x.endsWith(".json"))!;
    writeFileSync(join(plansDir(), file), "{not json");
    await expect(
      runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id })
    ).rejects.toBeInstanceOf(PlanStaleError);
    expect(f.set).not.toHaveBeenCalled();
  });

  it("is idempotent: if already in the desired state at confirm, succeeds without POSTing", async () => {
    const f = fakeApi([]);
    const id = await preview(f, "fav.add");
    f.favs.add(PROD); // a concurrent action already favourited it
    await runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id });
    expect(f.set).not.toHaveBeenCalled();
    expect(lastJson().ok).toBe(true);
  });
});

describe("favourites payload validation (confused-deputy guard)", () => {
  it("rejects a payload whose isFavourite disagrees with the operation", () => {
    // A fav.add (expected true) plan carrying isFavourite:false must be refused.
    expect(() =>
      readPayload({ productId: PROD, isFavourite: false, name: "x" }, true)
    ).toThrow(PlanStaleError);
    expect(() =>
      readPayload({ productId: PROD, isFavourite: true, name: "x" }, false)
    ).toThrow(PlanStaleError);
  });

  it("rejects a payload with a non-product-id", () => {
    expect(() => readPayload({ productId: "not-an-id", isFavourite: true }, true)).toThrow(
      PlanStaleError
    );
  });

  it("accepts a well-formed, operation-consistent payload", () => {
    expect(readPayload({ productId: PROD, isFavourite: true, name: "x" }, true)).toEqual({
      productId: PROD,
      isFavourite: true,
      name: "x",
    });
  });
});

describe("favourites gate — reconcile", () => {
  it("divergent (exit 6) when the write did not reach the intended membership", async () => {
    // onSet no-ops → membership never changes.
    const f = fakeApi([], { onSet: () => {} });
    const id = await preview(f, "fav.add");
    await expect(
      runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("dispatch applies then throws, but membership DID reach intended → success", async () => {
    // set() adds PROD then throws; reconcile re-reads and sees the intended state.
    const f = fakeApi([], { throwAfterSet: true });
    const id = await preview(f, "fav.add");
    await runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id });
    expect(f.set).toHaveBeenCalledWith(PROD, true);
    expect(lastJson().ok).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("dispatch throws and membership NOT reached → divergent (exit 6)", async () => {
    const f = fakeApi([], { throwOnSet: true });
    const id = await preview(f, "fav.add");
    await expect(
      runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });

  it("post-dispatch re-read failure → divergent (outcome unknown)", async () => {
    // reads: 1 preview, 2 confirm-before, 3 reconcile (fails).
    const f = fakeApi([], { failReadOnCall: 3 });
    const id = await preview(f, "fav.add");
    await expect(
      runFavMutation(f.api, "fav.add", PROD, { json: true, confirm: id })
    ).rejects.toBeInstanceOf(DivergentOutcomeError);
  });
});
