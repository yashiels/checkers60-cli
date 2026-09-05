import chalk from "chalk";
import { APIError, CheckersAPI, objectId } from "./api.js";
import { CONFIG } from "./config.js";
import {
  acquireConfirmLock,
  claimPlan,
  computePlanId,
  loadPlan,
  mobileHash,
  PLAN_CANON,
  PLAN_SCHEMA_VERSION,
  PlanStaleError,
  writePlan,
  type CartSnapshot,
  type CartOperation,
  type MutationIntent,
  type Plan,
  type PlanAccount,
  type PlanSnapshot,
} from "./confirm.js";
import { DivergentOutcomeError, EXIT_CONFIRM, UsageError } from "./errors.js";
import { formatRand } from "./format.js";

export type CartMode = "sixty-min" | "one-day";

const MODE_SERVICE_OPTION: Record<CartMode, string> = {
  "sixty-min": "sixty-min-delivery",
  "one-day": "one-day-delivery",
};

export interface MutateOptions {
  json?: boolean;
  confirm?: string;
  mode?: string;
}

/** The resolved product a `cart.add` will introduce when it isn't already present. */
export interface NewLineSpec {
  productId: string;
  name: string;
  price: number; // cents
  priceFactor?: number;
  storeId?: string;
  serviceOptionId: string;
}

function resolveServiceOption(mode?: string): string {
  if (!mode) return MODE_SERVICE_OPTION["sixty-min"];
  const key = mode.toLowerCase();
  if (key === "sixty-min" || key === "sixty-min-delivery" || key === "60min")
    return "sixty-min-delivery";
  if (key === "one-day" || key === "one-day-delivery" || key === "nextday")
    return "one-day-delivery";
  throw new UsageError(`Unknown --mode "${mode}". Use "sixty-min" or "one-day".`);
}

function account(session: { userId: string; uuid: string; mobile: string }): PlanAccount {
  return {
    userId: session.userId,
    uuid: session.uuid,
    mobileHash: mobileHash(session.mobile),
  };
}

/** Fields that make a line unsafe to quantity-adjust or add without a captured contract. */
function unsupportedReason(line: Record<string, unknown>): string | null {
  if (line.hasAlcohol === true || line.requiresOver18 === true) return "age-restricted";
  if (line.optionSelections != null && (line.optionSelections as unknown[]).length !== 0)
    return "has option selections";
  if (line.selectedWeightRange != null) return "weighted / priced by weight";
  return null;
}

/**
 * Whether a resolved catalog product has a shape we can't safely synthesize into
 * a plain line item yet (age-restricted, weighted / priced-by-measure, or
 * configurable / option-bearing). Conservative: covers the known catalog signals.
 */
export function productShapeReason(p: Record<string, unknown>): string | null {
  if (p.hasAlcohol === true || p.requiresOver18 === true) return "age-restricted";
  const weighted =
    p.sellByWeight === true ||
    p.isVariableWeight === true ||
    p.variableWeight === true ||
    p.isWeighted === true ||
    p.averageWeight != null ||
    p.selectedWeightRange != null ||
    (Array.isArray(p.weightRanges) && (p.weightRanges as unknown[]).length > 0);
  if (weighted) return "weighted / priced by weight";
  const configurable =
    p.isConfigurable === true ||
    p.hasProductOptions === true ||
    (Array.isArray(p.productOptions) && (p.productOptions as unknown[]).length > 0) ||
    (Array.isArray(p.options) && (p.options as unknown[]).length > 0) ||
    (Array.isArray(p.variants) && (p.variants as unknown[]).length > 0);
  if (configurable) return "configurable / has options";
  return null;
}

/** Guard-relevant fingerprint of a snapshot: any drift here between preview and confirm refuses. */
function fingerprint(snapshot: PlanSnapshot): string {
  const carts = snapshot.carts
    .map((c) => ({
      cartId: c.cartId,
      serviceOptionId: c.serviceOptionId,
      cartVersion: c.cartVersion,
      deliveryAddressId: c.deliveryAddressId,
      lines: c.lineItems
        .map((li) => ({
          id: li.id,
          productId: li.productId,
          quantity: li.quantity,
          price: li.price,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    }))
    .sort((a, b) => a.cartId.localeCompare(b.cartId));
  return JSON.stringify({
    carts,
    deliveryAddressId: snapshot.deliveryAddressId,
    storeContexts: snapshot.storeContexts,
  });
}

function hasMalformedVersion(snapshot: PlanSnapshot): boolean {
  return snapshot.carts.some((c) => !Number.isFinite(c.cartVersion));
}

function clone(snapshot: PlanSnapshot): PlanSnapshot {
  return structuredClone(snapshot);
}

function findCart(snapshot: PlanSnapshot, cartId: string): CartSnapshot | undefined {
  return snapshot.carts.find((c) => c.cartId === cartId);
}

/**
 * Apply a mutation to a snapshot, returning a NEW snapshot. Used both to render
 * the preview and to build the write from the fresh snapshot at confirm time.
 */
function applyMutation(snapshot: PlanSnapshot, intent: MutationIntent): PlanSnapshot {
  const next = clone(snapshot);
  const cart = findCart(next, intent.targetCartId);
  if (!cart) {
    throw new PlanStaleError("Target cart no longer exists. Run the preview again.");
  }

  if (intent.operation === "cart.clear") {
    cart.lineItems = [];
    return next;
  }

  // A product may occupy more than one line; handle every matching line.
  const matches = cart.lineItems.filter((li) => li.productId === intent.productId);
  for (const m of matches) {
    const reason = unsupportedReason(m);
    if (reason) {
      throw new UsageError(
        `Cannot change quantity of "${intent.productId}" (${reason}). Not supported yet.`
      );
    }
  }

  if (intent.operation === "cart.add") {
    if (matches.length > 0) {
      matches[0].quantity = (Number(matches[0].quantity) || 0) + (intent.quantity ?? 1);
    } else {
      if (!intent.newLine) {
        throw new PlanStaleError("Missing line specification. Run the preview again.");
      }
      cart.lineItems.push(structuredClone(intent.newLine));
    }
    return next;
  }

  // cart.remove
  if (matches.length === 0) {
    throw new UsageError(`"${intent.productId}" is not in the ${cart.serviceOptionId} cart.`);
  }
  const total = matches.reduce((n, m) => n + (Number(m.quantity) || 0), 0);
  if (intent.quantity === undefined || intent.quantity >= total) {
    // Remove ALL lines for this product.
    cart.lineItems = cart.lineItems.filter((li) => li.productId !== intent.productId);
  } else {
    // Consume the requested quantity across matching lines, then drop emptied ones.
    let toRemove = intent.quantity;
    for (const m of matches) {
      if (toRemove <= 0) break;
      const q = Number(m.quantity) || 0;
      const take = Math.min(q, toRemove);
      m.quantity = q - take;
      toRemove -= take;
    }
    cart.lineItems = cart.lineItems.filter(
      (li) => !(li.productId === intent.productId && (Number(li.quantity) || 0) === 0)
    );
  }
  return next;
}

function itemCount(cart: CartSnapshot | undefined): number {
  if (!cart) return 0;
  return cart.lineItems.reduce((n, li) => n + (Number(li.quantity) || 0), 0);
}

interface PlanView {
  operation: CartOperation;
  planId: string;
  expiresAt: number;
  mode: string;
  cartId: string;
  cartVersion: number;
  product?: { productId: string; name?: string; price?: number; quantity?: number };
  before: number;
  after: number;
}

function planView(plan: Plan, resultCart: CartSnapshot | undefined, name?: string): PlanView {
  const target = findCart(plan.snapshot, plan.mutation.targetCartId);
  return {
    operation: plan.operation,
    planId: plan.planId,
    expiresAt: plan.expiresAt,
    mode: plan.mutation.targetServiceOptionId,
    cartId: plan.mutation.targetCartId,
    cartVersion: target?.cartVersion ?? Number.NaN,
    product: plan.mutation.productId
      ? {
          productId: plan.mutation.productId,
          name,
          price: plan.mutation.newLine
            ? (plan.mutation.newLine.price as number)
            : undefined,
          quantity: plan.mutation.quantity,
        }
      : undefined,
    before: itemCount(target),
    after: itemCount(resultCart),
  };
}

function printPreview(view: PlanView, options: MutateOptions): void {
  process.exitCode = EXIT_CONFIRM;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          confirmationRequired: true,
          code: EXIT_CONFIRM,
          plan: view,
          confirm: `checkers60 ${view.operation.replace("cart.", "")} … --confirm ${view.planId}`,
        },
        null,
        2
      )}\n`
    );
    return;
  }
  const label = view.operation.replace("cart.", "");
  process.stdout.write(
    `${chalk.yellow("⚠ Confirmation required")} — no change has been made.\n` +
      `  ${chalk.bold(label)} on the ${chalk.cyan(view.mode)} cart` +
      (view.product?.name ? `: ${view.product.name}` : "") +
      (view.product?.quantity ? ` ×${view.product.quantity}` : "") +
      (view.product?.price ? ` ${chalk.dim(`(${formatRand(view.product.price)})`)}` : "") +
      "\n" +
      `  Cart items: ${view.before} → ${view.after}\n` +
      `  ${chalk.dim("To apply, re-run with:")} ${chalk.green(`--confirm ${view.planId}`)}\n` +
      `  ${chalk.dim("Plan expires in 15 minutes. Last-writer-wins; a concurrent change refuses.")}\n`
  );
}

/**
 * Reconcile the post-write cart against the intended and original states.
 * Returns "success" | "unchanged"; throws {@link DivergentOutcomeError} otherwise.
 */
function findCartByMode(snapshot: PlanSnapshot, serviceOptionId: string): CartSnapshot | undefined {
  return snapshot.carts.find((c) => c.serviceOptionId === serviceOptionId);
}

/** True if two carts share a delivery mode (ambiguous targeting/reconciliation). */
function hasDupModes(snapshot: PlanSnapshot): boolean {
  const seen = new Set<string>();
  for (const c of snapshot.carts) {
    if (seen.has(c.serviceOptionId)) return true;
    seen.add(c.serviceOptionId);
  }
  return false;
}

/** Two carts with the same delivery mode make targeting/reconciliation ambiguous. */
function assertNoDupModes(snapshot: PlanSnapshot): void {
  if (hasDupModes(snapshot)) {
    throw new PlanStaleError("Ambiguous cart state: two carts share a delivery mode. Run the preview again.");
  }
}

/**
 * Per-mode semantic projection: for each cart (keyed by service option, so a
 * DELETE that rotates the cart id still matches) the total quantity per productId,
 * aggregated so line splitting/reordering can't change the result. Line ids,
 * prices, and server metadata are intentionally excluded — the server assigns line
 * ids and may legitimately re-price; comparing them would report false divergence.
 * Address is compared separately. Assumes no duplicate modes (checked upstream).
 */
function modeSets(s: PlanSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of s.carts) {
    const totals: Record<string, number> = {};
    for (const li of c.lineItems) {
      const pid = String(li.productId);
      totals[pid] = (totals[pid] ?? 0) + (Number(li.quantity) || 0);
    }
    const entries = Object.entries(totals)
      .filter(([, q]) => q !== 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
    // Include the cart's own delivery address: a per-cart address change is a
    // collateral mutation that must not read as success.
    out[c.serviceOptionId] = JSON.stringify({ addr: c.deliveryAddressId, items: entries });
  }
  return out;
}

/** Whole-snapshot equality: EVERY cart's item set plus the delivery address. */
function snapshotEquivalent(a: PlanSnapshot, b: PlanSnapshot): boolean {
  if (a.deliveryAddressId !== b.deliveryAddressId) return false;
  const ma = modeSets(a);
  const mb = modeSets(b);
  const keys = new Set([...Object.keys(ma), ...Object.keys(mb)]);
  for (const k of keys) {
    if (ma[k] !== mb[k]) return false;
  }
  return true;
}

/**
 * Authoritative reconcile against the COMPLETE post-write snapshot: success only
 * if every cart AND the address match the intended state; "unchanged" only if
 * everything matches the original; anything else (collateral change to another
 * cart, address, etc.) is divergent.
 */
function reconcile(
  fresh: PlanSnapshot,
  intended: PlanSnapshot,
  original: PlanSnapshot
): "success" | "unchanged" | "divergent" {
  // Ambiguity anywhere (esp. a post-dispatch duplicate mode) can't be a clean match.
  if (hasDupModes(fresh) || hasDupModes(intended) || hasDupModes(original)) return "divergent";
  if (snapshotEquivalent(fresh, intended)) return "success";
  if (snapshotEquivalent(fresh, original)) return "unchanged";
  return "divergent";
}

/** Sanitized description of a dispatch error — never interpolates APIError.message (may carry a body). */
function safeErr(err: unknown): string {
  if (err instanceof APIError) return `HTTP ${err.status} ${err.statusText}`;
  if (err instanceof Error) return err.name || "error";
  return "error";
}

/**
 * The full preview → confirm → reconcile flow for a cart mutation. Preview mode
 * (no `options.confirm`) persists a single-use plan artifact and exits 5.
 */
export type BuildIntentResult =
  | { intent: MutationIntent; displayName?: string; noop?: false }
  | { noop: true; reason?: string };

export async function runCartMutation(
  api: CheckersAPI,
  operation: CartOperation,
  options: MutateOptions,
  buildIntent: (
    targetCart: CartSnapshot,
    serviceOptionId: string
  ) => Promise<BuildIntentResult>
): Promise<void> {
  const session = await api.tokens.getSession();
  const acct = account(session);
  const serviceOptionId = resolveServiceOption(options.mode);

  if (!options.confirm) {
    // ── Preview: read, compute the plan, persist artifact, exit 5 ──
    const snapshot = await api.getCarts();
    assertNoDupModes(snapshot);
    if (hasMalformedVersion(snapshot)) {
      // Confirmation would reject this, so never stage a plan we can't honor.
      throw new PlanStaleError("A cart is missing its version. Try again in a moment.");
    }
    const target = snapshot.carts.find((c) => c.serviceOptionId === serviceOptionId);
    if (!target) {
      throw new UsageError(`No ${serviceOptionId} cart available for your account.`);
    }
    const built = await buildIntent(target, serviceOptionId);
    if (built.noop) {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, noop: true, reason: built.reason ?? "nothing-to-do" }, null, 2)}\n`
        );
      } else {
        process.stdout.write(`${chalk.dim(built.reason ?? "Nothing to do.")}\n`);
      }
      return;
    }
    const { intent, displayName } = built;
    const result = applyMutation(snapshot, intent); // validates (throws on unsupported / not-found)
    const plan = writePlan(acct, operation, snapshot, intent);
    printPreview(planView(plan, findCart(result, intent.targetCartId), displayName), options);
    return;
  }

  // ── Confirm: load + verify artifact, re-read, guard, claim, dispatch, reconcile ──
  const plan = loadPlan(options.confirm, acct);
  if (plan.operation !== operation) {
    throw new PlanStaleError(
      `Plan is for ${plan.operation}, not ${operation}. Run the preview again.`
    );
  }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.canon !== PLAN_CANON) {
    throw new PlanStaleError("Plan is from an incompatible version. Run the preview again.");
  }

  const release = await acquireConfirmLock();
  try {
    const fresh = await api.getCarts();
    assertNoDupModes(fresh);
    if (hasMalformedVersion(fresh)) {
      throw new PlanStaleError("A cart is missing its version. Run the preview again.");
    }
    if (fingerprint(fresh) !== fingerprint(plan.snapshot)) {
      throw new PlanStaleError("The cart changed since the preview. Run the preview again.");
    }

    // Rebuild the write EXCLUSIVELY from the fresh snapshot.
    const intended = applyMutation(fresh, plan.mutation);

    // The whole-cart /carts/update contract rejects an empty line-item list (400);
    // emptying a cart (clear, or removing the last item) uses DELETE instead.
    const intendedTarget = findCart(intended, plan.mutation.targetCartId);
    const willEmpty = !intendedTarget || intendedTarget.lineItems.length === 0;

    // Single-use: atomically claim BEFORE dispatch. After this the plan is spent.
    claimPlan(plan.planId);

    // Dispatch may or may not have reached the server — never auto-retry. Whether
    // it threw or not, ALWAYS reconcile authoritatively before deciding anything.
    let dispatchFailed = false;
    let dispatchError: unknown;
    try {
      if (willEmpty) {
        await api.deleteCart(plan.mutation.targetCartId);
      } else {
        await api.commitCartUpdate(intended);
      }
    } catch (err) {
      dispatchFailed = true;
      dispatchError = err;
    }

    const cause = dispatchFailed ? ` (${safeErr(dispatchError)})` : "";

    let after: PlanSnapshot;
    try {
      after = await api.getCarts();
    } catch {
      // Dispatched but state is unreadable — genuinely unknown.
      throw new DivergentOutcomeError(
        `Cart write was dispatched${cause} but the cart could not be re-read to confirm the outcome.`
      );
    }

    const outcome = reconcile(after, intended, plan.snapshot);

    if (outcome === "divergent") {
      throw new DivergentOutcomeError(
        `Cart write dispatched${cause} but the cart matches neither the intended nor the original state.`
      );
    }
    if (outcome === "unchanged") {
      throw new PlanStaleError(
        dispatchFailed
          ? `The write failed${cause} and the cart is unchanged. Run the preview again.`
          : "The write did not change the cart (a concurrent change likely intervened). Run the preview again."
      );
    }
    // outcome === "success": the intended state was reached (even if dispatch reported an error).

    const targetCart = findCartByMode(after, plan.mutation.targetServiceOptionId);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          { ok: true, operation, planId: plan.planId, itemCount: itemCount(targetCart) },
          null,
          2
        )}\n`
      );
    } else {
      process.stdout.write(
        `${chalk.green("✅ Done.")} ${chalk.dim(`${operation.replace("cart.", "")} applied — cart now has ${itemCount(targetCart)} item(s).`)}\n`
      );
    }
  } finally {
    await release();
  }
}

/** Build the full captured line-item shape for a NOT-YET-PRESENT product. */
export function buildNewLine(spec: NewLineSpec, quantity: number): Record<string, unknown> {
  return {
    id: objectId(),
    status: "available",
    price: spec.price,
    priceFactor: spec.priceFactor ?? 100,
    previousPrice: 0,
    productId: spec.productId,
    instruction: "",
    quantity,
    specialInstruction: "",
    storeId: spec.storeId ?? CONFIG.DEFAULT_STORES[0].storeId,
    replacementPreferenceId: "",
    missionName: "",
    missionType: "",
    addToBasketType: "quick_add",
    addToBasketJourney: "cli",
    serviceOptionId: spec.serviceOptionId,
    isStockAvailable: true,
    requiresOver18: false,
    isSponsoredProduct: false,
    hasAlcohol: false,
    product: null,
  };
}
