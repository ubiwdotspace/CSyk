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

  it('shows as many rows as fit and says how to narrow', () => {
    const fitted = fit('40 symbols', rows, { budget: 200, narrow: 'pass path' });
    expect(fitted.shown).toBe(14);
    expect(fitted.text).toMatch(/… 26 more; pass path$/);
    expect(estimateTokens(fitted.text)).toBeLessThanOrEqual(200);
    // One row more would not fit.
    expect(estimateTokens([fitted.text.split('\n').slice(0, 15).join('\n'), rows[14], '… 25 more; pass path'].join('\n'))).toBeGreaterThan(200);
  });

  it('falls back to compact rows, then to the count alone', () => {
    expect(fit('40 symbols', rows, { budget: 40, narrow: 'pass path', compact }).text).toContain('src/file-0.ts#symbol0\n');
    const counts = fit('40 symbols', rows, { budget: 5, narrow: 'pass path' });
    expect(counts).toMatchObject({ shown: 0, truncated: true });
    expect(counts.text).toBe('40 symbols\n… 40 not shown within the budget; pass path');
  });

  it('shows every compact row before fewer full rows', () => {
    const fitted = fit('40 symbols', rows, { budget: 300, narrow: 'pass path', compact });
    expect(fitted).toMatchObject({ shown: 40, truncated: false });
    expect(fitted.text).toContain('src/file-39.ts#symbol39');
  });

  it('counts results beyond the rows it was given', () => {
    expect(fit('9 refs', rows.slice(0, 2), { budget: 2000, narrow: 'raise limit', total: 9 }).text).toMatch(/… 7 more; raise limit$/);
  });
});
