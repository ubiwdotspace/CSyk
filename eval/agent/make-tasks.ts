import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Workspace } from '../../src/workspace/workspace.ts';
import { loadCaseFiles } from '../harness/cases.ts';
import { loadCorpora } from '../harness/corpora.ts';
import type { Case } from '../harness/types.ts';
import { seeded, shuffle } from '../oracle/sampling.ts';

/**
 * `npm run agent:tasks -- --corpus <name>`: writes eval/agent/tasks/<corpus>.yaml,
 * 20 tasks for the agent benchmark built from the corpus's generated cases,
 * whose answers come from the language server: where a symbol is defined
 * (A), who calls it and what it calls (D), and which function shows a
 * message (E). A task passes when the agent's final answer names every
 * expected item. Review the tasks before trusting them.
 */
const { values } = parseArgs({ options: { corpus: { type: 'string' }, seed: { type: 'string', default: '1' } } });
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = (await loadCorpora(root)).get(values.corpus ?? '');
if (!corpus) throw new Error('Pass --corpus <name> from eval/corpora.yaml');
const files = (await loadCaseFiles(join(root, 'eval/cases'))).filter((f) => f.corpus === corpus.name);
const random = seeded(Number(values.seed));
const pick = (category: string, count: number, keep: (c: Case) => boolean = () => true) =>
  shuffle(files.find((f) => f.category === category)?.cases ?? [], random).filter(keep).slice(0, count);

const ws = await Workspace.open(corpus.root);
// The name of the symbol that spans an expected range.
const nameAt = (file: string, line: number) => ws.index.containing(file, line)?.name;
const names = (c: Case) => [...new Set(c.expect.flatMap((loc) => (loc.lines ? [nameAt(loc.file, loc.lines[0])] : [])))].filter(
  (n): n is string => n !== undefined,
);

type Task = { id: string; prompt: string; expect: string[] };
const tasks: Task[] = [];
for (const c of pick('A', 5)) {
  tasks.push({
    id: '',
    prompt: `Where is \`${c.query}\` defined in this repository? Give the file path and its signature.`,
    expect: [...new Set(c.expect.map((loc) => loc.file))],
  });
}
for (const c of pick('D', 10, (c) => c.direction === 'in').slice(0, 5)) {
  const callers = names(c).slice(0, 4);
  if (callers.length === 0) continue;
  tasks.push({ id: '', prompt: `Which functions call \`${c.query}\`? List each caller's name and file.`, expect: callers });
}
for (const c of pick('D', 10, (c) => c.direction === 'out').slice(0, 5)) {
  const callees = names(c).slice(0, 4);
  if (callees.length === 0) continue;
  tasks.push({ id: '', prompt: `Which functions or methods does \`${c.query}\` call? Name each one.`, expect: callees });
}
for (const c of pick('E', 5)) {
  const home = names(c)[0];
  if (!home) continue;
  tasks.push({
    id: '',
    prompt: `Which function or component shows the text "${c.query}"? Name it and its file.`,
    expect: [home, c.expect[0]?.file ?? ''],
  });
}
tasks.forEach((t, i) => (t.id = `T${String(i + 1).padStart(2, '0')}`));
await ws.close();

const yaml = [
  `# Built by eval/agent/make-tasks.ts from the ${corpus.name} cases, seed ${values.seed}.`,
  '# A task passes when the final answer names every expected item.',
  'tasks:',
  ...tasks.flatMap((t) => [
    `  - id: ${t.id}`,
    `    prompt: ${JSON.stringify(t.prompt)}`,
    `    expect: [${t.expect.map((e) => JSON.stringify(e)).join(', ')}]`,
  ]),
].join('\n');
const out = join(root, 'eval/agent/tasks', `${corpus.name}.yaml`);
await writeFile(out, `${yaml}\n`);
console.log(`${tasks.length} task(s) written to ${out.slice(root.length + 1)}`);
