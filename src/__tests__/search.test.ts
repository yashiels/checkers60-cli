import { describe, it, expect, beforeAll } from "vitest";
import { extractProducts, formatPrice } from "../commands/search.js";
import type { Product, SearchResult } from "../lib/api.js";

beforeAll(() => {
  // Strip ANSI codes from chalk output so assertions stay simple.
  process.env.FORCE_COLOR = "0";
});

describe("extractProducts", () => {
  it("returns products from the top-level `products` array", () => {
    const result: SearchResult = {
      products: [{ id: "1", name: "Milk", price: 25.99 }],
      totalCount: 1,
    };
    const products = extractProducts(result);
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Milk");
  });

  it("falls back to `items` array", () => {
    const result = {
      items: [{ id: "2", name: "Bread", price: 18.5 }],
    } as unknown as SearchResult;
    const products = extractProducts(result);
    expect(products).toHaveLength(1);
    expect(products[0].id).toBe("2");
  });

  it("falls back to nested data.products", () => {
    const result = {
      data: { products: [{ id: "3", name: "Eggs", price: 45 }] },
    } as unknown as SearchResult;
    const products = extractProducts(result);
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Eggs");
  });

  it("walks one level deep to find an array of named objects", () => {
    const result = {
      catalogueResults: [{ id: "4", name: "Butter" }],
    } as unknown as SearchResult;
    const products = extractProducts(result);
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Butter");
  });

  it("returns empty array when no products are found", () => {
    expect(extractProducts({} as SearchResult)).toEqual([]);
    expect(extractProducts({ foo: "bar" } as unknown as SearchResult)).toEqual([]);
  });

  it("ignores arrays whose elements are not products", () => {
    const result = { tags: ["sale", "new"] } as unknown as SearchResult;
    expect(extractProducts(result)).toEqual([]);
  });
});

describe("formatPrice", () => {
  it("formats a plain price with no discount", () => {
    const product: Product = { id: "x", name: "Item", price: 12.5 };
    expect(formatPrice(product)).toBe("R12.50");
  });

  it("shows discount when originalPrice is higher than price", () => {
    const product: Product = {
      id: "x",
      name: "Item",
      price: 10,
      originalPrice: 15,
    };
    const out = formatPrice(product);
    expect(out).toContain("R10.00");
    expect(out).toContain("R15.00");
  });

  it("does not show original price when it is not higher", () => {
    const product: Product = {
      id: "x",
      name: "Item",
      price: 10,
      originalPrice: 10,
    };
    expect(formatPrice(product)).toBe("R10.00");
  });

  it("returns an em dash when the price is missing", () => {
    const product = { id: "x", name: "Item" } as Product;
    expect(formatPrice(product)).toContain("—");
  });

  it("falls back to sellingPrice when price is missing", () => {
    const product = {
      id: "x",
      name: "Item",
      sellingPrice: 9.99,
    } as unknown as Product;
    expect(formatPrice(product)).toBe("R9.99");
  });

  it("recognises wasPrice as the original price", () => {
    const product = {
      id: "x",
      name: "Item",
      price: 8,
      wasPrice: 12,
    } as unknown as Product;
    const out = formatPrice(product);
    expect(out).toContain("R8.00");
    expect(out).toContain("R12.00");
  });
});
