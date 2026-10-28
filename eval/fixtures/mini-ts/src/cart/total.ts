import type { CartItem } from './types.js';

/** Sums item prices, applying each item's quantity. */
export function calculateTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/** Tax on a total, rounded to cents. */
export function calculateTax(total: number, rate = 0.1): number {
  return Math.round(total * rate * 100) / 100;
}
