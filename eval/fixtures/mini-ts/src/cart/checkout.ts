import { calculateTax, calculateTotal } from './total.js';
import type { CartItem } from './types.js';

export type Receipt = { subtotal: number; tax: number; total: number };

export function checkout(items: CartItem[]): Receipt {
  if (items.length === 0) {
    throw new Error('Cart is empty');
  }
  const subtotal = calculateTotal(items);
  const tax = calculateTax(subtotal);
  return { subtotal, tax, total: subtotal + tax };
}
