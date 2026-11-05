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
 * The setups the Cursor agent runs: its own tools alone (`b0`), or with what `csyk setup --agent
 * cursor` of the CSyk under test writes in the project (`csyk-setup`): the server, the rule every
 * chat reads, the skill and the hooks. The project's setup, as the rule for every project is not
 * a file (Cursor keeps it in its settings). Not yet run: Cursor is not installed where this was
 * written, so the event names below come from Cursor's documentation.
 */
export const cursorSetups = ['b0', 'csyk-setup'] as const;

// A HOME of its own per setup, so the user's servers, rules and hooks in ~/.cursor stay out;
// the sign-in comes from the login keychain (macOS), or from CURSOR_API_KEY.
async function homeFor(setup: string): Promise<string> {
  const home = join(homedir(), '.cache/csyk-bench-home', `cursor-${setup}`);
  await rm(join(home, '.cursor'), { recursive: true, force: true });
  await mkdir(join(home, 'Library'), { recursive: true });
  const keychains = join(home, 'Library/Keychains');
  if (!existsSync(keychains)) symlinkSync(join(homedir(), 'Library/Keychains'), keychains);
  return home;
}

/**
 * Runs [prompt] through the Cursor agent's command line (`cursor-agent -p`, stream-json) in
 * [cwd]: each tool call, each assistant message as a turn, and the result as the answer. Cursor
 * reports no tokens, so [tokens] is 0 and only time, calls and accuracy compare.
 */
export async function runCursor(prompt: string, cwd: string, setup: string, model: string): Promise<ClaudeRun> {
  const home = await homeFor(setup);
  if (setup === 'csyk-setup') {
    // From the build's own sources, so the server and hooks it writes start that build. The
    // checkout is cleaned before the next issue, which takes these files away.
    const cli = process.env.CSYK_CLI ?? join(root, 'dist/cli.js');
    const source = join(dirname(cli), '../src/cli.ts');
    if (!existsSync(source)) throw new Error(`csyk-setup needs ${source} next to CSYK_CLI`);
    execFileSync(process.execPath, [source, 'setup', '--write', '--agent', 'cursor'], { cwd, env: { ...process.env, HOME: home }, stdio: 'ignore' });
  }
  const bin = process.env.CURSOR_AGENT_BIN ?? 'cursor-agent';
  const args = ['-p', prompt, '--output-format', 'stream-json', '--force', '--approve-mcps', ...(model && model !== 'default' ? ['--model', model] : [])];
  const start = performance.now();
  let watch: ReturnType<typeof watchResources> | undefined;
  const lines = await new Promise<string[]>((done, fail) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  type Call = { args?: Record<string, unknown>; result?: { success?: unknown; error?: unknown; rejected?: unknown } };
  let calls = 0;
  let turns = 0;
  let toolTokens = 0;
  let errors = 0;
  let answer = '';
  const byTool: Record<string, number> = {};
  for (const line of lines) {
    let event: { type?: string; subtype?: string; tool_call?: Record<string, Call>; result?: string };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === 'assistant') turns++;
    if (event.type === 'result') answer = event.result ?? '';
    if (event.type !== 'tool_call' || event.subtype !== 'completed' || !event.tool_call) continue;
    // Keyed by kind: readToolCall, grepToolCall, shellToolCall, mcpToolCall, …
    const [kind = 'unknown', call = {}] = Object.entries(event.tool_call)[0] ?? [];
    const tool = kind.replace(/ToolCall$/, '');
    const mcpName = call.args?.toolName ?? call.args?.name;
    const name = tool === 'mcp' && typeof mcpName === 'string' ? `mcp:${mcpName}` : tool;
    const failed = call.result !== undefined && call.result.success === undefined;
    const key = failed ? `failed:${name}` : name;
    calls++;
    byTool[key] = (byTool[key] ?? 0) + 1;
    if (failed) errors++;
    toolTokens += countTokens(JSON.stringify(call.result?.success ?? call.result ?? ''));
  }
  return {
    answer,
    tokens: 0,
    toolTokens,
    byTool,
    errors,
    peakContext: 0,
    usage: {},
    costUsd: 0,
    calls,
    turns,
    ms,
    peakMb,
    cpuSeconds,
  };
}
