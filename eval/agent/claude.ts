import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { note, skill } from '../../src/guide.ts';
import { countTokens } from '../harness/tokens.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tools = 'Read,Grep,Glob';

/**
 * What an agent is given besides Read, Grep and Glob, and the [files]
 * written into the workspace before it starts, such as a skill.
 */
export type Setup = {
  mcp?: Record<string, unknown>;
  allowed: string[];
  settings?: unknown;
  guide?: string;
  files?: Record<string, string>;
};

/** One headless run: the final answer and what it cost. */
export type ClaudeRun = {
  answer: string;
  tokens: number;
  /** Tokens of what the tools returned (o200k_base), the part a search tool controls. */
  toolTokens: number;
  /** Calls per tool, such as Read, Grep or mcp__csyk__find. */
  byTool: Record<string, number>;
  /** Tool calls that came back as errors, a hook's denial included: each costs a turn. */
  errors: number;
  /** The largest context one request sent: the prompt plus everything gathered by then. */
  peakContext: number;
  /** The parts of [tokens]: input, cache writes, cache reads, output. */
  usage: Record<string, number>;
  costUsd: number;
  calls: number;
  turns: number;
  ms: number;
};

/**
 * The setups for a workspace at [workspace]: b0 (Claude Code's built-in
 * tools only) and CSyk in several configurations, run from the build that
 * buildCsyk makes.
 */
export function setups(workspace: string): Record<string, Setup> {
  const csyk = ['node', join(root, 'dist/cli.js')];
  const hook = (name: string) => [{ type: 'command', command: `${csyk.join(' ')} hook ${name}` }];
  return {
    b0: { allowed: [] },
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
    // CSyk as `csyk setup` installs it now: it replaces the built-in Grep (removed by a
    // deny rule, so no call is refused), no denying hooks, the CLAUDE.md note and the skill.
    'csyk-lean': {
      mcp: { csyk: { command: csyk[0], args: [...csyk.slice(1), 'serve', workspace] } },
      allowed: ['mcp__csyk'],
      settings: { permissions: { deny: ['Grep'] } },
      guide: note,
      files: { '.claude/skills/csyk/SKILL.md': skill },
    },
    // CSyk without its hooks: a denied call costs the agent a turn.
    'csyk-nohooks': {
      mcp: { csyk: { command: csyk[0], args: [...csyk.slice(1), 'serve', workspace] } },
      allowed: ['mcp__csyk'],
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
  for (const [file, text] of Object.entries(setup.files ?? {})) {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), text);
  }
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
  // CSYK_TRANSCRIPTS=<dir> keeps each run's events, to see what the agent did.
  if (process.env.CSYK_TRANSCRIPTS) {
    await mkdir(process.env.CSYK_TRANSCRIPTS, { recursive: true });
    await writeFile(join(process.env.CSYK_TRANSCRIPTS, `${Date.now()}.jsonl`), `${lines.join('\n')}\n`);
  }
  let calls = 0;
  let toolTokens = 0;
  const byTool: Record<string, number> = {};
  let errors = 0;
  let peakContext = 0;
  let result: { result?: string; total_cost_usd?: number; num_turns?: number; usage?: Record<string, number> } = {};
  for (const line of lines) {
    const event = JSON.parse(line) as { type?: string; message?: { content?: ToolBlock[] } };
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      const used = (event.message as { usage?: Record<string, number> } | undefined)?.usage ?? {};
      const context = (used.input_tokens ?? 0) + (used.cache_read_input_tokens ?? 0) + (used.cache_creation_input_tokens ?? 0);
      peakContext = Math.max(peakContext, context);
      for (const block of blocks.filter((c) => c.type === 'tool_use')) {
        calls++;
        byTool[block.name ?? '?'] = (byTool[block.name ?? '?'] ?? 0) + 1;
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
    errors,
    peakContext,
    usage,
    costUsd: result.total_cost_usd ?? 0,
    calls,
    turns: result.num_turns ?? 0,
    ms,
  };
}

type ToolBlock = { type: string; name?: string; content?: unknown; is_error?: boolean };

// The text of a tool result: a string, or a list of text blocks.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

