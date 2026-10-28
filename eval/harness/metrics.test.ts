import { describe, expect, it } from 'vitest';
import { matches, percentile, scoreRanked, scoreSet, summarize } from './metrics.js';

const total = { file: 'src/total.ts', lines: [4, 6] as [number, number] };

describe('matches', () => {
  it('needs the same file and a line inside the range', () => {
    expect(matches({ file: 'src/total.ts', line: 5 }, total)).toBe(true);
    expect(matches({ file: 'src/total.ts', line: 7 }, total)).toBe(false);
    expect(matches({ file: 'src/other.ts', line: 5 }, total)).toBe(false);
  });

  it('takes any line when no range is given', () => {
    expect(matches({ file: 'src/total.ts', line: 99 }, { file: 'src/total.ts' })).toBe(true);
  });
});

describe('scoreRanked', () => {
  it('scores P@1 on the top hit and R@5 on the top five', () => {
    const hits = [
      { file: 'src/import.ts', line: 1 },
      { file: 'src/total.ts', line: 4 },
    ];
    expect(scoreRanked(hits, [total])).toEqual({ p1: 0, r5: 1 });
    expect(scoreRanked(hits.slice(1), [total])).toEqual({ p1: 1, r5: 1 });
  });

  it('misses an answer ranked sixth', () => {
    const noise = Array.from({ length: 5 }, (_, i) => ({ file: 'x.ts', line: i + 1 }));
    expect(scoreRanked([...noise, { file: 'src/total.ts', line: 4 }], [total]).r5).toBe(0);
  });
});

describe('scoreSet', () => {
  it('scores recall on the expected and precision on the hits', () => {
    const expect_ = [
      { file: 'a.ts', lines: [1, 1] as [number, number] },
      { file: 'b.ts', lines: [2, 2] as [number, number] },
    ];
    const hits = [
      { file: 'a.ts', line: 1 },
      { file: 'a.ts', line: 9 },
    ];
    expect(scoreSet(hits, expect_)).toEqual({ recall: 0.5, precision: 0.5 });
    expect(scoreSet([], expect_)).toEqual({ recall: 0, precision: 0 });
  });
});

describe('summarize', () => {
  it('averages each category and leaves metrics it does not use unset', () => {
    const cost = { tokens: 10, calls: 1, ms: 5 };
    const [a, c] = summarize([
      { id: 'C1', category: 'C', recall: 1, precision: 0.5, ...cost },
      { id: 'A1', category: 'A', p1: 1, r5: 1, ...cost },
      { id: 'A2', category: 'A', p1: 0, r5: 1, ...cost, tokens: 30 },
    ]);
    expect(a).toMatchObject({ category: 'A', cases: 2, p1: 0.5, r5: 1, tokensMean: 20 });
    expect(a?.recall).toBeUndefined();
    expect(c).toMatchObject({ category: 'C', cases: 1, recall: 1, precision: 0.5 });
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});
