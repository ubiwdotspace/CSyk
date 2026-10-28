import { describe, expect, it } from 'vitest';
import { answers, fuzzyQuery, seeded, shuffle, splitWords } from './sampling.ts';

describe('splitWords', () => {
  it('splits camel, Pascal, acronyms, snake and kebab case', () => {
    expect(splitWords('parseHTTPResponse')).toEqual(['parse', 'HTTP', 'Response']);
    expect(splitWords('TokenStore')).toEqual(['Token', 'Store']);
    expect(splitWords('MAX_RETRY_COUNT')).toEqual(['MAX', 'RETRY', 'COUNT']);
    expect(splitWords('use-cart-total')).toEqual(['use', 'cart', 'total']);
  });
});

describe('fuzzyQuery', () => {
  it('blurs a name in one of its styles, never into itself', () => {
    const random = seeded(7);
    const styles = new Set(Array.from({ length: 30 }, () => fuzzyQuery('calculateShippingCost', random)));
    expect(styles).toEqual(new Set(['calculate shipping cost', 'calcShippingCost', 'ShippingCost']));
  });

  it('only lowers SCREAMING_CASE into words', () => {
    expect(fuzzyQuery('AUTOSAVE_RESET_MS', seeded(2))).toBe('autosave reset ms');
  });

  it('leaves one-word and too-short names alone', () => {
    expect(fuzzyQuery('checkout', seeded(1))).toBeUndefined();
    expect(fuzzyQuery('totalN', seeded(1))).toBeUndefined();
  });
});

describe('seeded shuffle', () => {
  it('repeats for the same seed', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(items, seeded(3))).toEqual(shuffle(items, seeded(3)));
    expect(shuffle(items, seeded(3))).not.toEqual(shuffle(items, seeded(4)));
    expect([...shuffle(items, seeded(3))].sort((a, b) => a - b)).toEqual(items);
  });
});

describe('answers', () => {
  it('matches squashed names and word prefixes in order', () => {
    expect(answers('token store', 'TokenStore')).toBe(true);
    expect(answers('calcTotal', 'calculateTotal')).toBe(true);
    expect(answers('ToObject', 'arrayToObject')).toBe(true);
    expect(answers('total calc', 'calculateTotal')).toBe(false);
    expect(answers('calcTotal', 'calculateTax')).toBe(false);
  });
});

