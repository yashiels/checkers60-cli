import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add } from '../commands/add.js';
import { CheckersAPI } from '../lib/api.js';
import { TokenManager } from '../lib/credentials.js';
import type { PlanSnapshot } from '../lib/confirm.js';
import { PlanStaleError } from '../lib/confirm.js';
import { UsageError } from '../lib/errors.js';

const productId = 'abcdef0123456789abcdef01';
const variantId = 'abcdef0123456789abcdef02';
const ranges = [
  { minimumValue: 300, maximumValue: 500 },
  { minimumValue: 500, maximumValue: 700 },
];
const product = {
  id: productId,
  name: 'Synthetic mince',
  priceWithoutDecimal: 10000,
  variableWeightOptions: ranges,
};

let planDir: string;
let state: PlanSnapshot;
let output: string;
let previousPlanDir: string | undefined;
let previousCredentialsPath: string | undefined;

beforeEach(() => {
  planDir = mkdtempSync(join(tmpdir(), 'checkers60-add-'));
  previousPlanDir = process.env.CHECKERS60_PLANS_DIR;
  process.env.CHECKERS60_PLANS_DIR = planDir;
  previousCredentialsPath = process.env.CHECKERS60_CREDS_PATH;
  process.env.CHECKERS60_CREDS_PATH = join(planDir, 'nonexistent-credentials.json');
  state = {
    carts: [
      {
        cartId: 'cart-60',
        serviceOptionId: 'sixty-min-delivery',
        cartVersion: 1,
        deliveryAddressId: 'address-a',
        lineItems: [],
      },
    ],
    deliveryAddressId: 'address-a',
    storeContexts: [],
  };
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(TokenManager.prototype, 'getSession').mockResolvedValue({
    sessionToken: 'synthetic',
    userId: 'test-user',
    uuid: 'test-uuid',
    mobile: 'synthetic-mobile',
    customerId: 'test-customer',
  });
  vi.spyOn(CheckersAPI.prototype, 'searchProducts').mockResolvedValue({
    products: [{ id: productId, name: product.name, price: 10000 }],
    total: 1,
    deals: [],
  });
  vi.spyOn(CheckersAPI.prototype, 'getProductDetails').mockResolvedValue([
    { ...product, id: variantId, name: 'Other variant' },
    product,
  ]);
  vi.spyOn(CheckersAPI.prototype, 'getCarts').mockImplementation(async () =>
    structuredClone(state),
  );
  vi.spyOn(CheckersAPI.prototype, 'commitCartUpdate').mockImplementation(async (snapshot) => {
    state = structuredClone(snapshot);
    return structuredClone(state);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousPlanDir === undefined) delete process.env.CHECKERS60_PLANS_DIR;
  else process.env.CHECKERS60_PLANS_DIR = previousPlanDir;
  if (previousCredentialsPath === undefined) delete process.env.CHECKERS60_CREDS_PATH;
  else process.env.CHECKERS60_CREDS_PATH = previousCredentialsPath;
  rmSync(planDir, { recursive: true, force: true });
  process.exitCode = 0;
});

async function preview(target = 'synthetic mince'): Promise<string> {
  await add(target, 2, { json: true, weight: '300-500' });
  const planId = JSON.parse(output).plan.planId as string;
  output = '';
  return planId;
}

function disableCatalog(): void {
  vi.mocked(CheckersAPI.prototype.searchProducts)
    .mockClear()
    .mockRejectedValue(new Error('search unavailable'));
  vi.mocked(CheckersAPI.prototype.getProductDetails)
    .mockClear()
    .mockRejectedValue(new Error('details unavailable'));
}

describe('add command', () => {
  it('matches uppercase ObjectIds to the exact canonical product with a variant first', async () => {
    await add(productId.toUpperCase(), 2, { json: true, weight: '300-500' });
    expect(CheckersAPI.prototype.getProductDetails).toHaveBeenCalledWith([productId]);
    expect(JSON.parse(output).plan.product).toMatchObject({
      productId,
      name: 'Synthetic mince [300-500g]',
      quantity: 2,
    });
    expect(CheckersAPI.prototype.searchProducts).not.toHaveBeenCalled();
  });

  it('refuses unrelated variants when the exact id is absent', async () => {
    vi.mocked(CheckersAPI.prototype.getProductDetails).mockResolvedValue([
      { ...product, id: variantId },
    ]);
    await expect(preview(productId.toUpperCase())).rejects.toThrow(/not found/);
    expect(CheckersAPI.prototype.commitCartUpdate).not.toHaveBeenCalled();
    expect(output).toBe('');
  });

  it('does not repair a malformed identifier into a product id', async () => {
    vi.mocked(CheckersAPI.prototype.searchProducts).mockResolvedValue({
      products: [],
      total: 0,
      deals: [],
    });
    await expect(preview(` ${productId} `)).rejects.toThrow(/No results/);
    expect(CheckersAPI.prototype.getProductDetails).not.toHaveBeenCalled();
    expect(CheckersAPI.prototype.searchProducts).toHaveBeenCalledWith(` ${productId} `, {
      pageSize: 5,
    });
  });

  it('confirms the frozen product, quantity and range without any catalog calls', async () => {
    const planId = await preview();
    disableCatalog();
    await add(variantId, 9, { json: true, confirm: planId, weight: '500-700' });
    expect(CheckersAPI.prototype.searchProducts).not.toHaveBeenCalled();
    expect(CheckersAPI.prototype.getProductDetails).not.toHaveBeenCalled();
    expect(state.carts[0].lineItems).toHaveLength(1);
    expect(state.carts[0].lineItems[0]).toMatchObject({
      productId,
      quantity: 2,
      selectedWeightRange: ranges[0],
      price: 5000,
    });
    expect(JSON.parse(output).ok).toBe(true);
  });

  it.each([0, -1, 1.5, NaN])(
    'rejects invalid confirmation quantity %s before accessing the API',
    async (qty) => {
      const planId = await preview();
      disableCatalog();
      vi.mocked(TokenManager.prototype.getSession).mockClear();
      await expect(
        add('synthetic mince', qty, { json: true, confirm: planId }),
      ).rejects.toBeInstanceOf(UsageError);
      expect(TokenManager.prototype.getSession).not.toHaveBeenCalled();
      expect(CheckersAPI.prototype.commitCartUpdate).not.toHaveBeenCalled();
    },
  );

  it('still rejects a stale cart during catalog-free confirmation', async () => {
    const planId = await preview();
    disableCatalog();
    state.carts[0].cartVersion++;
    await expect(add('synthetic mince', 1, { json: true, confirm: planId })).rejects.toBeInstanceOf(
      PlanStaleError,
    );
    expect(CheckersAPI.prototype.commitCartUpdate).not.toHaveBeenCalled();
  });
});
