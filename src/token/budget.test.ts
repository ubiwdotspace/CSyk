import { describe, expect, it } from 'vitest';
import { estimateTokens, fit } from './budget.ts';

const rows = Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts#symbol${i}  function ${i}  (a, b) => number`);
const compact = rows.map((_, i) => `src/file-${i}.ts#symbol${i}`);

describe('fit', () => {
  it('shows everything that fits', () => {
    const fitted = fit('3 symbols', rows.slice(0, 3), { budget: 2000, narrow: 'pass path' });
    expect(fitted).toMatchObject({ shown: 3, truncated: false });
    expect(fitted.text.split('\n')).toHaveLength(4);
  });

  it('cuts rows step by step and says how to narrow', () => {
    const fitted = fit('40 symbols', rows, { budget: 200, narrow: 'pass path' });
    expect(fitted.shown).toBe(10);
    expect(fitted.text).toMatch(/… 30 more; pass path$/);
    expect(estimateTokens(fitted.text)).toBeLessThanOrEqual(200);
  });

  it('falls back to compact rows, then to the count alone', () => {
    expect(fit('40 symbols', rows, { budget: 40, narrow: 'pass path', compact }).text).toContain('src/file-0.ts#symbol0\n');
    const counts = fit('40 symbols', rows, { budget: 5, narrow: 'pass path' });
    expect(counts).toMatchObject({ shown: 0, truncated: true });
    expect(counts.text).toBe('40 symbols\n… 40 not shown within the budget; pass path');
  });

  it('counts results beyond the rows it was given', () => {
    expect(fit('9 refs', rows.slice(0, 2), { budget: 2000, narrow: 'raise limit', total: 9 }).text).toMatch(/… 7 more; raise limit$/);
  });
});
