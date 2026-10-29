import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildCsyk } from './agent/claude.ts';
import { mean } from './harness/metrics.ts';

const usage = `Usage: npm run bench -- [--tier 5|10|20|30|50] [--only <tools>] [--setup csyk-lean] [--run <name>] [--skip questions|agents]

Measures a change at a chosen size: single questions on the twelve
repositories, then Claude Code on public issues in TypeScript, JavaScript,
Python and Go, with --setup and with Claude Code alone side by side. Tiers
nest: a tier's issues and questions are the first ones of every larger
tier, so going up a tier only runs what is new.

  --tier   questions of each kind per repository, and issues per language
           (default 5). While optimizing: 5, 10, 20, 30; for a release: 50.
  --only   the tools a change touches (find, grep, read, refs, calls,
           impact): single questions then cover only their kinds
  --setup  the agent setup to measure (default csyk-lean)
  --run    names this measurement: the setup and Claude Code alone both run
           fresh under it, side by side; use a new name for each version
  --skip   leave out the single questions or the agent sessions

Agent sessions are billed to your Claude account: about $0.05 an issue.`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kindsOf: Record<string, string[]> = { find: ['A', 'B'], read: ['A'], grep: ['E'], refs: ['C'], calls: ['D'], impact: ['G'] };
const benchmarks = [
  ['polybench', 'TypeScript'],
  ['polybench', 'JavaScript'],
  ['swebench', 'Python'],
  ['multiswebench', 'Go'],
] as const;

const { values } = parseArgs({
  options: {
    tier: { type: 'string', default: '5' },
    only: { type: 'string' },
    setup: { type: 'string', default: 'csyk-lean' },
    run: { type: 'string' },
    skip: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const tier = Number(values.tier);
if (values.help || !Number.isInteger(tier) || tier < 1) {
  console.log(usage);
  process.exit(0);
}
const tools = values.only?.split(',') ?? [];
const unknown = tools.filter((t) => !kindsOf[t]);
if (unknown.length > 0) throw new Error(`Unknown tool ${unknown.join(', ')}; known: ${Object.keys(kindsOf).join(', ')}`);
if (!existsSync(join(root, 'eval/corpora'))) throw new Error('Fetch the repositories first: npm run corpora');
const kinds = tools.length > 0 ? [...new Set(tools.flatMap((t) => kindsOf[t] ?? []))] : ['A', 'B', 'C', 'D', 'E', 'G'];

// Runs a node script of this repository, its output going to the console only when [loud].
function node(script: string, args: string[], env: Record<string, string> = {}, loud = false): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (loud) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`${script} exited with ${code}`))));
  });
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
type Score = { category: string; p1?: number; r5?: number; recall?: number; precision?: number; tokens: number };

if (values.skip !== 'questions') {
  console.log(`Single questions: kinds ${kinds.join(', ')}, ${tier} of each per repository`);
  const out = await node('eval/run.ts', ['--adapter', 'csyk', `--category=${kinds.join(',')}`, `--limit=${tier}`]);
  const path = /Scores written to (\S+)/.exec(out)?.[1];
  const run = JSON.parse(await readFile(join(root, path ?? ''), 'utf8')) as { results: Record<string, Score[]>; resources: Record<string, number> };
  console.log('| kind | score, mean over repositories | tokens |\n|---|---|---|');
  for (const kind of kinds) {
    const perRepo = Object.values(run.results).map((scores) => scores.filter((s) => s.category === kind)).filter((s) => s.length > 0);
    const field = (s: Score) => s.p1 ?? s.recall ?? 0;
    const score = mean(perRepo.map((s) => mean(s.map(field))));
    const extra = perRepo[0]?.[0]?.precision === undefined ? '' : ` found, ${pct(mean(perRepo.map((s) => mean(s.map((x) => x.precision ?? 0)))))} correct`;
    console.log(`| ${kind} | ${pct(score)}${extra} | ${Math.round(mean(perRepo.map((s) => mean(s.map((x) => x.tokens)))))} |`);
  }
  const r = run.resources;
  console.log(`Resources: ${r.toolCpuSeconds} s CPU, ${r.toolPeakMb} MB peak memory, ${r.wallSeconds} s\n`);
}

if (values.skip !== 'agents') {
  buildCsyk();
  console.log(`Agent sessions: ${tier} issues per language, ${values.setup} and Claude Code alone side by side`);
  const named = values.run ? ['--run', values.run] : [];
  for (const [dataset, language] of benchmarks) {
    const common = ['--dataset', dataset, '--language', language, '--count', String(tier), '--seed', '1'];
    // Claude Code alone runs again under the same name: its context changes
    // with Claude Code and with the plugins and skills of the machine, so a
    // baseline from another day is not comparable.
    await Promise.all([
      node('eval/loc/run.ts', [...common, '--setup', 'b0', ...named], { CSYK_LOC_DIR: join(root, 'eval/corpora/loc-b0') }),
      node('eval/loc/run.ts', [...common, '--setup', values.setup, ...named], { CSYK_LOC_DIR: join(root, `eval/corpora/loc-${values.setup}`) }),
    ]);
    console.log(`  ${language}: done`);
  }
  type Result = { id: string; tokens: number; nodeRecall?: number; fileAt1: number; peakMb?: number; cpuSeconds?: number; costUsd: number };
  type LocRun = { setup: string; dataset: string; language: string; sample?: string[]; results: Result[] };
  const files = (await readdir(join(root, 'eval/results'))).filter((n) => n.startsWith('loc-') && n.endsWith('.json'));
  const read = async (setup: string, dataset: string, language: string, run?: string) => {
    const name = `loc-${setup}-${dataset === 'polybench' ? language : `${dataset}-${language}`}-seed1${run ? `.${run}` : ''}.json`;
    return files.includes(name) ? (JSON.parse(await readFile(join(root, 'eval/results', name), 'utf8')) as LocRun) : undefined;
  };
  console.log(`| language | issues | tokens, against alone | changed functions named | first file right | peak memory | CPU | cost of the measured setup |\n|---|---|---|---|---|---|---|---|`);
  for (const [dataset, language] of benchmarks) {
    const [alone, measured] = [await read('b0', dataset, language, values.run), await read(values.setup, dataset, language, values.run)];
    if (!alone || !measured) continue;
    const ids = new Set((measured.sample ?? measured.results.map((r) => r.id)).slice(0, tier));
    const pairs = measured.results
      .filter((r) => ids.has(r.id))
      .flatMap((r) => {
        const base = alone.results.find((b) => b.id === r.id);
        return base ? [{ r, base }] : [];
      });
    const tokens = mean(pairs.map((p) => p.r.tokens)) / mean(pairs.map((p) => p.base.tokens)) - 1;
    const nodes = pairs.filter((p) => p.r.nodeRecall !== undefined && p.base.nodeRecall !== undefined);
    const functions = mean(nodes.map((p) => (p.r.nodeRecall ?? 0) - (p.base.nodeRecall ?? 0))) * 100;
    const file = mean(pairs.map((p) => p.r.fileAt1 - p.base.fileAt1)) * 100;
    console.log(
      `| ${language} | ${pairs.length} | ${tokens < 0 ? '−' : '+'}${pct(Math.abs(tokens))} | ${functions >= 0 ? '+' : ''}${functions.toFixed(1)} pts | ` +
        `${file >= 0 ? '+' : ''}${file.toFixed(1)} pts | ${Math.round(mean(pairs.map((p) => p.r.peakMb ?? 0)))} MB | ` +
        `${mean(pairs.map((p) => p.r.cpuSeconds ?? 0)).toFixed(1)} s | $${pairs.reduce((a, p) => a + p.r.costUsd, 0).toFixed(2)} |`,
    );
  }
}
