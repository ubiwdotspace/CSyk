import { execFileSync, spawn } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchResources } from '../harness/resources.ts';
import { countTokens } from '../harness/tokens.ts';
import type { ClaudeRun } from './claude.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The setups Codex runs: its own shell alone (`b0`), or with what `csyk setup --user --agent
 * codex` of the CSyk under test writes (`csyk-setup`): the server, the note, and its hooks.
 */
export const codexSetups = ['b0', 'csyk-setup'] as const;

// A CODEX_HOME of its own per setup, so the user's servers, hooks, rules and settings stay out;
// only the sign-in is shared, linked so a refreshed token is written back to the user's own.
async function homeFor(setup: string, cwd: string): Promise<string> {
  const home = join(homedir(), '.cache/csyk-bench-home', `codex-${setup}`);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  if (!existsSync(auth)) throw new Error(`no Codex sign-in at ${auth}: run codex login`);
  symlinkSync(auth, join(home, 'auth.json'));
  if (setup === 'csyk-setup') {
    // From the build's own sources, so the server and hooks it writes start that build.
    const cli = process.env.CSYK_CLI ?? join(root, 'dist/cli.js');
    const source = join(dirname(cli), '../src/cli.ts');
    if (!existsSync(source)) throw new Error(`csyk-setup needs ${source} next to CSYK_CLI`);
    execFileSync(process.execPath, [source, 'setup', '--write', '--user', '--agent', 'codex'], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: 'ignore' });
  } else await writeFile(join(home, 'config.toml'), '');
  return home;
}

/**
 * Runs [prompt] through `codex exec --json` in [cwd], read-only, reading its items: each shell
 * command, MCP call and web search, the last message as the answer, and the usage of the turn.
 */
export async function runCodex(prompt: string, cwd: string, setup: string, model: string): Promise<ClaudeRun> {
  const home = await homeFor(setup, cwd);
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // The hooks setup writes are trusted for the run, as a user trusts them once in /hooks.
    '--dangerously-bypass-hook-trust',
    '-s',
    'read-only',
    // No web, as in the other agents' runs: the issue's own fix is on GitHub.
    '-c',
    'web_search="disabled"',
    ...(model && model !== 'default' ? ['-m', model] : []),
    prompt,
  ];
  const start = performance.now();
  let watch: ReturnType<typeof watchResources> | undefined;
  const lines = await new Promise<string[]>((done, fail) => {
    const child = spawn('codex', args, { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    if (child.pid) watch = watchResources(child.pid);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', fail);
    child.on('close', () => done(out.split('\n').filter(Boolean)));
  });
  const ms = performance.now() - start;
  const { peakMb, cpuSeconds } = (await watch?.stop()) ?? { peakMb: 0, cpuSeconds: 0 };
  if (process.env.CSYK_TRANSCRIPTS) {
    await mkdir(process.env.CSYK_TRANSCRIPTS, { recursive: true });
    await writeFile(join(process.env.CSYK_TRANSCRIPTS, `${Date.now()}.jsonl`), `${lines.join('\n')}\n`);
  }
  type Item = {
    type?: string;
    text?: string;
    status?: string;
    command?: string;
    aggregated_output?: string;
    server?: string;
    tool?: string;
    result?: unknown;
    error?: unknown;
  };
  let calls = 0;
  let toolTokens = 0;
  let errors = 0;
  let answer = '';
  const byTool: Record<string, number> = {};
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (const line of lines) {
    let event: { type?: string; item?: Item; usage?: Partial<typeof usage> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === 'turn.completed') for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] += event.usage?.[key] ?? 0;
    const item = event.item;
    if (event.type !== 'item.completed' || !item) continue;
    if (item.type === 'agent_message') answer = item.text ?? answer;
    const name =
      item.type === 'command_execution' ? 'shell' : item.type === 'mcp_tool_call' ? `${item.server}:${item.tool}` : item.type === 'web_search' ? 'web_search' : undefined;
    if (!name) continue;
    calls++;
    // A failed or declined call (a hook's denial included) costs a turn all the same.
    const failed = item.status !== undefined && item.status !== 'completed';
    const key = failed ? `failed:${name}` : name;
    byTool[key] = (byTool[key] ?? 0) + 1;
    if (failed || item.error) errors++;
    toolTokens += countTokens(item.aggregated_output ?? (item.result === undefined ? '' : JSON.stringify(item.result)));
  }
  return {
    answer,
    // OpenAI's input_tokens include the cached ones.
    tokens: usage.input_tokens + usage.output_tokens,
    toolTokens,
    byTool,
    errors,
    // codex exec reports one total per turn, not each request.
    peakContext: 0,
    usage,
    costUsd: 0,
    calls,
    // Each tool call follows a model response, and one more gives the answer; parallel calls
    // share a response, so this counts at most the requests made.
    turns: calls + 1,
    ms,
    peakMb,
    cpuSeconds,
  };
}
