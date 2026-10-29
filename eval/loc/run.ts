import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { extractSymbols } from '../../src/index/parse.ts';
import { buildCsyk, runClaude, setups, type ClaudeRun } from '../agent/claude.ts';
import { mean, percentile } from '../harness/metrics.ts';
import { seeded, shuffle } from '../oracle/sampling.ts';

const usage = `Usage: npm run loc -- --setup <b0|csyk|csyk-lean|csyk-nohooks|serena|graphify> --language <name> [--dataset polybench|swebench|multiswebench] [--count 10] [--seed 1] [--run <name>] [--model sonnet] [--max-turns 40]

Code localization on public issue benchmarks: for each issue, sampled at
random from the whole dataset (no filter on difficulty) and checked out at its
base commit, headless Claude Code is asked which files and functions must
change, without editing. Its answer is scored against the files and functions
the real fix changed. Records time, tokens, cost and accuracy; each run is
billed to your Claude account.

  polybench       SWE-PolyBench Verified (Amazon, MIT): TypeScript, JavaScript, Python, Java
  swebench        SWE-bench Verified (Princeton and OpenAI, MIT): Python
  multiswebench   Multi-SWE-bench mini (ByteDance, CC0): Go, TypeScript, JavaScript, Python, Java, Rust, C, C++`;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** One issue, in the same shape whatever the dataset. */
type Instance = {
  instance_id: string;
  repo: string;
  base_commit: string;
  patch: string;
  problem_statement: string;
  language: string;
  /** SWE-PolyBench's changed functions and classes, as `file->…->kind:name`. */
  modified_nodes?: string;
  difficulty?: string;
};

/** What the real fix changed. */
type Gold = { files: string[]; nodes: { file: string; name: string }[] };
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
      dataset: { type: 'string', default: 'polybench' },
      count: { type: 'string', default: '10' },
      seed: { type: 'string', default: '1' },
      run: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      'max-turns': { type: 'string', default: '40' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const load = loaders[values.dataset];
  if (values.help || !values.setup || !values.language || !load || !(values.setup in setups('.'))) {
    console.log(usage);
    return;
  }
  const all = (await load()).filter((i) => i.language === values.language);
  const sample = shuffle(all, seeded(Number(values.seed))).slice(0, Number(values.count));
  console.log(`${values.dataset} ${values.language}: ${sample.length} of ${all.length} issues, seed ${values.seed}`);
  console.log(`  repositories: ${tally(sample, (i) => i.repo)} (dataset: ${tally(all, (i) => i.repo)})`);
  if (all.some((i) => i.difficulty)) console.log(`  difficulty: ${tally(sample, (i) => i.difficulty ?? '?')} (dataset: ${tally(all, (i) => i.difficulty ?? '?')})`);
  if (values.setup === 'csyk') buildCsyk();
  // One file per setup, dataset, language and seed, written after every issue:
  // a run that stops resumes where it was, without paying for an issue twice.
  const name = values.dataset === 'polybench' ? values.language : `${values.dataset}-${values.language}`;
  // --run names a repeat of the same setup, so runs side by side keep their own results.
  const out = join(root, 'eval/results', `loc-${values.setup}-${name}-seed${values.seed}${values.run ? `.${values.run}` : ''}.json`);
  const results: Result[] = existsSync(out) ? (JSON.parse(await readFile(out, 'utf8')) as { results: Result[] }).results : [];
  const save = () =>
    writeFile(
      out,
      `${JSON.stringify({ setup: values.setup, dataset: values.dataset, language: values.language, model: values.model, seed: values.seed, results }, null, 2)}\n`,
    );
  await mkdir(dirname(out), { recursive: true });
  for (const instance of sample) {
    if (results.some((r) => r.id === instance.instance_id)) continue;
    // An issue whose repository cannot be fetched is left for the next run, not the end of this one.
    const repo = await checkout(instance).catch((error: unknown) => {
      console.log(`${instance.instance_id}: skipped, checkout failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
      return undefined;
    });
    if (!repo) continue;
    const gold = await goldOf(instance, repo);
    const setup = setups(repo)[values.setup];
    if (!setup) throw new Error(`no setup ${values.setup}`);
    await setup.prepare?.();
    const { answer, ...cost } = await runClaude(prompt(instance.problem_statement), repo, setup, values.model, values['max-turns']);
    const { files, functions } = parseAnswer(answer, repo);
    const score = scoreAnswer(gold, files, functions);
    results.push({ id: instance.instance_id, files, functions, ...score, ...cost });
    await save();
    console.log(
      `${instance.instance_id}: file@1 ${score.fileAt1} · file@5 ${score.fileAt5} · functions ${score.nodeRecall?.toFixed(2) ?? '–'} · ` +
        `${cost.tokens} tokens (${cost.toolTokens} from tools) · ${cost.calls} calls · ${Math.round(cost.ms / 1000)} s · ` +
        `${cost.peakMb} MB peak · ${cost.cpuSeconds} s CPU · $${cost.costUsd.toFixed(3)}`,
    );
  }
  const nodes = results.flatMap((r) => (r.nodeRecall === undefined ? [] : [r.nodeRecall]));
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(
    `\n${values.setup} · ${values.dataset} ${values.language} · ${results.length} issues · ${values.model}: ` +
      `file Acc@1 ${pct(mean(results.map((r) => r.fileAt1)))} · file Acc@5 ${pct(mean(results.map((r) => r.fileAt5)))} · ` +
      `file recall@5 ${pct(mean(results.map((r) => r.fileRecall5)))} · function recall ${nodes.length ? pct(mean(nodes)) : '–'} · ` +
      `tokens mean ${Math.round(mean(results.map((r) => r.tokens)))} · calls mean ${mean(results.map((r) => r.calls)).toFixed(1)} · ` +
      `wall p50 ${Math.round(percentile(results.map((r) => r.ms), 50) / 1000)} s · cost $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}`,
  );
  console.log(`Results in ${out.slice(root.length + 1)}`);
}

// `repo-a ×3, repo-b ×1`, most frequent first.
function tally<T>(items: T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ');
}

const cacheDir = join(root, 'eval/results/loc-cache');

// A dataset's issues in one shape, fetched once and kept in eval/results/loc-cache/.
const loaders: Record<string, () => Promise<Instance[]>> = {
  polybench: () => cached('swe-polybench-verified.json', () => datasetRows('AmazonScience/SWE-PolyBench_Verified', 'test')),
  swebench: () =>
    cached('swe-bench-verified.json', async () =>
      (await datasetRows('princeton-nlp/SWE-bench_Verified', 'test')).map((r) => ({ ...r, language: 'Python' })),
    ),
  multiswebench: () =>
    cached('multi-swe-bench-mini.json', async () => {
      const url = 'https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench_mini/resolve/main/multi_swe_bench_mini.jsonl';
      const text = await (await fetch(url)).text();
      const languages: Record<string, string> = { go: 'Go', ts: 'TypeScript', js: 'JavaScript', python: 'Python', java: 'Java', rust: 'Rust', c: 'C', 'c++': 'C++' };
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const r = JSON.parse(line) as {
            org: string;
            repo: string;
            instance_id: string;
            base: { sha: string };
            fix_patch: string;
            resolved_issues: { title?: string; body?: string }[];
            language: string;
            difficulty?: string;
          };
          return {
            instance_id: r.instance_id,
            repo: `${r.org}/${r.repo}`,
            base_commit: r.base.sha,
            patch: r.fix_patch,
            // The issues the fix resolves, not the pull request, which describes the fix.
            problem_statement: r.resolved_issues.map((i) => `${i.title ?? ''}\n\n${i.body ?? ''}`).join('\n\n'),
            language: languages[r.language] ?? r.language,
            ...(r.difficulty ? { difficulty: r.difficulty } : {}),
          };
        });
    }),
};

async function cached(name: string, fetchAll: () => Promise<Instance[]>): Promise<Instance[]> {
  const file = join(cacheDir, name);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8')) as Instance[];
  const rows = await fetchAll();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(rows));
  return rows;
}

// Every row of a Hugging Face dataset split, from its datasets server.
async function datasetRows(dataset: string, split: string): Promise<Instance[]> {
  const rows: Instance[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}&offset=${offset}&length=100`;
    const page = (await (await fetch(url)).json()) as { rows?: { row: Instance }[] };
    if (!page.rows?.length) break;
    rows.push(...page.rows.map((r) => r.row));
  }
  return rows;
}

// The instance's repository at its base commit, fetched without history into eval/corpora/loc/,
// or into CSYK_LOC_DIR: two setups run side by side need a checkout each.
async function checkout(instance: Instance): Promise<string> {
  const dir = join(process.env.CSYK_LOC_DIR ?? join(root, 'eval/corpora/loc'), instance.repo.replace('/', '__'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dir, { recursive: true });
    git('init', '-q');
    git('remote', 'add', 'origin', `https://github.com/${instance.repo}.git`);
  }
  // A large repository's fetch can drop on a slow network; it is tried three times.
  for (let attempt = 1; ; attempt++) {
    try {
      git('fetch', '-q', '--depth', '1', 'origin', instance.base_commit);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((done) => setTimeout(done, 10_000 * attempt));
    }
  }
  git('checkout', '-q', '-f', 'FETCH_HEAD');
  git('clean', '-q', '-fd');
  return dir;
}

// Kinds of symbol a fix is said to change: code with a body.
const changeable = new Set(['function', 'method', 'class', 'component', 'hook', 'route', 'widget', 'provider']);

/**
 * The files the fix changes and its functions, methods and classes:
 * SWE-PolyBench lists them; otherwise each line the fix removes, or adds
 * next to, is mapped to the innermost such symbol around it at the base
 * commit (found by CSyk's tree-sitter parse, the same for every setup).
 */
async function goldOf(instance: Instance, repo: string): Promise<Gold> {
  const files = [...new Set([...instance.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? ''))];
  if (instance.modified_nodes) {
    const nodes = (JSON.parse(instance.modified_nodes) as string[]).map((node) => {
      const parts = node.split('->');
      return { file: parts[0] ?? '', name: (parts.at(-1) ?? '').split(':').at(-1) ?? '' };
    });
    return { files, nodes };
  }
  const nodes = new Map<string, { file: string; name: string }>();
  for (const [file, lines] of changedOldLines(instance.patch)) {
    const path = join(repo, file);
    if (!existsSync(path)) continue;
    const symbols = (await extractSymbols(file, await readFile(path, 'utf8'))).filter((s) => changeable.has(s.kind));
    for (const line of lines) {
      const home = symbols
        .filter((s) => s.range[0] <= line && line <= s.range[1])
        .sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]))[0];
      if (home) nodes.set(`${file}#${home.name}`, { file, name: home.name });
    }
  }
  return { files, nodes: [...nodes.values()] };
}

/** The 1-based lines of each file's base version that a patch removes, or adds next to. */
export function changedOldLines(patch: string): Map<string, number[]> {
  const changed = new Map<string, number[]>();
  let file: string | undefined;
  let line = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('--- ')) {
      file = text.startsWith('--- a/') ? text.slice(6) : undefined;
      continue;
    }
    const hunk = /^@@ -(\d+)/.exec(text);
    if (hunk?.[1]) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || text.startsWith('+++')) continue;
    const mark = (n: number) => changed.set(file as string, [...(changed.get(file as string) ?? []), n]);
    if (text.startsWith('-')) mark(line++);
    else if (text.startsWith('+')) mark(Math.max(line, 1));
    else if (text.startsWith(' ')) line++;
  }
  return changed;
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
export function scoreAnswer(gold: Gold, files: string[], functions: string[]): Score {
  const top5 = files.slice(0, 5);
  const found = gold.files.filter((f) => top5.includes(f)).length;
  const score: Score = {
    fileAt1: files[0] && gold.files.includes(files[0]) ? 1 : 0,
    fileAt5: gold.files.length > 0 && found === gold.files.length ? 1 : 0,
    fileRecall5: gold.files.length > 0 ? found / gold.files.length : 0,
  };
  if (gold.nodes.length === 0) return score;
  const named = functions.map((f) => {
    const at = f.lastIndexOf(':');
    return { file: f.slice(0, at), name: f.slice(at + 1).split('.').at(-1) ?? '' };
  });
  const hit = gold.nodes.filter((n) => named.some((m) => m.file === n.file && m.name === n.name)).length;
  return { ...score, nodeRecall: hit / gold.nodes.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
