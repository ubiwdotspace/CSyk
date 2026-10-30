import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaseScore } from './harness/metrics.ts';

/**
 * `npm run gate [-- --write]`: holds the newest eval run's scores, per corpus
 * and kind of question, to eval/gate.json, and fails when one fell by more
 * than a point (a share, so 0.01): CI runs it on a few TypeScript and
 * JavaScript corpora. With --write, the run becomes the new baseline.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = join(root, 'eval/results');
const newest = readdirSync(results).filter((n) => /^csyk-.*\.json$/.test(n)).sort().at(-1);
if (!newest) throw new Error('no eval run in eval/results; run npm run eval first');
const run = JSON.parse(readFileSync(join(results, newest), 'utf8')) as { results: Record<string, CaseScore[]> };

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
// What each kind is judged by: the first answer for names, the first five for
// messages, what is found and what is right for the rest.
const measures: Record<string, (keyof CaseScore)[]> = { A: ['p1'], B: ['p1'], E: ['r5'] };
const scores: Record<string, number> = {};
for (const [corpus, cases] of Object.entries(run.results)) {
  for (const kind of [...new Set(cases.map((c) => c.category))].sort()) {
    const of = cases.filter((c) => c.category === kind);
    for (const measure of measures[kind] ?? ['recall', 'precision']) {
      scores[`${corpus} ${kind} ${measure}`] = Math.round(mean(of.map((c) => Number(c[measure] ?? 0))) * 1000) / 1000;
    }
  }
}

const path = join(root, 'eval/gate.json');
if (process.argv.includes('--write')) {
  writeFileSync(path, `${JSON.stringify(scores, null, 2)}\n`);
  console.log(`${Object.keys(scores).length} scores written to eval/gate.json from ${newest}`);
} else {
  const baseline = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
  const drops = Object.entries(baseline).flatMap(([key, was]) => {
    const now = scores[key];
    return now === undefined ? [`${key}: not run`] : now < was - 0.01 ? [`${key}: ${was} → ${now}`] : [];
  });
  console.log(`${Object.keys(baseline).length} scores checked against eval/gate.json (${newest})`);
  if (drops.length > 0) {
    console.error(`Fell by more than a point:\n  ${drops.join('\n  ')}`);
    process.exitCode = 1;
  }
}
