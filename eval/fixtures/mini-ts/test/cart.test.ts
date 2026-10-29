import { calculateTotal } from '../src/cart/total.js';

const items = [{ id: 'a', price: 2, quantity: 3 }];

if (calculateTotal(items) !== 6) {
  throw new Error('calculateTotal is off');
}
