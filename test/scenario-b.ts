/**
 * Scenario B — Tier-2 demo: value-invariant bug
 * applyDiscount applies a percentage discount to a price.
 * A discountPercent > 100 would produce a negative price, which is a
 * business-logic violation — the type system cannot catch this.
 */

/**
 * Applies a percentage discount to a price.
 * @param price - The original price (must be positive)
 * @param discountPercent - Discount percentage (0–100)
 * @returns The discounted price
 */
function applyDiscount(price: number, discountPercent: number): number {
  if (discountPercent > 100) {
    throw new Error('Discount percentage cannot exceed 100%');
  }
  return price - (price * discountPercent) / 100;
}

export { applyDiscount };
