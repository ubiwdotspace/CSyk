import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { assertPinned, loadCorpora } from '../harness/corpora.ts';
import { mean, percentile } from '../harness/metrics.ts';
import { antigravitySetups, runAntigravity } from './antigravity.ts';
import { buildCsyk, runClaude, setups, type ClaudeRun } from './claude.ts';

const usage = `Usage: npm run agent -- --setup <b0|csyk-setup|csyk-lean> --corpus <name> [--model gemini-3.8-flash-medium] [--task T01] [--run <name>]
       npm run agent -- --agent claude --other-model --setup <b0|csyk> --corpus <name> [--model sonnet] [--max-turns 30]

Runs each task in eval/agent/tasks/<corpus>.yaml (npm run agent:tasks) through
Gemini on the Antigravity command line (agy -p), the test source, in the
corpus folder: agy alone (b0), or as csyk setup sets it up (csyk-setup). It
records tokens, tool calls, wall time and whether the answer names every
expected item, and how many of them it names. Run b0 and the setup under
the same --run name, side by side: agy's context changes with its version.

With --agent claude --other-model, headless Claude Code instead, billed to
your Claude account.`;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

type Task = { id: string; prompt: string; expect: string[] };

type Run = Omit<ClaudeRun, 'answer'> & { id: string; pass: boolean; named: number; missing: string[]; answer: string };

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string', default: 'antigravity' },
      setup: { type: 'string' },
      corpus: { type: 'string' },
      model: { type: 'string' },
      task: { type: 'string' },
      run: { type: 'string' },
      'max-turns': { type: 'string', default: '30' },
      'other-model': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const claude = values.agent === 'claude';
  const model = values.model ?? (claude ? 'sonnet' : 'gemini-3.8-flash-medium');
  if (!values.help && !values['other-model'] && (claude || !model.startsWith('gemini-'))) {
    console.log(`Gemini through agy is the test source: ${values.agent} with ${model} needs --other-model.`);
    process.exitCode = 1;
    return;
  }
  const corpus = (await loadCorpora(root)).get(values.corpus ?? '');
  const claudeSetup = claude && corpus ? setups(corpus.root)[values.setup ?? ''] : undefined;
  const known = claude ? claudeSetup !== undefined : (antigravitySetups as readonly string[]).includes(values.setup ?? '');
  if (values.help || !corpus || !known) {
    console.log(usage);
    return;
  }
  assertPinned(corpus);
  // CSYK_CLI names a built CSyk to measure (a snapshot), as for npm run loc; else this one, built now.
  if (values.setup !== 'b0' && !process.env.CSYK_CLI) buildCsyk();
  const doc = parse(await readFile(join(root, 'eval/agent/tasks', `${corpus.name}.yaml`), 'utf8')) as { tasks: Task[] };
  const tasks = doc.tasks.filter((t) => !values.task || t.id === values.task);
  // Written after every task: a run that stops resumes where it was.
  const out = join(root, 'eval/results', `agent-${values.setup}-${corpus.name}${values.run ? `.${values.run}` : ''}.json`);
  const runs: Run[] = values.run ? ((await readFile(out, 'utf8').then((t) => (JSON.parse(t) as { runs: Run[] }).runs).catch(() => [])) as Run[]) : [];
  await mkdir(dirname(out), { recursive: true });
  for (const task of tasks) {
    if (runs.some((r) => r.id === task.id)) continue;
    const { answer, ...cost } = claudeSetup
      ? await runClaude(task.prompt, corpus.root, claudeSetup, model, values['max-turns'])
      : await runAntigravity(task.prompt, corpus.root, values.setup ?? 'b0', model);
    if (cost.timedOut) {
      console.log(`${task.id} timed out after ${Math.round(cost.ms / 1000)} s · not scored; the next run with this --run name tries it again`);
      continue;
    }
    // No model turn and no tool call: the agent never ran (agy's "Eligibility check failed: 500",
    // a sign-in that expired), which says nothing of the setup.
    if (cost.tokens === 0 && cost.calls === 0) {
      console.log(`${task.id} the agent did not run (no model reply) · not scored; the next run with this --run name tries it again`);
      continue;
    }
    const missing = task.expect.filter((item) => !answer.includes(item));
    const run: Run = { id: task.id, pass: missing.length === 0, named: task.expect.length - missing.length, missing, answer, ...cost };
    runs.push(run);
    await writeFile(out, `${JSON.stringify({ agent: values.agent, setup: values.setup, corpus: corpus.name, model, runs }, null, 2)}\n`);
    console.log(
      `${task.id} ${run.pass ? 'pass' : 'FAIL'} · named ${run.named}/${task.expect.length} · ${run.tokens} tokens · ${run.calls} calls · ${Math.round(run.ms / 1000)} s` +
        (run.missing.length ? ` · missing ${run.missing.join(', ')}` : ''),
    );
  }
  const expected = (r: Run) => r.named + r.missing.length;
  const passRate = runs.filter((r) => r.pass).length / Math.max(runs.length, 1);
  const recall = runs.reduce((a, r) => a + r.named, 0) / Math.max(runs.reduce((a, r) => a + expected(r), 0), 1);
  console.log(
    `\n${values.setup} · ${corpus.name} · ${model}: pass ${(passRate * 100).toFixed(1)}% · items named ${(recall * 100).toFixed(1)}% · ` +
      `tokens mean ${Math.round(mean(runs.map((r) => r.tokens)))} · calls mean ${mean(runs.map((r) => r.calls)).toFixed(1)} · ` +
      `wall p50 ${Math.round(percentile(runs.map((r) => r.ms), 50) / 1000)} s`,
  );
  console.log(`Runs written to ${out.slice(root.length + 1)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
