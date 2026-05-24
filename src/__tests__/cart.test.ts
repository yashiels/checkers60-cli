import { describe, it, expect, beforeAll } from "vitest";
import {
  formatCents,
  formatLineItemName,
  isCartFull,
} from "../commands/cart.js";
import type { Cart, CartLineItem, Product } from "../lib/api.js";

beforeAll(() => {
  // Strip ANSI codes from chalk output so assertions stay simple.
  process.env.FORCE_COLOR = "0";
});

function makeProduct(over: Partial<Product> = {}): Product {
  return { id: "p1", name: "Milk 1L", ...over };
}

function makeLineItem(over: Partial<CartLineItem> = {}): CartLineItem {
  return {
    id: "li-abcdef12",
    productId: "p1",
    storeId: "s1",
    price: 2999,
    previousPrice: 2999,
    priceFactor: 100,
    quantity: 1,
    specialInstructions: "",
    replacementPreferenceId: "",
    selectedWeightRange: null,
    serviceOptionId: "sixty-min-delivery",
    product: makeProduct(),
    ...over,
  };
}

function makeCart(over: Partial<Cart> = {}): Cart {
  return {
    id: "cart-1",
    serviceOptionId: "sixty-min-delivery",
    maximumCartSize: 35,
    lineItems: [],
    lineItemTotals: {
      productTotal: 0,
      discountTotal: 0,
      cartTotalAfterDiscounts: 0,
    },
    ...over,
  };
}

describe("formatCents", () => {
  it("converts cents to Rand with two decimals", () => {
    expect(formatCents(2999)).toBe("R29.99");
    expect(formatCents(0)).toBe("R0.00");
    expect(formatCents(100)).toBe("R1.00");
    expect(formatCents(1)).toBe("R0.01");
  });

  it("handles a large total cleanly", () => {
    expect(formatCents(123456)).toBe("R1234.56");
  });

  it("returns R0.00 when value is missing or not finite", () => {
    expect(formatCents(undefined)).toBe("R0.00");
    expect(formatCents(null)).toBe("R0.00");
    expect(formatCents(Number.NaN)).toBe("R0.00");
    expect(formatCents(Number.POSITIVE_INFINITY)).toBe("R0.00");
  });
});

describe("formatLineItemName", () => {
  it("uses displayName when available", () => {
    const item = makeLineItem({
      product: makeProduct({ name: "Milk", displayName: "Full Cream Milk" }),
    });
    expect(formatLineItemName(item)).toContain("Full Cream Milk");
  });

  it("falls back to name when displayName is missing", () => {
    const item = makeLineItem({
      product: makeProduct({ name: "Bread 700g" }),
    });
    expect(formatLineItemName(item)).toContain("Bread 700g");
  });

  it("appends unitOfMeasure when present", () => {
    const item = makeLineItem({
      product: makeProduct({
        name: "Bananas",
        unitOfMeasure: "per kg",
      }),
    });
    expect(formatLineItemName(item)).toContain("Bananas");
    expect(formatLineItemName(item)).toContain("per kg");
  });

  it("falls back to 'Unknown' if no name fields", () => {
    const item = makeLineItem({ product: { id: "x" } as unknown as Product });
    expect(formatLineItemName(item)).toContain("Unknown");
  });
});

describe("isCartFull", () => {
  it("returns false when below the maximum", () => {
    const cart = makeCart({
      maximumCartSize: 35,
      lineItems: [makeLineItem(), makeLineItem({ id: "li-2" })],
    });
    expect(isCartFull(cart)).toBe(false);
  });

  it("returns true when at the maximum", () => {
    const lineItems: CartLineItem[] = Array.from({ length: 35 }, (_, i) =>
      makeLineItem({ id: `li-${i}` })
    );
    const cart = makeCart({ maximumCartSize: 35, lineItems });
    expect(isCartFull(cart)).toBe(true);
  });

  it("returns true when over the maximum", () => {
    const lineItems: CartLineItem[] = Array.from({ length: 36 }, (_, i) =>
      makeLineItem({ id: `li-${i}` })
    );
    const cart = makeCart({ maximumCartSize: 35, lineItems });
    expect(isCartFull(cart)).toBe(true);
  });

  it("returns false when no maximum is configured", () => {
    const cart = makeCart({
      maximumCartSize: undefined,
      lineItems: [makeLineItem()],
    });
    expect(isCartFull(cart)).toBe(false);
  });
});
