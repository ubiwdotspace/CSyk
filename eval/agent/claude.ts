import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from '../harness/tokens.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tools = 'Read,Grep,Glob';

/** What an agent is given besides Read, Grep and Glob. */
export type Setup = { mcp?: Record<string, unknown>; allowed: string[]; settings?: unknown; guide?: string };

/** One headless run: the final answer and what it cost. */
export type ClaudeRun = {
  answer: string;
  tokens: number;
  /** Tokens of what the tools returned (o200k_base), the part a search tool controls. */
  toolTokens: number;
  /** Calls per tool, such as Read, Grep or mcp__csyk__find. */
  byTool: Record<string, number>;
  /** The parts of [tokens]: input, cache writes, cache reads, output. */
  usage: Record<string, number>;
  costUsd: number;
  calls: number;
  turns: number;
  ms: number;
};

/**
 * The setups of PLAN.md §7.4 for a workspace at [workspace]: B0 (built-in
 * tools only), B1 (CodeSift, repo [codesift]) and CSyk (its MCP server, its
 * hooks and its CLAUDE.md note, from the build that buildCsyk makes).
 */
export function setups(workspace: string, codesift = ''): Record<string, Setup> {
  const csyk = ['node', join(root, 'dist/cli.js')];
  const hook = (name: string) => [{ type: 'command', command: `${csyk.join(' ')} hook ${name}` }];
  return {
    b0: { allowed: [] },
    b1: {
      mcp: { codesift: { command: process.env.CODESIFT_MCP ?? 'codesift-mcp', args: [] } },
      allowed: ['mcp__codesift'],
      guide:
        `Use the CodeSift tools (repo "${codesift}") for code: search_symbols, find_references, ` +
        'trace_call_chain, search_text, get_file_outline. Prefer them to Grep and to reading whole files.',
    },
    csyk: {
      mcp: { csyk: { command: csyk[0], args: [...csyk.slice(1), 'serve', workspace] } },
      allowed: ['mcp__csyk'],
      settings: {
        hooks: {
          PreToolUse: [
            { matcher: 'Read', hooks: hook('pre-read') },
            { matcher: 'Grep', hooks: hook('pre-grep') },
          ],
        },
      },
      guide:
        'Use the CSyk tools for code: find a symbol by name, outline a file, read one symbol, refs and calls ' +
        'for its uses and callers, impact after edits, grep for text. Read a whole file only when you need most of it.',
    },
  };
}

/**
 * Builds CSyk so the CSyk setup runs what an installed user runs, unless the
 * build is newer than every source file: runs side by side then never
 * rewrite dist/ under a server that is starting from it.
 */
export function buildCsyk(): void {
  const built = join(root, 'dist/cli.js');
  const sources = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => statSync(join(e.parentPath, e.name)).mtimeMs);
  if (existsSync(built) && statSync(built).mtimeMs > Math.max(...sources)) return;
  execFileSync('npm', ['run', '-s', 'build'], { cwd: root, stdio: 'inherit' });
}

/**
 * Runs [prompt] through headless Claude Code (`claude -p`) in [cwd] with
 * [setup]'s tools only, reading its stream of JSON events. With
 * ANTHROPIC_API_KEY set it uses --bare (no user settings, hooks or
 * CLAUDE.md); otherwise it skips user and local settings.
 */
export async function runClaude(prompt: string, cwd: string, setup: Setup, model: string, maxTurns: string): Promise<ClaudeRun> {
  const scratch = join(tmpdir(), 'csyk-agent');
  await mkdir(scratch, { recursive: true });
  const mcpFile = join(scratch, `mcp-${process.pid}.json`);
  await writeFile(mcpFile, JSON.stringify({ mcpServers: setup.mcp ?? {} }));
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--max-turns',
    maxTurns,
    '--tools',
    tools,
    '--allowedTools',
    [tools, ...setup.allowed].join(','),
    '--strict-mcp-config',
    '--mcp-config',
    mcpFile,
    '--no-session-persistence',
    ...(process.env.ANTHROPIC_API_KEY ? ['--bare'] : ['--setting-sources', 'project']),
    ...(setup.settings ? ['--settings', JSON.stringify(setup.settings)] : []),
    ...(setup.guide ? ['--append-system-prompt', setup.guide] : []),
  ];
  const start = performance.now();
  const lines = await new Promise<string[]>((done, fail) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', fail);
    child.on('close', () => done(out.split('\n').filter(Boolean)));
  });
  const ms = performance.now() - start;
  let calls = 0;
  let toolTokens = 0;
  const byTool: Record<string, number> = {};
  let result: { result?: string; total_cost_usd?: number; num_turns?: number; usage?: Record<string, number> } = {};
  for (const line of lines) {
    const event = JSON.parse(line) as { type?: string; message?: { content?: ToolBlock[] } };
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      for (const block of blocks.filter((c) => c.type === 'tool_use')) {
        calls++;
        byTool[block.name ?? '?'] = (byTool[block.name ?? '?'] ?? 0) + 1;
      }
    }
    if (event.type === 'user') for (const block of blocks) if (block.type === 'tool_result') toolTokens += countTokens(textOf(block.content));
    if (event.type === 'result') result = event as typeof result;
  }
  const usage = result.usage ?? {};
  const tokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  return {
    answer: result.result ?? '',
    tokens,
    toolTokens,
    byTool,
    usage,
    costUsd: result.total_cost_usd ?? 0,
    calls,
    turns: result.num_turns ?? 0,
    ms,
  };
}

type ToolBlock = { type: string; name?: string; content?: unknown };

// The text of a tool result: a string, or a list of text blocks.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

