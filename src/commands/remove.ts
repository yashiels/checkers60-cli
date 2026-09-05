import { CheckersAPI } from "../lib/api.js";
import { runCartMutation, type MutateOptions } from "../lib/cart-mutate.js";
import { UsageError } from "../lib/errors.js";
import { isProductId } from "../lib/format.js";
import { resolveNames } from "./cart.js";

export type RemoveOptions = MutateOptions;

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
    return {
      displayName: names.get(String(match.productId)) ?? String(match.productId),
      intent: {
        operation: "cart.remove",
        targetCartId: targetCart.cartId,
        targetServiceOptionId: serviceOptionId,
        productId: String(match.productId),
        quantity: qty,
      },
    };
  });
}
