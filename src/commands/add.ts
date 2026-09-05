import { CheckersAPI } from "../lib/api.js";
import {
  buildNewLine,
  productShapeReason,
  runCartMutation,
  type MutateOptions,
} from "../lib/cart-mutate.js";
import { UsageError } from "../lib/errors.js";
import { isProductId } from "../lib/format.js";
import { startSpinner } from "../lib/output.js";

export type AddOptions = MutateOptions;

interface Pick {
  id: string;
  name: string;
  price: number;
  priceFactor?: number;
  storeId?: string;
  /** The full resolved record, for shape validation. */
  raw: Record<string, unknown>;
}

export async function add(target: string, qty = 1, options: AddOptions = {}): Promise<void> {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new UsageError(`Invalid quantity "${qty}". Must be a positive integer.`);
  }

  const spinner = options.json ? null : startSpinner(`Finding "${target}"…`);
  const api = new CheckersAPI();
  const pick = await resolvePick(api, target);
  spinner?.stop();

  const reason = productShapeReason(pick.raw);
  if (reason) {
    throw new UsageError(`"${pick.name}" is ${reason}; adding it via the CLI is not supported yet.`);
  }

  await runCartMutation(api, "cart.add", options, async (targetCart, serviceOptionId) => {
    const present = targetCart.lineItems.some((li) => li.productId === pick.id);
    return {
      displayName: pick.name,
      intent: {
        operation: "cart.add",
        targetCartId: targetCart.cartId,
        targetServiceOptionId: serviceOptionId,
        productId: pick.id,
        quantity: qty,
        newLine: present
          ? undefined
          : buildNewLine(
              {
                productId: pick.id,
                name: pick.name,
                price: pick.price,
                priceFactor: pick.priceFactor,
                storeId: pick.storeId,
                serviceOptionId,
              },
              qty
            ),
      },
    };
  });
}

async function resolvePick(api: CheckersAPI, target: string): Promise<Pick> {
  if (isProductId(target)) {
    const details = await api.getProductDetails([target]);
    const d = details[0];
    if (!d) throw new UsageError(`Product ${target} not found.`);
    if (d.priceWithoutDecimal === undefined) {
      throw new UsageError(`Product ${target} has no price and cannot be added.`);
    }
    return {
      id: d.id,
      name: (d.name ?? d.displayName ?? d.id) as string,
      price: d.priceWithoutDecimal,
      priceFactor: d.priceFactor,
      storeId: d.storeId,
      raw: d as unknown as Record<string, unknown>,
    };
  }

  const { products } = await api.searchProducts(target, { pageSize: 5 });
  const p = products[0];
  if (!p) throw new UsageError(`No results for "${target}".`);
  if (p.price === undefined) {
    throw new UsageError(`"${p.name}" has no price and cannot be added.`);
  }
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    priceFactor: p.priceFactor,
    storeId: p.storeId,
    raw: p as unknown as Record<string, unknown>,
  };
}
