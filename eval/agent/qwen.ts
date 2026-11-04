import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { note } from '../../src/guide.ts';
import { watchResources } from '../harness/resources.ts';
import { countTokens } from '../harness/tokens.ts';
import type { ClaudeRun } from './claude.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The setups Qwen Code runs: its own tools alone, or CSyk's in place of its grep. */
export const qwenSetups = ['b0', 'csyk-lean'] as const;

const csykTools = ['find', 'grep', 'read', 'refs', 'calls', 'impact'].map((t) => `mcp__csyk__${t}`);
// Tools besides reading and searching that neither setup gets, as the Claude Code runs give
// only Read, Grep and Glob: a subagent's tokens would not be counted, and nothing may edit.
const disabled = ['agent', 'list_agents', 'send_message', 'task_stop', 'enter_worktree', 'exit_worktree', 'record_artifact', 'report_findings', 'web_search', 'web_fetch', 'cron_create', 'cron_list', 'cron_delete', 'loop_wakeup', 'monitor'];

/**
 * Runs [prompt] through headless Qwen Code (`qwen --output-format stream-json`)
 * in [cwd], from a HOME of its own per setup so the user's MCP servers,
 * skills, hooks and extensions stay out. The model's provider is taken from
 * the user's ~/.qwen/settings.json; its API key is passed in the child's
 * environment only, never written to disk.
 */
export async function runQwen(prompt: string, cwd: string, setup: string, model: string, maxTurns: string): Promise<ClaudeRun> {
  const user = JSON.parse(readFileSync(join(homedir(), '.qwen/settings.json'), 'utf8')) as {
    env?: Record<string, string>;
    modelProviders?: Record<string, { id: string; envKey?: string }[]>;
  };
  const providers = Object.entries(user.modelProviders ?? {}).flatMap(([type, list]) => list.map((p) => ({ type, ...p })));
  const provider = providers.find((p) => p.id === model);
  if (!provider) throw new Error(`no provider for ${model} in ~/.qwen/settings.json`);
  const { type, ...entry } = provider;
  const csyk = setup !== 'b0';
  const home = join(homedir(), '.cache/csyk-bench-home', `qwen-${setup}`);
  await mkdir(join(home, '.qwen'), { recursive: true });
  const settings = {
    security: { auth: { selectedType: type } },
    model: { name: model },
    modelProviders: { [type]: [entry] },
    // CSyk's tools are shown at the start, not found through tool_search first: a turn each.
    tools: { disabled: [...disabled, ...(csyk ? ['grep_search'] : [])], ...(csyk ? { visible: csykTools } : {}) },
  };
  await writeFile(join(home, '.qwen/settings.json'), JSON.stringify(settings, null, 2));
  // CSYK_CLI runs another build than dist/, so a run can go on while dist/ serves another.
  const server = { csyk: { command: process.execPath, args: [process.env.CSYK_CLI ?? join(root, 'dist/cli.js'), 'serve', cwd] } };
  const args = [
    prompt,
    '--output-format',
    'stream-json',
    '--approval-mode',
    'yolo',
    '--max-session-turns',
    maxTurns,
    ...['read_file', 'glob', ...(csyk ? [] : ['grep_search'])].flatMap((t) => ['--core-tools', t]),
    ...(csyk ? ['--mcp-config', JSON.stringify({ mcpServers: server }), '--append-system-prompt', note] : []),
  ];
  const env = { ...process.env, HOME: home, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1', ...(entry.envKey && user.env?.[entry.envKey] ? { [entry.envKey]: user.env[entry.envKey] } : {}) };
  const start = performance.now();
  let watch: ReturnType<typeof watchResources> | undefined;
  const lines = await new Promise<string[]>((done, fail) => {
    const child = spawn('qwen', args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
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
  let calls = 0;
  let toolTokens = 0;
  let errors = 0;
  let peakContext = 0;
  const byTool: Record<string, number> = {};
  let result: { result?: string; num_turns?: number; usage?: Record<string, number> } = {};
  for (const line of lines) {
    let event: { type?: string; message?: { content?: unknown; usage?: Record<string, number> } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    const blocks = (Array.isArray(event.message?.content) ? event.message.content : []) as {
      type?: string;
      name?: string;
      input?: { name?: unknown };
      content?: unknown;
      is_error?: boolean;
    }[];
    if (event.type === 'assistant') {
      // Qwen's input_tokens already include what was read from the cache.
      peakContext = Math.max(peakContext, event.message?.usage?.input_tokens ?? 0);
      for (const block of blocks.filter((b) => b.type === 'tool_use')) {
        calls++;
        // A tool reached through the bridge counts as itself.
        const name = block.name === 'tool_call' && typeof block.input?.name === 'string' ? block.input.name : (block.name ?? '?');
        byTool[name] = (byTool[name] ?? 0) + 1;
      }
    }
    if (event.type === 'user') {
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        toolTokens += countTokens(textOf(block.content));
        if (block.is_error) errors++;
      }
    }
    if (event.type === 'result') result = event as typeof result;
  }
  const usage = result.usage ?? {};
  return {
    answer: result.result ?? '',
    tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    toolTokens,
    byTool,
    errors,
    peakContext,
    usage,
    // A Token Plan subscription: no price per call.
    costUsd: 0,
    calls,
    turns: result.num_turns ?? 0,
    ms,
    peakMb,
    cpuSeconds,
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: { text?: string }) => c.text ?? '').join('');
  return '';
}
