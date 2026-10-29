import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildCsyk, runClaude, setups, type ClaudeRun } from '../agent/claude.ts';
import { mean, percentile } from '../harness/metrics.ts';
import { seeded, shuffle } from '../oracle/sampling.ts';

const usage = `Usage: npm run loc -- --setup <b0|csyk> --language <TypeScript|JavaScript|Python|Java> [--count 10] [--seed 1] [--model sonnet] [--max-turns 40]

Code localization on SWE-PolyBench Verified (Amazon, MIT): for each sampled
issue, checked out at its base commit, headless Claude Code is asked which
files and functions must change, without editing. Its answer is scored
against the files and functions the real fix changed. Records time, tokens,
cost and accuracy; each run is billed to your Claude account.`;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dataset = 'AmazonScience/SWE-PolyBench_Verified';

type Instance = {
  instance_id: string;
  repo: string;
  base_commit: string;
  patch: string;
  problem_statement: string;
  language: string;
  modified_nodes: string;
};

type Score = { fileAt1: number; fileAt5: number; fileRecall5: number; nodeRecall?: number };
type Result = Omit<ClaudeRun, 'answer'> & Score & { id: string; files: string[]; functions: string[] };

const prompt = (issue: string) =>
  [
    'This issue was reported for the repository in the current folder:',
    '',
    '<issue>',
    issue.trim(),
    '</issue>',
    '',
    'Find where the code must change to resolve it. Do not edit any file. Rank the files most likely',
    'to need changes, and name the functions or methods in them to change. End your answer with one',
    'JSON object on its own line, with repository-relative paths:',
    '{"files": ["path/a.ts", "path/b.ts"], "functions": ["path/a.ts:ClassName.method", "path/b.ts:functionName"]}',
  ].join('\n');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      setup: { type: 'string' },
      language: { type: 'string' },
      count: { type: 'string', default: '10' },
      seed: { type: 'string', default: '1' },
      model: { type: 'string', default: 'sonnet' },
      'max-turns': { type: 'string', default: '40' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.setup || !values.language || !['b0', 'csyk'].includes(values.setup)) {
    console.log(usage);
    return;
  }
  const all = (await instances()).filter((i) => i.language === values.language);
  const sample = shuffle(all, seeded(Number(values.seed))).slice(0, Number(values.count));
  if (values.setup === 'csyk') buildCsyk();
  const results: Result[] = [];
  for (const instance of sample) {
    const repo = await checkout(instance);
    const setup = setups(repo)[values.setup];
    if (!setup) throw new Error(`no setup ${values.setup}`);
    const { answer, ...cost } = await runClaude(prompt(instance.problem_statement), repo, setup, values.model, values['max-turns']);
    const { files, functions } = parseAnswer(answer, repo);
    const score = scoreAnswer(instance, files, functions);
    results.push({ id: instance.instance_id, files, functions, ...score, ...cost });
    console.log(
      `${instance.instance_id}: file@1 ${score.fileAt1} · file@5 ${score.fileAt5} · functions ${score.nodeRecall?.toFixed(2) ?? '–'} · ` +
        `${cost.tokens} tokens · ${cost.calls} calls · ${Math.round(cost.ms / 1000)} s · $${cost.costUsd.toFixed(3)}`,
    );
  }
  const nodes = results.flatMap((r) => (r.nodeRecall === undefined ? [] : [r.nodeRecall]));
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(
    `\n${values.setup} · ${values.language} · ${results.length} issues · ${values.model}: ` +
      `file Acc@1 ${pct(mean(results.map((r) => r.fileAt1)))} · file Acc@5 ${pct(mean(results.map((r) => r.fileAt5)))} · ` +
      `file recall@5 ${pct(mean(results.map((r) => r.fileRecall5)))} · function recall ${nodes.length ? pct(mean(nodes)) : '–'} · ` +
      `tokens mean ${Math.round(mean(results.map((r) => r.tokens)))} · calls mean ${mean(results.map((r) => r.calls)).toFixed(1)} · ` +
      `wall p50 ${Math.round(percentile(results.map((r) => r.ms), 50) / 1000)} s · cost $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}`,
  );
  const out = join(root, 'eval/results', `loc-${values.setup}-${values.language}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ setup: values.setup, language: values.language, model: values.model, seed: values.seed, results }, null, 2)}\n`);
  console.log(`Results written to ${out.slice(root.length + 1)}`);
}

// The dataset's rows, fetched once from the Hugging Face datasets server and kept in eval/results/.
async function instances(): Promise<Instance[]> {
  const cache = join(root, 'eval/results/loc-cache/swe-polybench-verified.json');
  if (existsSync(cache)) return JSON.parse(await readFile(cache, 'utf8')) as Instance[];
  const rows: Instance[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=test&offset=${offset}&length=100`;
    const page = (await (await fetch(url)).json()) as { rows?: { row: Instance }[] };
    if (!page.rows?.length) break;
    rows.push(...page.rows.map((r) => r.row));
  }
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify(rows));
  return rows;
}

// The instance's repository at its base commit, fetched without history into eval/corpora/loc/.
async function checkout(instance: Instance): Promise<string> {
  const dir = join(root, 'eval/corpora/loc', instance.repo.replace('/', '__'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dir, { recursive: true });
    git('init', '-q');
    git('remote', 'add', 'origin', `https://github.com/${instance.repo}.git`);
  }
  git('fetch', '-q', '--depth', '1', 'origin', instance.base_commit);
  git('checkout', '-q', '-f', 'FETCH_HEAD');
  git('clean', '-q', '-fd');
  return dir;
}

// The files and functions in the answer's last JSON object, paths made repo-relative.
export function parseAnswer(answer: string, repo: string): { files: string[]; functions: string[] } {
  const objects = answer.match(/\{[^{}]*"files"[^{}]*\}/g) ?? [];
  const last = objects.at(-1);
  if (!last) return { files: [], functions: [] };
  try {
    const parsed = JSON.parse(last) as { files?: unknown; functions?: unknown };
    const clean = (p: unknown) => String(p).replace(`${repo}/`, '').replace(/^\.\//, '');
    return {
      files: Array.isArray(parsed.files) ? parsed.files.map(clean) : [],
      functions: Array.isArray(parsed.functions) ? parsed.functions.map(clean) : [],
    };
  } catch {
    return { files: [], functions: [] };
  }
}

/**
 * Scores an answer against the fix: file Acc@1 (the top file was changed),
 * file Acc@5 (every changed file is in the top five), file recall@5, and the
 * share of changed functions, methods and classes named (same file, same
 * name), as LocAgent and Agentless report them.
 */
export function scoreAnswer(instance: Pick<Instance, 'patch' | 'modified_nodes'>, files: string[], functions: string[]): Score {
  const gold = [...new Set([...instance.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? ''))];
  const top5 = files.slice(0, 5);
  const found = gold.filter((f) => top5.includes(f)).length;
  const score: Score = {
    fileAt1: files[0] && gold.includes(files[0]) ? 1 : 0,
    fileAt5: gold.length > 0 && found === gold.length ? 1 : 0,
    fileRecall5: gold.length > 0 ? found / gold.length : 0,
  };
  const nodes = (JSON.parse(instance.modified_nodes || '[]') as string[]).map((node) => {
    const parts = node.split('->');
    return { file: parts[0] ?? '', name: (parts.at(-1) ?? '').split(':').at(-1) ?? '' };
  });
  if (nodes.length === 0) return score;
  const named = functions.map((f) => {
    const at = f.lastIndexOf(':');
    return { file: f.slice(0, at), name: f.slice(at + 1).split('.').at(-1) ?? '' };
  });
  const hit = nodes.filter((n) => named.some((m) => m.file === n.file && m.name === n.name)).length;
  return { ...score, nodeRecall: hit / nodes.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
