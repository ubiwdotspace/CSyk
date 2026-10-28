import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { b0Ripgrep } from './adapters/b0-ripgrep.js';
import { loadCaseFiles } from './harness/cases.js';
import { loadCorpora } from './harness/corpora.js';
import { scoreCase, summarize, type CaseScore } from './harness/metrics.js';
import { renderTable } from './harness/report.js';
import { countTokens } from './harness/tokens.js';
import type { Adapter } from './harness/types.js';

const adapters: Record<string, Adapter> = { b0: b0Ripgrep };

const usage = `Usage: npm run eval -- [--adapter b0] [--corpus <name>] [--category <A-G>]

Runs the cases in eval/cases/ (and eval/cases/private/) through an adapter,
prints one table per corpus and writes every score to eval/results/.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      adapter: { type: 'string', default: 'b0' },
      corpus: { type: 'string' },
      category: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const adapter = adapters[values.adapter];
  if (!adapter) {
    throw new Error(`Unknown adapter ${values.adapter}; known: ${Object.keys(adapters).join(', ')}`);
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const corpora = await loadCorpora(root);
  const files = (await loadCaseFiles(join(root, 'eval/cases'))).filter(
    (file) =>
      (!values.corpus || file.corpus === values.corpus) &&
      (!values.category || file.category === values.category.toUpperCase()),
  );
  if (files.length === 0) throw new Error('No case files match.');

  const results: Record<string, CaseScore[]> = {};
  const tables: string[] = [];
  for (const corpusName of [...new Set(files.map((file) => file.corpus))]) {
    const corpus = corpora.get(corpusName);
    if (!corpus) {
      throw new Error(`Corpus ${corpusName} is not in eval/corpora.yaml or corpora.local.yaml`);
    }
    const scores: CaseScore[] = [];
    let skipped = 0;
    for (const file of files.filter((f) => f.corpus === corpusName)) {
      for (const c of file.cases) {
        if (!adapter.supports(c.category)) {
          skipped++;
          continue;
        }
        const start = performance.now();
        const result = await adapter.run(c, corpus);
        const ms = performance.now() - start;
        scores.push(
          scoreCase(c.id, c.category, result.hits, c.expect, {
            tokens: countTokens(result.output),
            calls: result.calls,
            ms,
          }),
        );
      }
    }
    results[corpusName] = scores;
    tables.push(renderTable(`${adapter.name} · ${corpusName}`, summarize(scores), skipped));
  }

  console.log(tables.join('\n'));
  const out = join(root, 'eval/results', `${adapter.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ adapter: adapter.name, results }, null, 2)}\n`);
  console.log(`Scores written to ${out.slice(root.length + 1)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
