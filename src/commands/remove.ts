import { CheckersAPI } from "../lib/api.js";
import {
  distinctRanges,
  formatWeightRange,
  pickWeightRange,
  runCartMutation,
  type MutateOptions,
} from "../lib/cart-mutate.js";
import type { WeightRange } from "../lib/confirm.js";
import { UsageError } from "../lib/errors.js";
import { isProductId } from "../lib/format.js";
import { resolveNames } from "./cart.js";

export interface RemoveOptions extends MutateOptions {
  /** Weighted products in several ranges: which range's line to remove, e.g. "300-500". */
  weight?: string;
}

export async function remove(
  target: string,
  qty: number | undefined,
  options: RemoveOptions = {}
): Promise<void> {
  if (qty !== undefined && (!Number.isInteger(qty) || qty < 1)) {
    throw new UsageError(`Invalid quantity "${qty}". Must be a positive integer.`);
  }

  const api = new CheckersAPI();

  await runCartMutation(api, "cart.remove", options, async (targetCart, serviceOptionId) => {
    const byId = isProductId(target);
    const names = byId
      ? new Map<string, string>()
      : await resolveNames(
          api,
          targetCart.lineItems.map((li) => String(li.productId))
        );
    const match = targetCart.lineItems.find((li) =>
      byId
        ? li.productId === target
        : (names.get(String(li.productId)) ?? "").toLowerCase().includes(target.toLowerCase())
    );
    if (!match) {
      throw new UsageError(`"${target}" is not in the ${serviceOptionId} cart.`);
    }
    const name = names.get(String(match.productId)) ?? String(match.productId);
    const lines = targetCart.lineItems.filter((li) => li.productId === match.productId);
    const ranges = distinctRanges(lines);
    const weighted = ranges.filter((r): r is WeightRange => r !== null);
    let weightRange: WeightRange | undefined;
    if (weighted.length === 0) {
      if (options.weight !== undefined) {
        throw new UsageError(`"${name}" is not sold by weight; drop --weight.`);
      }
    } else if (ranges.length === 1 && options.weight === undefined) {
      weightRange = weighted[0];
    } else {
      // Several ranges in the cart (or an explicit choice): pick among the ones present.
      weightRange = pickWeightRange(name, weighted, options.weight);
    }
    return {
      displayName: weightRange ? `${name} [${formatWeightRange(weightRange)}g]` : name,
      intent: {
        operation: "cart.remove",
        targetCartId: targetCart.cartId,
        targetServiceOptionId: serviceOptionId,
        productId: String(match.productId),
        quantity: qty,
        weightRange,
      },
    };
  });
}
