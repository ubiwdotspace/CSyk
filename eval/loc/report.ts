import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, percentile } from '../harness/metrics.ts';

/**
 * `npm run loc:report`: one table from the localization runs in
 * eval/results/, per dataset and language, over the issues both setups ran:
 * accuracy, time, tokens (all of them, and those the tools returned, with
 * the change against B0), tool calls and cost.
 */
type Result = {
  id: string;
  fileAt1: number;
  fileAt5: number;
  nodeRecall?: number;
  tokens: number;
  toolTokens?: number;
  peakContext?: number;
  calls: number;
  errors?: number;
  ms: number;
  costUsd: number;
  peakMb?: number;
  cpuSeconds?: number;
};
type Run = { setup: string; dataset?: string; language: string; results: Result[] };

const names: Record<string, string> = { polybench: 'SWE-PolyBench Verified', swebench: 'SWE-bench Verified', multiswebench: 'Multi-SWE-bench mini' };
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = join(root, 'eval/results');
const runs = new Map<string, Run>();
for (const name of (await readdir(dir)).filter((n) => /^loc-[\w-]+-seed\d+\.json$/.test(n)).sort()) {
  const run = JSON.parse(await readFile(join(dir, name), 'utf8')) as Run;
  runs.set(`${run.setup}:${run.dataset ?? 'polybench'}:${run.language}`, run);
}
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const change = (value: number, base: number) => ` (${value <= base ? '−' : '+'}${pct(Math.abs(1 - value / base))})`;
const labels: Record<string, string> = {
  b0: 'B0',
  csyk: 'CSyk',
  'csyk-nohooks': 'CSyk, no hooks',
  'csyk-lean': 'CSyk lean',
  serena: 'Serena',
  graphify: 'Graphify',
};
// Mean peak memory and CPU time of Claude Code and its servers, where recorded.
const resourceCell = (rs: Result[]) => {
  const known = rs.filter((r) => r.peakMb);
  if (known.length === 0) return '– | –';
  return `${Math.round(mean(known.map((r) => r.peakMb ?? 0)))} MB | ${mean(known.map((r) => r.cpuSeconds ?? 0)).toFixed(1)} s`;
};
console.log(
  '| benchmark | language | setup | issues | file Acc@1 | file Acc@5 | function recall | time p50 / mean | tokens | tokens from tools | peak context | tool calls | peak memory | CPU | cost |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
// Peak context, compared with B0 on issues where both recorded it.
let peakBase = 0;
function peakCell(run: Run, rs: Result[]): string {
  const known = rs.filter((r) => r.peakContext !== undefined);
  if (known.length === 0) return '–';
  const value = mean(known.map((r) => r.peakContext ?? 0));
  if (run.setup === 'b0') {
    peakBase = value;
    return Math.round(value).toLocaleString('en');
  }
  return `${Math.round(value).toLocaleString('en')}${peakBase ? change(value, peakBase) : ''}`;
}

const keys = [...new Set([...runs.values()].map((r) => `${r.dataset ?? 'polybench'}:${r.language}`))];
for (const key of keys) {
  const b0 = runs.get(`b0:${key}`);
  if (!b0) continue;
  const others = [...runs.entries()].filter(([k]) => k.endsWith(`:${key}`) && !k.startsWith('b0:')).map(([, run]) => run);
  for (const other of others) {
    const shared = (r: Result) => b0.results.some((x) => x.id === r.id) && other.results.some((x) => x.id === r.id);
    // Tool tokens are compared on issues where both runs recorded them.
    const bothTool = (r: Result) => [b0, other].every((run) => run.results.find((x) => x.id === r.id)?.toolTokens !== undefined);
    const baseTokens = mean(b0.results.filter(shared).map((r) => r.tokens));
    const baseTool = mean(b0.results.filter((r) => shared(r) && bothTool(r)).map((r) => r.toolTokens ?? 0));
    for (const run of [b0, other]) {
      const rs = run.results.filter(shared);
      const nodes = rs.flatMap((r) => (r.nodeRecall === undefined ? [] : [r.nodeRecall]));
      const tokens = mean(rs.map((r) => r.tokens));
      const toolRs = rs.filter(bothTool);
      const tool = mean(toolRs.map((r) => r.toolTokens ?? 0));
      const [dataset, language] = key.split(':');
      console.log(
        `| ${names[dataset ?? ''] ?? dataset} | ${language} | ${labels[run.setup] ?? run.setup} | ${rs.length} | ` +
          `${pct(mean(rs.map((r) => r.fileAt1)))} | ${pct(mean(rs.map((r) => r.fileAt5)))} | ${nodes.length ? pct(mean(nodes)) : '–'} | ` +
          `${Math.round(percentile(rs.map((r) => r.ms), 50) / 1000)} s / ${Math.round(mean(rs.map((r) => r.ms)) / 1000)} s | ` +
          `${Math.round(tokens).toLocaleString('en')}${run !== b0 ? change(tokens, baseTokens) : ''} | ` +
          `${toolRs.length ? `${Math.round(tool).toLocaleString('en')}${run !== b0 ? change(tool, baseTool) : ''}` : '–'} | ` +
          `${peakCell(run, rs)} | ${mean(rs.map((r) => r.calls)).toFixed(1)} | ${resourceCell(rs)} | ` +
          `$${rs.reduce((a, r) => a + r.costUsd, 0).toFixed(2)} |`,
      );
    }
  }
}
