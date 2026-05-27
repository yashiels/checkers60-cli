import { describe, it, expect, beforeAll } from "vitest";
import { formatRand, isProductId } from "../lib/format.js";
import { mapCatalogProduct, type RawCatalogProduct } from "../lib/api.js";
import { formatPrice, formatName } from "../commands/search.js";
import type { Product } from "../lib/api.js";

beforeAll(() => {
  // Strip ANSI codes from chalk output so assertions stay simple.
  process.env.FORCE_COLOR = "0";
});

describe("formatRand", () => {
  it("formats cents as Rand", () => {
    expect(formatRand(5999)).toBe("R59.99");
    expect(formatRand(0)).toBe("R0.00");
    expect(formatRand(100)).toBe("R1.00");
  });

  it("returns an em dash for missing values", () => {
    expect(formatRand(undefined)).toBe("—");
    expect(formatRand(null)).toBe("—");
    expect(formatRand(Number.NaN)).toBe("—");
  });
});

describe("isProductId", () => {
  it("recognises 24-char hex ObjectIds", () => {
    expect(isProductId("5d3b1d78e2f18700089552a8")).toBe(true);
    expect(isProductId("5D3B1D78E2F18700089552A8")).toBe(true);
  });

  it("rejects non-ids", () => {
    expect(isProductId("milk")).toBe(false);
    expect(isProductId("5d3b1d78")).toBe(false);
    expect(isProductId("5d3b1d78e2f18700089552a8z")).toBe(false);
  });
});

describe("mapCatalogProduct", () => {
  it("maps core fields and keeps prices in cents", () => {
    const raw: RawCatalogProduct = {
      id: "abc",
      name: "Full Cream Milk 1L",
      priceWithoutDecimal: 2199,
      priceFactor: 100,
      storeId: "store-1",
      stockOnHand: 12,
      active: true,
      ranged: true,
      storeProductActive: true,
    };
    const p = mapCatalogProduct(raw);
    expect(p.id).toBe("abc");
    expect(p.name).toBe("Full Cream Milk 1L");
    expect(p.price).toBe(2199);
    expect(p.stock).toBe(12);
    expect(p.active).toBe(true);
  });

  it("falls back to displayName when name is missing", () => {
    const p = mapCatalogProduct({ id: "x", displayName: "Eggs" });
    expect(p.name).toBe("Eggs");
  });

  it("treats a not-ranged product as inactive", () => {
    const p = mapCatalogProduct({
      id: "x",
      name: "Discontinued",
      active: true,
      ranged: false,
      storeProductActive: true,
    });
    expect(p.active).toBe(false);
  });

  it("passes through a promotions array", () => {
    const p = mapCatalogProduct({ id: "x", name: "Deal", promotions: [{ type: "save" }] });
    expect(Array.isArray(p.promotions)).toBe(true);
    expect(p.promotions).toHaveLength(1);
  });
});

describe("formatPrice", () => {
  it("formats a cents price as Rand", () => {
    const product: Product = { id: "x", name: "Item", price: 1250 };
    expect(formatPrice(product)).toBe("R12.50");
  });

  it("returns an em dash when the price is missing", () => {
    const product: Product = { id: "x", name: "Item" };
    expect(formatPrice(product)).toContain("—");
  });
});

describe("formatName", () => {
  it("returns the plain name when there are no promotions", () => {
    expect(formatName({ id: "x", name: "Bread" })).toBe("Bread");
  });

  it("tags products that carry a promotion", () => {
    const out = formatName({ id: "x", name: "Cheese", promotions: [{ type: "save" }] });
    expect(out).toContain("Cheese");
    expect(out).toContain("🏷️");
  });

  it("falls back to 'Unknown' for a nameless product", () => {
    expect(formatName({ id: "x", name: "" })).toBe("Unknown");
  });
});
