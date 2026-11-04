import { execFileSync, spawn } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { note } from '../../src/guide.ts';
import { watchResources } from '../harness/resources.ts';
import { countTokens } from '../harness/tokens.ts';
import type { ClaudeRun } from './claude.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The setups Antigravity runs: its own tools alone (`b0`); CSyk's server and Claude Code's note,
 * as the agy1 run had it (`csyk-lean`); or whatever `csyk setup --user --agent antigravity` of the
 * CSyk under test writes (`csyk-setup`): its note for agy, and its hooks where that version has them.
 */
export const antigravitySetups = ['b0', 'csyk-lean', 'csyk-setup'] as const;

async function homeFor(setup: string, cwd: string): Promise<string> {
  const home = join(homedir(), '.cache/csyk-bench-home', `agy-${setup}`);
  const config = join(home, '.gemini/config');
  await mkdir(config, { recursive: true });
  // agy keeps its sign-in in the login keychain, which macOS finds under HOME: only that is
  // linked, so the user's MCP servers, rules, plugins and hooks in ~/.gemini stay out.
  await mkdir(join(home, 'Library'), { recursive: true });
  const keychains = join(home, 'Library/Keychains');
  if (!existsSync(keychains)) symlinkSync(join(homedir(), 'Library/Keychains'), keychains);
  // As `csyk setup --user` writes it for the agy command line: the server, started in the
  // project, and the note in GEMINI.md. Without CSyk, neither.
  const csyk = setup !== 'b0';
  const cli = process.env.CSYK_CLI ?? join(root, 'dist/cli.js');
  if (setup === 'csyk-setup') {
    // Setup run from the build's own sources, so the server and hooks it writes start that build
    // (from dist/ it would write the `csyk` on the PATH). Written afresh for every issue.
    const source = join(dirname(cli), '../src/cli.ts');
    if (!existsSync(source)) throw new Error(`csyk-setup needs ${source} next to CSYK_CLI`);
    await rm(join(home, '.gemini'), { recursive: true, force: true });
    await mkdir(config, { recursive: true });
    execFileSync(process.execPath, [source, 'setup', '--write', '--user', '--agent', 'antigravity'], {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: 'ignore',
    });
    await denyWeb(config);
    return home;
  }
  await writeFile(join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: csyk ? { csyk: { command: process.execPath, args: [cli, 'serve', cwd] } } : {} }, null, 2));
  await writeFile(join(home, '.gemini/GEMINI.md'), csyk ? `${note}\n` : '');
  await rm(join(config, 'hooks.json'), { force: true });
  await denyWeb(config);
  return home;
}

/**
 * Turns down agy's web and browser tools in every setup, as the other agents' runs have none:
 * left on, Gemini searched GitHub for the issue's own pull request and fix commit (182 searches
 * in the agy1 run's four issues without CSyk), which measures finding the answer, not the code.
 */
async function denyWeb(config: string): Promise<void> {
  const file = join(config, 'hooks.json');
  const hooks = existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>) : {};
  const reason = 'No web access in this benchmark: answer from the repository.';
  const command = `cat >/dev/null; printf '%s' '${JSON.stringify({ decision: 'deny', reason })}'`;
  hooks.bench = { PreToolUse: [{ matcher: 'search_web|read_url_content|browser_.*', hooks: [{ type: 'command', command, timeout: 10 }] }] };
  await writeFile(file, `${JSON.stringify(hooks, null, 2)}\n`);
}

/**
 * Runs [prompt] through the Antigravity command line (`agy -p`, stream-json)
 * in [cwd], reading its steps: each model response with its usage, each
 * tool call with its output.
 */
export async function runAntigravity(prompt: string, cwd: string, setup: string, model: string): Promise<ClaudeRun> {
  const home = await homeFor(setup, cwd);
  const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--disable-slash-commands'];
  const start = performance.now();
  let watch: ReturnType<typeof watchResources> | undefined;
  const lines = await new Promise<string[]>((done, fail) => {
    const child = spawn('agy', args, { cwd, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  type Usage = { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number };
  type Step = {
    state?: string;
    step_type?: string;
    tool_name?: string;
    tool_info?: { parameters?: Record<string, unknown>; output?: string; error?: string | { message?: string } };
    usage?: Usage;
  };
  let calls = 0;
  let turns = 0;
  let toolTokens = 0;
  let errors = 0;
  let peakContext = 0;
  const byTool: Record<string, number> = {};
  const total: Required<Usage> = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 };
  let answer = '';
  for (const line of lines) {
    let event: { event?: string; step_update?: Step; result?: { response?: string } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    const step = event.step_update;
    if (step?.state === 'DONE' && step.step_type === 'agent_response') {
      turns++;
      const u = step.usage ?? {};
      for (const key of Object.keys(total) as (keyof Usage)[]) total[key] += u[key] ?? 0;
      peakContext = Math.max(peakContext, (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0));
    }
    // A tool step ends DONE, or ERROR when it failed or a hook turned it down (counted apart,
    // `denied:run_command` for CSyk's pre-bash): the agent paid a turn for it either way.
    if ((step?.state === 'DONE' || step?.state === 'ERROR') && step.step_type === 'tool') {
      calls++;
      // An MCP tool is reached through call_mcp_tool: count it as itself.
      const params = step.tool_info?.parameters ?? {};
      const mcp = step.tool_name === 'call_mcp_tool' ? String(params.ToolName ?? params.toolName ?? params.name ?? 'mcp') : undefined;
      const tool = mcp ? `mcp:${mcp}` : (step.tool_name ?? '?');
      const error = step.tool_info?.error;
      const message = typeof error === 'object' && error ? String((error as { message?: unknown }).message ?? '') : String(error ?? '');
      const name = step.state === 'DONE' ? tool : message.includes('pre-tool hook') ? `denied:${tool}` : `failed:${tool}`;
      byTool[name] = (byTool[name] ?? 0) + 1;
      toolTokens += countTokens(step.tool_info?.output ?? message);
      if (error) errors++;
    }
    if (event.event === 'result') answer = event.result?.response ?? '';
  }
  return {
    answer,
    // Everything the model read and wrote, the cache included, as for the other agents.
    tokens: total.input_tokens + total.cache_read_tokens + total.output_tokens + total.thinking_tokens,
    toolTokens,
    byTool,
    errors,
    peakContext,
    usage: total,
    costUsd: 0,
    calls,
    turns,
    ms,
    peakMb,
    cpuSeconds,
  };
}
