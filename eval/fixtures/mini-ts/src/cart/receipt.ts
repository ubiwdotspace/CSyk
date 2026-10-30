import { calculateTotal as sumOf } from './total.js';
import type { CartItem } from './types.js';

/** A receipt's last line: the total, to two decimals. */
export function receiptTotal(items: CartItem[]): string {
  return sumOf(items).toFixed(2);
}
