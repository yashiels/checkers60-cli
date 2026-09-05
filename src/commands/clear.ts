import { CheckersAPI } from "../lib/api.js";
import { runCartMutation, type MutateOptions } from "../lib/cart-mutate.js";

export type ClearOptions = MutateOptions;

export async function clear(options: ClearOptions = {}): Promise<void> {
  const api = new CheckersAPI();

  await runCartMutation(api, "cart.clear", options, async (targetCart, serviceOptionId) => {
    if (targetCart.lineItems.length === 0) {
      return { noop: true, reason: `The ${serviceOptionId} cart is already empty.` };
    }
    return {
      intent: {
        operation: "cart.clear",
        targetCartId: targetCart.cartId,
        targetServiceOptionId: serviceOptionId,
      },
    };
  });
}
