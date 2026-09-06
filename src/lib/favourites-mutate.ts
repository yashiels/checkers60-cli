import chalk from "chalk";
import { CheckersAPI } from "./api.js";
import {
  acquireConfirmLock,
  claimPlan,
  loadPlan,
  mobileHash,
  PLAN_CANON,
  PLAN_SCHEMA_VERSION,
  PlanStaleError,
  writePlan,
  type PlanAccount,
} from "./confirm.js";
import { DivergentOutcomeError, EXIT_CONFIRM, UsageError } from "./errors.js";
import { isProductId } from "./format.js";

export type FavOperation = "fav.add" | "fav.remove";

export interface FavOptions {
  json?: boolean;
  confirm?: string;
}

interface Pick {
  productId: string;
  name: string;
}

function account(session: { userId: string; uuid: string; mobile: string }): PlanAccount {
  return { userId: session.userId, uuid: session.uuid, mobileHash: mobileHash(session.mobile) };
}

async function resolvePick(api: CheckersAPI, target: string): Promise<Pick> {
  if (isProductId(target)) {
    const details = await api.getProductDetails([target]);
    const d = details[0];
    if (!d) throw new UsageError(`Product ${target} not found.`);
    return { productId: d.id, name: (d.name ?? d.displayName ?? d.id) as string };
  }
  const { products } = await api.searchProducts(target, { pageSize: 5 });
  const p = products[0];
  if (!p) throw new UsageError(`No results for "${target}".`);
  return { productId: p.id, name: p.name };
}

/**
 * Read + validate the resolved favourites payload from a loaded plan. Beyond field
 * types, the payload's `isFavourite` MUST equal the boolean the invoked operation
 * implies, and `productId` MUST be a real product id — so a plan can never act as a
 * confused deputy (e.g. a payload asking to REMOVE reached via `fav add`).
 */
export function readPayload(
  payload: Record<string, unknown> | undefined,
  expectedIsFavourite: boolean
): { productId: string; isFavourite: boolean; name?: string } {
  if (
    !payload ||
    typeof payload.productId !== "string" ||
    typeof payload.isFavourite !== "boolean"
  ) {
    throw new PlanStaleError("Plan is missing its favourites payload. Run the preview again.");
  }
  if (payload.isFavourite !== expectedIsFavourite) {
    throw new PlanStaleError("Plan does not match the requested operation. Run the preview again.");
  }
  if (!isProductId(payload.productId)) {
    throw new PlanStaleError("Plan has an invalid product id. Run the preview again.");
  }
  return {
    productId: payload.productId,
    isFavourite: payload.isFavourite,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

/**
 * Preview → confirm flow for a favourites toggle. Idempotent per-product: the
 * plan binds the product id and the intended boolean; confirm POSTs once and
 * reconciles by re-reading membership (favourites are always reconcilable to the
 * desired state — Oracle r-mut2). No whole-cart concurrency machinery is needed.
 */
export async function runFavMutation(
  api: CheckersAPI,
  operation: FavOperation,
  target: string,
  options: FavOptions
): Promise<void> {
  const session = await api.tokens.getSession();
  const acct = account(session);
  const intended = operation === "fav.add";

  if (!options.confirm) {
    // ── Preview ──
    const pick = await resolvePick(api, target);
    const current = await api.getFavouriteIds();
    const wasFavourite = current.has(pick.productId);
    if (wasFavourite === intended) {
      const msg = intended
        ? `"${pick.name}" is already in your favourites.`
        : `"${pick.name}" is not in your favourites.`;
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, noop: true, reason: msg }, null, 2)}\n`);
      } else {
        process.stdout.write(`${chalk.dim(msg)}\n`);
      }
      return;
    }
    const plan = writePlan(acct, operation, {
      payload: { productId: pick.productId, name: pick.name, isFavourite: intended },
      preconditions: { wasFavourite },
    });
    process.exitCode = EXIT_CONFIRM;
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            confirmationRequired: true,
            code: EXIT_CONFIRM,
            plan: {
              operation,
              planId: plan.planId,
              expiresAt: plan.expiresAt,
              productId: pick.productId,
              name: pick.name,
              isFavourite: intended,
            },
            confirm: `checkers60 fav ${intended ? "add" : "remove"} … --confirm ${plan.planId}`,
          },
          null,
          2
        )}\n`
      );
    } else {
      const verb = intended ? "Favourite" : "Un-favourite";
      process.stdout.write(
        `${chalk.yellow("⚠ Confirmation required")} — no change has been made.\n` +
          `  ${chalk.bold(verb)}: ${pick.name}\n` +
          `  ${chalk.dim("To apply, re-run with:")} ${chalk.green(`--confirm ${plan.planId}`)}\n`
      );
    }
    return;
  }

  // ── Confirm ──
  const plan = loadPlan(options.confirm, acct, operation);
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.canon !== PLAN_CANON) {
    throw new PlanStaleError("Plan is from an incompatible version. Run the preview again.");
  }
  const { productId, isFavourite, name } = readPayload(plan.payload, intended);

  const release = await acquireConfirmLock(acct);
  try {
    // Single-use: claim BEFORE dispatch.
    claimPlan(plan.planId);

    const before = await api.getFavouriteIds();
    if (before.has(productId) !== isFavourite) {
      // Not already in the desired state — POST once, never auto-retry.
      let dispatchFailed = false;
      try {
        await api.setFavourite(productId, isFavourite);
      } catch {
        dispatchFailed = true;
      }
      // Reconcile by re-reading membership (favourites are always reconcilable).
      let after: Set<string>;
      try {
        after = await api.getFavouriteIds();
      } catch {
        throw new DivergentOutcomeError(
          "Favourite write was dispatched but membership could not be re-read to confirm the outcome.",
          "checkers60 fav --json"
        );
      }
      if (after.has(productId) !== isFavourite) {
        throw new DivergentOutcomeError(
          `Favourite write dispatched${dispatchFailed ? " (with an error)" : ""} but membership did not reach the intended state.`,
          "checkers60 fav --json"
        );
      }
    }
    // else: already in the desired state — idempotent success, nothing to dispatch.

    const label = name ?? productId;
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, operation, productId, isFavourite }, null, 2)}\n`
      );
    } else {
      process.stdout.write(
        `${chalk.green("✅ Done.")} ${chalk.dim(`${label} ${isFavourite ? "added to" : "removed from"} favourites.`)}\n`
      );
    }
  } finally {
    await release();
  }
}
