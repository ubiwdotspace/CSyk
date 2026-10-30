import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertPinned, loadCorpora } from './harness/corpora.ts';
import { isTestFile } from '../src/index/symbols.ts';
import type { Corpus } from './harness/types.ts';
import { parseCaseFile } from './harness/cases.ts';
import { answerAgain, callCases, impactCases, type CallCase } from './oracle/call-cases.ts';
import { answers, fuzzyQuery, seeded, shuffle } from './oracle/sampling.ts';
import { caseKinds, LspOracle, oracleServers } from './oracle/lsp-oracle.ts';

const usage = `Usage: npm run generate -- --corpus <name> --category <A|B|C|D|E|G> [--lang ts|py|go|dart] [--count 30] [--seed 1] [--force] [--answer-again]

Writes <corpus>.<category>.yaml with cases whose answers come from the
language's own server (tsc --lsp, pyright, gopls, the Dart analysis server),
to eval/cases/, or eval/cases/private/ for a corpus from corpora.local.yaml.
Review the cases before trusting them. --answer-again keeps the D or G
questions of the existing file and answers them again, as after a fix to
how answers are found.`;

type Generated = { query: string; direction?: 'in' | 'out'; expect: { file: string; lines: [number, number] }[] };

// Code a case should be about: not tests, end-to-end suites, stories, or
// generated and vendored code such as WebAssembly glue or protobuf stubs.
const generated =
  /(\.stories\.|(^|\/)(vendor|generated|__generated__)\/|-bindings\.|\.generated\.|\.min\.|\.pb\.go$|_gen\.go$|\.g\.dart$|\.freezed\.dart$)/;
const isSource = (file: string) => !isTestFile(file) && !generated.test(file);

// Names worth searching for: identifiers of five characters or more.
const isSearchable = (name: string) => /^[A-Za-z_$][\w$]{4,}$/.test(name);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      corpus: { type: 'string' },
      category: { type: 'string' },
      count: { type: 'string', default: '30' },
      seed: { type: 'string', default: '1' },
      force: { type: 'boolean', default: false },
      'answer-again': { type: 'boolean', default: false },
      lang: { type: 'string', default: 'ts' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const category = values.category?.toUpperCase();
  if (values.help || !values.corpus || !category) {
    console.log(usage);
    return;
  }
  if (!['A', 'B', 'C', 'D', 'E', 'G'].includes(category)) {
    throw new Error('F cases (concept questions) are written by hand.');
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const corpus = (await loadCorpora(root)).get(values.corpus);
  if (!corpus) throw new Error(`Corpus ${values.corpus} is not in eval/corpora*.yaml`);
  assertPinned(corpus);
  const out = join(root, 'eval/cases', corpus.private ? 'private' : '', `${corpus.name}.${category}.yaml`);
  if (!values.force && !values['answer-again'] && (await exists(out))) {
    throw new Error(`${out} exists; pass --force to replace it`);
  }

  const count = Number(values.count);
  const random = seeded(Number(values.seed));
  if (!oracleServers[values.lang]) throw new Error(`--lang must be one of ${Object.keys(oracleServers).join(', ')}`);
  const oracle = await LspOracle.start(corpus.root, values.lang);
  try {
    const sources = oracle.files.filter(isSource);
    if (values['answer-again']) {
      if (category !== 'D' && category !== 'G') throw new Error('--answer-again is for D and G cases');
      const text = await readFile(out, 'utf8');
      const seed = Number(/seed (\d+)\./.exec(text)?.[1] ?? values.seed);
      const asked = parseCaseFile(out, `${corpus.name}.${category}.yaml`, text).cases as CallCase[];
      const cases = await answerAgain(oracle, category, asked);
      await writeFile(out, render(corpus, oracleServers[values.lang] ?? values.lang, category, seed, cases));
      console.log(`${cases.length} of ${asked.length} case(s) answered again in ${out.slice(root.length + 1)}`);
      return;
    }
    const cases =
      category === 'E'
        ? await stringCases(oracle, count, random)
        : category === 'D'
          ? await callCases(oracle, sources, count, random)
          : category === 'G'
            ? await impactCases(oracle, sources, count, random)
            : await symbolCases(oracle, category, count, random);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, render(corpus, oracleServers[values.lang] ?? values.lang, category, Number(values.seed), cases));
    console.log(`${cases.length} case(s) written to ${out.slice(root.length + 1)}`);
  } finally {
    await oracle.stop();
  }
}

/** A, B and C cases: one symbol per file, from files in random order. */
async function symbolCases(
  oracle: LspOracle,
  category: string,
  count: number,
  random: () => number,
): Promise<Generated[]> {
  const cases: Generated[] = [];
  const seen = new Set<string>();
  // Every name in the repo, to keep only fuzzy queries one name answers.
  const names = category === 'B' ? await oracle.names(oracle.files) : new Set<string>();
  for (const file of shuffle(oracle.files.filter(isSource), random)) {
    if (cases.length >= count) break;
    const symbols = shuffle(await oracle.symbols(file), random);
    for (const symbol of symbols) {
      const name = symbol.name;
      if (!caseKinds.has(symbol.kind) || !isSearchable(name) || seen.has(name)) continue;
      seen.add(name);
      // Skip names that are only imported here.
      const self = await oracle.resolve({
        file,
        line: symbol.selectionRange.start.line,
        character: symbol.selectionRange.start.character,
      });
      if (self?.file !== file || self.nameLine !== symbol.selectionRange.start.line) continue;
      if (await oracle.isImport(file, symbol.selectionRange.start)) continue;
      const declarations = await oracle.declarations(name);
      const made = await makeCase(oracle, category, name, declarations, random, names);
      if (made) {
        cases.push(made);
        break;
      }
    }
  }
  return cases;
}

async function makeCase(
  oracle: LspOracle,
  category: string,
  name: string,
  declarations: Awaited<ReturnType<LspOracle['declarations']>>,
  random: () => number,
  names: ReadonlySet<string>,
): Promise<Generated | undefined> {
  const lines = (d: (typeof declarations)[number]): [number, number] => [d.startLine + 1, d.endLine + 1];
  if (category === 'A') {
    // A name declared in more places than a person would mean is no case.
    if (declarations.length === 0 || declarations.length > 3) return undefined;
    return { query: name, expect: declarations.map((d) => ({ file: d.file, lines: lines(d) })) };
  }
  const [only] = declarations;
  if (!only || declarations.length !== 1) return undefined;
  if (category === 'B') {
    const query = fuzzyQuery(name, random);
    // A query that another name answers too is ambiguous, not fuzzy.
    const unique = query !== undefined && [...names].every((other) => other === name || !answers(query, other));
    return unique ? { query, expect: [{ file: only.file, lines: lines(only) }] } : undefined;
  }
  const refs = await oracle.references(name, only);
  const unique = new Map(refs.map((ref) => [`${ref.file}:${ref.line}`, ref]));
  if (unique.size < 2 || unique.size > 40) return undefined;
  return {
    query: name,
    expect: [...unique.values()].map((ref) => ({ file: ref.file, lines: [ref.line + 1, ref.line + 1] })),
  };
}

// Text a person reads (a message, a label, a tooltip): a quoted sentence
// that starts with a capital and runs past a dozen characters.
const sentencePattern = String.raw`["'\x60][A-Z][a-z]+ [^"'\x60$]{12,}["'\x60]`;

/** E cases: sentences written once in the repo, answered by their enclosing symbol. */
async function stringCases(oracle: LspOracle, count: number, random: () => number): Promise<Generated[]> {
  const found = gitGrep(oracle.root, ['-n', '-E', '-e', sentencePattern, '--', ...oracle.files.filter(isSource)]);
  const cases: Generated[] = [];
  for (const entry of shuffle(found, random)) {
    if (cases.length >= count) break;
    const match = /^(.+?):(\d+):(.*)$/.exec(entry);
    if (!match?.[1] || !match[2] || !match[3] || !isSource(match[1])) continue;
    const literal = /(["'`])([A-Z][a-z]+ [^"'`$]{12,}?)\1/.exec(match[3])?.[2];
    // A sentence has lower-case words after its first; a class list does not.
    if (!literal || !/\s[a-z]{2,}\b/.test(literal)) continue;
    const query = literal.slice(0, 80);
    const total = gitGrep(oracle.root, ['-c', '-F', '-e', query]).reduce(
      (sum, line) => sum + Number(line.split(':').pop()),
      0,
    );
    if (total !== 1) continue;
    const home = await oracle.containing(match[1], Number(match[2]) - 1);
    if (!home) continue;
    cases.push({
      query,
      expect: [{ file: match[1], lines: [home.range.start.line + 1, home.range.end.line + 1] }],
    });
  }
  return cases;
}

function render(corpus: Corpus, server: string, category: string, seed: number, cases: Generated[]): string {
  const at = corpus.commit ?? 'its working tree';
  const lines = [
    `# Generated by eval/generate.ts from ${corpus.name} at ${at}, seed ${seed}.`,
    `# Answers come from the ${server} language server. Review before trusting:`,
    "# drop cases no person would ask, and rewrite queries that read like a machine's.",
    'cases:',
  ];
  cases.forEach((c, i) => {
    lines.push(`  - id: ${category}${String(i + 1).padStart(2, '0')}`);
    lines.push(`    query: ${JSON.stringify(c.query)}`);
    if (c.direction) lines.push(`    direction: ${c.direction}`);
    lines.push('    expect:');
    for (const loc of c.expect) {
      lines.push(`      - { file: ${JSON.stringify(loc.file)}, lines: [${loc.lines[0]}, ${loc.lines[1]}] }`);
    }
  });
  return `${lines.join('\n')}\n`;
}

// git grep's lines; none when nothing matches (its exit code 1).
function gitGrep(cwd: string, args: string[]): string[] {
  try {
    return execFileSync('git', ['grep', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
