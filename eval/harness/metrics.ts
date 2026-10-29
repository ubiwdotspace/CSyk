import { rankedCategories, type Category, type Hit, type Location } from './types.ts';

/** Whether [hit] lands on [loc]: the same file, inside its line range if any. */
export function matches(hit: Hit, loc: Location): boolean {
  if (hit.file !== loc.file) return false;
  return !loc.lines || (hit.line >= loc.lines[0] && hit.line <= loc.lines[1]);
}

/**
 * P@1: the top hit is an expected answer. R@5: the share of expected
 * answers found in the top five.
 */
export function scoreRanked(hits: Hit[], expect: Location[]): { p1: number; r5: number } {
  const top = hits[0];
  const p1 = top && expect.some((loc) => matches(top, loc)) ? 1 : 0;
  const five = hits.slice(0, 5);
  const found = expect.filter((loc) => five.some((hit) => matches(hit, loc))).length;
  return { p1, r5: found / expect.length };
}

/**
 * Recall: the share of expected answers among the hits. Precision: the
 * share of hits that are expected answers; no hits counts as zero.
 */
export function scoreSet(
  hits: Hit[],
  expect: Location[],
): { recall: number; precision: number } {
  const found = expect.filter((loc) => hits.some((hit) => matches(hit, loc))).length;
  const right = hits.filter((hit) => expect.some((loc) => matches(hit, loc))).length;
  return {
    recall: found / expect.length,
    precision: hits.length === 0 ? 0 : right / hits.length,
  };
}

export type CaseScore = {
  id: string;
  category: Category;
  p1?: number;
  r5?: number;
  recall?: number;
  precision?: number;
  tokens: number;
  calls: number;
  ms: number;
};

export function scoreCase(
  id: string,
  category: Category,
  hits: Hit[],
  expect: Location[],
  cost: { tokens: number; calls: number; ms: number },
): CaseScore {
  const quality = rankedCategories.has(category)
    ? scoreRanked(hits, expect)
    : scoreSet(hits, expect);
  return { id, category, ...quality, ...cost };
}

export type CategorySummary = {
  category: Category;
  cases: number;
  p1?: number;
  r5?: number;
  recall?: number;
  precision?: number;
  tokensMean: number;
  tokensP50: number;
  callsMean: number;
  msP50: number;
  msP95: number;
};

/** Averages the scores of each category, in category order. */
export function summarize(scores: CaseScore[]): CategorySummary[] {
  const byCategory = new Map<Category, CaseScore[]>();
  for (const score of scores) {
    byCategory.set(score.category, [...(byCategory.get(score.category) ?? []), score]);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, group]) => {
      const summary: CategorySummary = {
        category,
        cases: group.length,
        tokensMean: mean(group.map((s) => s.tokens)),
        tokensP50: percentile(group.map((s) => s.tokens), 50),
        callsMean: mean(group.map((s) => s.calls)),
        msP50: percentile(group.map((s) => s.ms), 50),
        msP95: percentile(group.map((s) => s.ms), 95),
      };
      for (const key of ['p1', 'r5', 'recall', 'precision'] as const) {
        const values = group.flatMap((s) => (s[key] === undefined ? [] : [s[key]]));
        if (values.length > 0) summary[key] = mean(values);
      }
      return summary;
    });
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank percentile; 0 for no values. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}
