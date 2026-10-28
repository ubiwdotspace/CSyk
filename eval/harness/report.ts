import type { CategorySummary } from './metrics.js';

const percent = (value?: number) =>
  value === undefined ? '–' : `${(value * 100).toFixed(1)}%`;

/** One Markdown table of the category summaries for an adapter and corpus. */
export function renderTable(
  title: string,
  summaries: CategorySummary[],
  skipped: number,
): string {
  const rows = summaries.map((s) =>
    [
      s.category,
      s.cases,
      percent(s.p1),
      percent(s.r5),
      percent(s.recall),
      percent(s.precision),
      Math.round(s.tokensMean),
      Math.round(s.tokensP50),
      s.callsMean.toFixed(1),
      Math.round(s.msP50),
      Math.round(s.msP95),
    ].join(' | '),
  );
  return [
    `### ${title}`,
    '',
    '| cat | cases | P@1 | R@5 | recall | precision | tokens mean | tokens p50 | calls | ms p50 | ms p95 |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
    ...(skipped > 0 ? ['', `${skipped} case(s) skipped: the adapter does not answer their category.`] : []),
    '',
  ].join('\n');
}
