import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { b0Ripgrep } from './adapters/b0-ripgrep.ts';
import { csyk } from './adapters/csyk.ts';
import { graphify } from './adapters/graphify.ts';
import { serena } from './adapters/serena.ts';
import { loadCaseFiles } from './harness/cases.ts';
import { assertPinned, loadCorpora } from './harness/corpora.ts';
import { scoreCase, summarize, type CaseScore } from './harness/metrics.ts';
import { renderTable } from './harness/report.ts';
import { watchResources } from './harness/resources.ts';
import { countTokens } from './harness/tokens.ts';
import type { Adapter, Case, Corpus } from './harness/types.ts';

const adapters: Record<string, () => Adapter> = { b0: () => b0Ripgrep, csyk, serena, graphify };

const usage = `Usage: npm run eval -- [--adapter b0|csyk|serena|graphify] [--corpus <name>] [--category <A-G>[,<A-G>…]]

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
  const adapter = adapters[values.adapter]?.();
  if (!adapter) {
    throw new Error(`Unknown adapter ${values.adapter}; known: ${Object.keys(adapters).join(', ')}`);
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const corpora = await loadCorpora(root);
  const files = (await loadCaseFiles(join(root, 'eval/cases'))).filter(
    (file) =>
      (!values.corpus || file.corpus === values.corpus) &&
      (!values.category || values.category.toUpperCase().split(',').includes(file.category)),
  );
  if (files.length === 0) throw new Error('No case files match.');

  const results: Record<string, CaseScore[]> = {};
  // Measured over the whole run, the adapter's servers and language servers
  // included; run one corpus per process to keep corpora apart. The
  // tokenizer is loaded first, so its memory is not counted for the tool.
  countTokens('');
  const watch = watchResources();
  const start = performance.now();
  const tables: string[] = [];
  try {
    for (const corpusName of [...new Set(files.map((file) => file.corpus))]) {
      const corpus = corpora.get(corpusName);
      if (!corpus) {
        throw new Error(`Corpus ${corpusName} is not in eval/corpora.yaml or corpora.local.yaml`);
      }
      assertPinned(corpus);
      const cases = files.filter((f) => f.corpus === corpusName).flatMap((f) => f.cases);
      const { scores, skipped } = await runCases(adapter, corpus, cases);
      results[corpusName] = scores;
      tables.push(renderTable(`${adapter.name} · ${corpusName}`, summarize(scores), skipped));
    }
  } finally {
    await adapter.close?.();
  }
  const used = await watch.stop();
  // A tool in this process is its growth here plus what it started, at the
  // same moment (its CPU includes the harness's own, a little more than the
  // tool's); a tool behind MCP is only what it started.
  const resources = {
    ...used,
    wallSeconds: Math.round((performance.now() - start) / 100) / 10,
    toolPeakMb: adapter.inProcess ? used.growthAndChildPeakMb : used.childPeakMb,
    toolCpuSeconds: adapter.inProcess ? used.cpuSeconds : used.childCpuSeconds,
  };

  console.log(tables.join('\n'));
  console.log(
    `Resources: ${resources.wallSeconds} s wall · the tool: ${resources.toolCpuSeconds} s CPU, ${resources.toolPeakMb} MB peak memory\n`,
  );
  const out = join(root, 'eval/results', `${adapter.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ adapter: adapter.name, resources, results }, null, 2)}\n`);
  console.log(`Scores written to ${out.slice(root.length + 1)}`);
}

/** Scores [adapter] on every case it answers; counts the ones it does not. */
async function runCases(
  adapter: Adapter,
  corpus: Corpus,
  cases: Case[],
): Promise<{ scores: CaseScore[]; skipped: number }> {
  const scores: CaseScore[] = [];
  let skipped = 0;
  for (const c of cases) {
    if (!adapter.supports(c)) {
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
  return { scores, skipped };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
