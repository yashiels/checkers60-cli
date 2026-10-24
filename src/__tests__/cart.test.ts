import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckersAPI } from '../lib/api.js';
import { cart } from '../commands/cart.js';
import { status } from '../commands/status.js';
import { UsageError } from '../lib/errors.js';
import type { PlanSnapshot } from '../lib/confirm.js';

vi.mock('../lib/credentials.js', () => ({
  TokenManager: class {
    isAuthenticated() {
      return true;
    }
  },
  loadCredentials: () => ({}),
}));

function snapshot(): PlanSnapshot {
  return {
    carts: [
      {
        cartId: 'cart-60',
        cartVersion: 3,
        serviceOptionId: 'sixty-min-delivery',
        deliveryAddressId: 'address',
        lineItems: [{ productId: 'milk', quantity: 2, price: 1500 }],
      },
      {
        cartId: 'cart-1d',
        cartVersion: 7,
        serviceOptionId: 'one-day-delivery',
        deliveryAddressId: 'address',
        lineItems: [{ productId: 'bread', quantity: 1, price: 2200 }],
      },
    ],
    deliveryAddressId: 'address',
    storeContexts: [],
  };
}

let state: PlanSnapshot;
let output: string;

beforeEach(() => {
  state = snapshot();
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(CheckersAPI.prototype, 'getCarts').mockImplementation(async () => state);
  vi.spyOn(CheckersAPI.prototype, 'getProductDetails').mockResolvedValue([
    { id: 'milk', name: 'Milk' },
    { id: 'bread', name: 'Bread' },
  ]);
});

afterEach(() => vi.restoreAllMocks());

describe('all-cart reads', () => {
  it('emits both carts with totals and legacy fields for sixty-min', async () => {
    await cart({ json: true });
    const data = JSON.parse(output);
    expect(data.carts).toEqual([
      {
        mode: 'sixty-min',
        serviceOptionId: 'sixty-min-delivery',
        cartId: 'cart-60',
        cartVersion: 3,
        itemCount: 1,
        total: 3000,
        items: [{ productId: 'milk', name: 'Milk', quantity: 2, price: 1500 }],
      },
      {
        mode: 'one-day',
        serviceOptionId: 'one-day-delivery',
        cartId: 'cart-1d',
        cartVersion: 7,
        itemCount: 1,
        total: 2200,
        items: [{ productId: 'bread', name: 'Bread', quantity: 1, price: 2200 }],
      },
    ]);
    for (const field of ['cartId', 'cartVersion', 'itemCount', 'total', 'items']) {
      expect(data[field]).toEqual(data.carts[0][field]);
    }
    expect(data.grandTotal).toBe(5200);
  });

  it('renders both mode groups, counts, subtotals, and grand total', async () => {
    await cart();
    expect(output).toContain('sixty-min cart');
    expect(output).toContain('one-day cart');
    expect(output).toContain('Milk');
    expect(output).toContain('Bread');
    expect(output).toContain('R30.00');
    expect(output).toContain('R22.00');
    expect(output).toContain('(1 items)');
    expect(output).toContain('Grand total: R52.00');
  });

  it.each(['one-day', 'nextday', 'one-day-delivery'])(
    'filters %s and matches legacy fields',
    async (mode) => {
      await cart({ mode, json: true });
      const data = JSON.parse(output);
      expect(data.carts).toHaveLength(1);
      expect(data.carts[0].mode).toBe('one-day');
      for (const field of ['cartId', 'cartVersion', 'itemCount', 'total', 'items']) {
        expect(data[field]).toEqual(data.carts[0][field]);
      }
      expect(data.grandTotal).toBe(2200);
      expect(CheckersAPI.prototype.getProductDetails).toHaveBeenCalledWith(['bread']);
    },
  );

  it('shows an empty one-day cart in JSON and text', async () => {
    state.carts[1].lineItems = [];
    await cart({ json: true });
    expect(JSON.parse(output).carts[1]).toMatchObject({
      mode: 'one-day',
      itemCount: 0,
      total: 0,
      items: [],
    });
    output = '';
    await cart();
    expect(output).toContain('one-day cart\nYour cart is empty.');
    expect(output).toContain('Total: R0.00');
  });

  it('rejects unknown modes before making API calls', async () => {
    await expect(cart({ mode: 'invalid' })).rejects.toBeInstanceOf(UsageError);
    expect(CheckersAPI.prototype.getCarts).not.toHaveBeenCalled();
  });

  it('resolves deals separately for each cart', async () => {
    const lookup = vi
      .spyOn(CheckersAPI.prototype, 'getProductsWithDeals')
      .mockImplementation(async (ids) => ({
        products: ids.map((id) => ({ id, name: id, bonusBuyIds: [id] })),
        deals: ids.map((id) => ({
          id,
          title: `${id} deal`,
          description: 'Offer',
          membersOnly: false,
          active: true,
          availableOnSixty60: true,
          memberProductIds: [],
          memberArticleNumbers: [],
        })),
      }));
    await cart({ json: true, deals: true });
    const data = JSON.parse(output);
    expect(lookup).toHaveBeenCalledWith(['milk']);
    expect(lookup).toHaveBeenCalledWith(['bread']);
    expect(data.carts[0].deals[0].items).toEqual([{ productId: 'milk', name: 'Milk' }]);
    expect(data.carts[1].deals[0].items).toEqual([{ productId: 'bread', name: 'Bread' }]);
    expect(data.deals).toEqual(data.carts[0].deals);
  });

  it('returns a stable empty response when no carts exist', async () => {
    state.carts = [];
    await cart({ json: true });
    expect(JSON.parse(output)).toEqual({
      cartId: null,
      cartVersion: 0,
      itemCount: 0,
      total: 0,
      items: [],
      carts: [],
      grandTotal: 0,
    });
  });

  it('summarizes every mode and flags non-empty carts in status JSON and text', async () => {
    state.carts[1].lineItems = [];
    await status({ json: true });
    const data = JSON.parse(output);
    expect(data.cart).toEqual({ cartId: 'cart-60', itemCount: 1, total: 3000 });
    expect(data.carts).toEqual([
      expect.objectContaining({ mode: 'sixty-min', itemCount: 1, total: 3000, nonEmpty: true }),
      expect.objectContaining({ mode: 'one-day', itemCount: 0, total: 0, nonEmpty: false }),
    ]);
    output = '';
    await status();
    expect(output).toContain('sixty-min cart: 1 item(s), R30.00 [non-empty]');
    expect(output).toContain('one-day cart: 0 item(s), R0.00 [empty]');
  });
});
