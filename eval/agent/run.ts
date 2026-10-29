import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { assertPinned, loadCorpora } from '../harness/corpora.ts';
import { mean, percentile } from '../harness/metrics.ts';
import { buildCsyk, runClaude, setups, type ClaudeRun } from './claude.ts';

const usage = `Usage: npm run agent -- --setup <b0|b1|csyk> --corpus <name> [--model sonnet] [--task T01] [--max-turns 30]

Runs each task in eval/agent/tasks/<corpus>.yaml through headless Claude Code
(claude -p) in the corpus folder, with the setup's tools only, and records
tokens, tool calls, wall time, cost and whether the answer names every
expected item. Each run is billed to your Claude account.

With ANTHROPIC_API_KEY set, runs use --bare: no user settings, hooks or
CLAUDE.md. Without it, user and local settings are skipped
(--setting-sources project), but a user-level CLAUDE.md may still load.`;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

type Task = { id: string; prompt: string; expect: string[] };

type Run = Omit<ClaudeRun, 'answer'> & { id: string; pass: boolean; missing: string[] };

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      setup: { type: 'string' },
      corpus: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      task: { type: 'string' },
      'max-turns': { type: 'string', default: '30' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const corpus = (await loadCorpora(root)).get(values.corpus ?? '');
  const setup = corpus && setups(corpus.root, corpus.codesift)[values.setup ?? ''];
  if (values.help || !corpus || !setup) {
    console.log(usage);
    return;
  }
  assertPinned(corpus);
  if (values.setup === 'csyk') buildCsyk();
  const doc = parse(await readFile(join(root, 'eval/agent/tasks', `${corpus.name}.yaml`), 'utf8')) as { tasks: Task[] };
  const tasks = doc.tasks.filter((t) => !values.task || t.id === values.task);
  const runs: Run[] = [];
  for (const task of tasks) {
    const { answer, ...cost } = await runClaude(task.prompt, corpus.root, setup, values.model, values['max-turns']);
    const missing = task.expect.filter((item) => !answer.includes(item));
    const run: Run = { id: task.id, pass: missing.length === 0, missing, ...cost };
    runs.push(run);
    console.log(
      `${task.id} ${run.pass ? 'pass' : 'FAIL'} · ${run.tokens} tokens · ${run.calls} calls · ${Math.round(run.ms / 1000)} s · $${run.costUsd.toFixed(3)}` +
        (run.missing.length ? ` · missing ${run.missing.join(', ')}` : ''),
    );
  }
  const passRate = runs.filter((r) => r.pass).length / Math.max(runs.length, 1);
  console.log(
    `\n${values.setup} · ${corpus.name} · ${values.model}: pass ${(passRate * 100).toFixed(1)}% · ` +
      `tokens mean ${Math.round(mean(runs.map((r) => r.tokens)))} · calls mean ${mean(runs.map((r) => r.calls)).toFixed(1)} · ` +
      `wall p50 ${Math.round(percentile(runs.map((r) => r.ms), 50) / 1000)} s · cost $${runs.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}`,
  );
  const out = join(root, 'eval/results', `agent-${values.setup}-${corpus.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ setup: values.setup, corpus: corpus.name, model: values.model, runs }, null, 2)}\n`);
  console.log(`Runs written to ${out.slice(root.length + 1)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
