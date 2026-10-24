import type { CartSnapshot } from './confirm.js';

export function cartMode(serviceOptionId: string): string {
  if (serviceOptionId === 'sixty-min-delivery') return 'sixty-min';
  if (serviceOptionId === 'one-day-delivery') return 'one-day';
  return serviceOptionId;
}

export function summarizeCart(cart: CartSnapshot) {
  return {
    mode: cartMode(cart.serviceOptionId),
    serviceOptionId: cart.serviceOptionId,
    cartId: cart.cartId,
    cartVersion: cart.cartVersion,
    itemCount: cart.lineItems.length,
    total: cart.lineItems.reduce(
      (sum, item) => sum + Number(item.price) * Number(item.quantity),
      0,
    ),
  };
}
