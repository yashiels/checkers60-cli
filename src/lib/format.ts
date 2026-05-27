/**
 * Format a price given in cents (the API's `priceWithoutDecimal` unit) as a
 * Rand string, e.g. 5999 → "R59.99".
 */
export function formatRand(cents: number | undefined | null): string {
  if (cents === undefined || cents === null || Number.isNaN(cents)) return "—";
  return `R${(cents / 100).toFixed(2)}`;
}

/** True if the argument looks like a 24-char hex MongoDB ObjectId. */
export function isProductId(value: string): boolean {
  return /^[a-f0-9]{24}$/i.test(value);
}
