import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { note, skill } from '../../src/guide.ts';
import { buildGraphifyGraph, graphifyFrom, graphifyRules } from '../adapters/graphify.ts';
import { npmToolBin, uvToolBin } from '../adapters/mcp.ts';
import { serenaFrom, serenaOptions } from '../adapters/serena.ts';
import { watchResources } from '../harness/resources.ts';
import { countTokens } from '../harness/tokens.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Skill too, as every interactive session has it (with Claude Code's own skills listed): runs
// before 2026-11-03 left it out, so no setup could load a skill.
const tools = 'Read,Grep,Glob,Skill';

/**
 * What an agent is given besides Read, Grep, Glob and Skill, and the [files]
 * written into the workspace before it starts, such as a skill.
 */
export type Setup = {
  mcp?: Record<string, unknown>;
  allowed: string[];
  /** Built-in tools besides Read, Grep and Glob, such as LSP. */
  tools?: string[];
  /** A plugin's manifest, loaded with --plugin-dir. */
  plugin?: Record<string, unknown>;
  settings?: unknown;
  guide?: string;
  files?: Record<string, string>;
  /** Work done before the session and not counted in it, such as building a graph. */
  prepare?: () => Promise<void>;
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
  /** Peak memory of Claude Code and every server it started, together. */
  peakMb: number;
  /** CPU time of Claude Code and every server it started. */
  cpuSeconds: number;
};

/**
 * The setups for a workspace at [workspace]: b0 (Claude Code's built-in
 * tools only), CSyk in several configurations, run from the build that
 * buildCsyk makes, and Serena, Graphify, the official TypeScript LSP plugin
 * and CodeGraph as their own Claude Code setups install them.
 */
export function setups(workspace: string): Record<string, Setup> {
  const csyk = ['node', join(root, 'dist/cli.js')];
  const hook = (name: string) => [{ type: 'command', command: `${csyk.join(' ')} hook ${name}` }];
  return {
    // Serena as `serena setup claude-code` registers it, with its default agent interface
    // and the hooks its documentation strongly recommends for Claude Code. Its project
    // folder is kept between issues, as it would be between sessions. A getter, so only
    // a run of this setup needs uv.
    get serena(): Setup {
      const bin = uvToolBin(serenaFrom);
      const run = (name: string) => [
        { matcher: '', hooks: [{ type: 'command', command: `${join(bin, 'serena-hooks')} ${name} --client=claude-code` }] },
      ];
      return {
        mcp: { serena: { command: join(bin, 'serena'), args: ['start-mcp-server', ...serenaOptions, '--project-from-cwd'] } },
        allowed: ['mcp__serena'],
        settings: { hooks: { PreToolUse: run('remind'), SessionStart: run('activate'), SessionEnd: run('cleanup') } },
        prepare: () => exclude(workspace, '.serena/'),
      };
    },
    // Graphify as `graphify claude install` sets it up: the rules it writes into CLAUDE.md
    // and its hooks on Bash, Grep, Read and Glob, with the graph in graphify-out/ brought up
    // to date for each issue. No setup has a shell, so its CLI is reached through its MCP server.
    get graphify(): Setup {
      const bin = uvToolBin(graphifyFrom);
      const guard = (matcher: string, kind: string) => ({
        matcher,
        hooks: [{ type: 'command', command: `${join(bin, 'graphify')} hook-guard ${kind}`, timeout: 10 }],
      });
      return {
        mcp: { graphify: { command: join(bin, 'python'), args: ['-m', 'graphify.serve', join(workspace, 'graphify-out/graph.json')] } },
        allowed: ['mcp__graphify'],
        settings: { hooks: { PreToolUse: [guard('Bash|Grep', 'search'), guard('Read|Glob', 'read')] } },
        guide:
          `${graphifyRules()}\n\nIn this session the graph is served by the graphify MCP tools: query_graph for ` +
          '`graphify query`, get_node and get_neighbors for `graphify explain`, shortest_path for `graphify path`.',
        // The graph is built anew for each issue's commit (Graphify refuses an update that
        // shrinks it); its cache of parsed files is kept.
        prepare: async () => {
          await exclude(workspace, 'graphify-out/');
          for (const file of ['graph.json', 'manifest.json']) await rm(join(workspace, 'graphify-out', file), { force: true });
          await buildGraphifyGraph(workspace, workspace);
        },
      };
    },
    // The official typescript-lsp plugin (claude-plugins-official): the same server entry as
    // its marketplace listing, loaded as a plugin folder, for Claude Code's LSP tool. Its README
    // installs typescript-language-server with `typescript`; TypeScript 6 here, since 7 has no
    // tsserver for it to run and its initialize fails.
    get 'lsp-plugin'(): Setup {
      const bin = npmToolBin('typescript-language-server@6.0.2', 'typescript@6.0.3');
      const languages = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mts: 'typescript', cts: 'typescript', mjs: 'javascript', cjs: 'javascript' };
      const server = {
        command: join(bin, 'typescript-language-server'),
        args: ['--stdio'],
        extensionToLanguage: Object.fromEntries(Object.entries(languages).map(([ext, id]) => [`.${ext}`, id])),
      };
      return { allowed: [], tools: ['LSP'], plugin: { name: 'typescript-lsp', version: '1.0.0', lspServers: { typescript: server } } };
    },
    // CodeGraph as `codegraph install --yes` sets it up for Claude Code: its MCP server, always
    // loaded, allowed, the block it writes into CLAUDE.md and its prompt hook, with the graph
    // built anew for each issue (`codegraph init`). Telemetry off: nothing leaves the machine.
    get codegraph(): Setup {
      const bin = npmToolBin('@colbymchenry/codegraph@1.6.2');
      const codegraph = join(bin, 'codegraph');
      const env = { CODEGRAPH_TELEMETRY: '0' };
      return {
        mcp: { codegraph: { type: 'stdio', command: codegraph, args: ['serve', '--mcp'], alwaysLoad: true, env } },
        allowed: ['mcp__codegraph__*'],
        settings: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `CODEGRAPH_TELEMETRY=0 ${codegraph} prompt-hook` }] }] } },
        guide: codegraphBlock(bin),
        prepare: async () => {
          await exclude(workspace, '.codegraph/');
          await rm(join(workspace, '.codegraph'), { recursive: true, force: true });
          await promisify(execFile)(codegraph, ['init', '--yes'], { cwd: workspace, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
        },
      };
    },
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
    // csyk-lean with answers that never turn short in a long session, to measure that rule.
    'csyk-nolong': {
      mcp: { csyk: { command: csyk[0], args: [...csyk.slice(1), 'serve', workspace], env: { CSYK_LONG_SESSION: 'Infinity' } } },
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

// The block `codegraph install` writes into CLAUDE.md, read from the installed release.
function codegraphBlock(bin: string): string {
  const template = join(bin, '../@colbymchenry', `codegraph-${process.platform}-${process.arch}`, 'lib/dist/installer/instructions-template.js');
  return (createRequire(import.meta.url)(template) as { CODEGRAPH_INSTRUCTIONS_BLOCK: string }).CODEGRAPH_INSTRUCTIONS_BLOCK;
}

// Keeps [pattern] out of git in [workspace], so the checkout's clean before the next issue leaves it.
async function exclude(workspace: string, pattern: string): Promise<void> {
  const file = join(workspace, '.git/info/exclude');
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text.split('\n').includes(pattern)) {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  }
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
  const pluginDir = join(scratch, `plugin-${process.pid}`);
  if (setup.plugin) {
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
    await writeFile(join(pluginDir, '.claude-plugin/plugin.json'), JSON.stringify(setup.plugin));
  }
  const given = [tools, ...(setup.tools ?? [])].join(',');
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
    given,
    '--allowedTools',
    [given, ...setup.allowed].join(','),
    '--strict-mcp-config',
    '--mcp-config',
    mcpFile,
    '--no-session-persistence',
    ...(process.env.ANTHROPIC_API_KEY ? ['--bare'] : ['--setting-sources', 'project']),
    ...(setup.settings ? ['--settings', JSON.stringify(setup.settings)] : []),
    ...(setup.plugin ? ['--plugin-dir', pluginDir] : []),
    ...(setup.guide ? ['--append-system-prompt', setup.guide] : []),
  ];
  const start = performance.now();
  let watch: ReturnType<typeof watchResources> | undefined;
  const lines = await new Promise<string[]>((done, fail) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    if (child.pid) watch = watchResources(child.pid);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', fail);
    child.on('close', () => done(out.split('\n').filter(Boolean)));
  });
  const ms = performance.now() - start;
  const { peakMb, cpuSeconds } = (await watch?.stop()) ?? { peakMb: 0, cpuSeconds: 0 };
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
    peakMb,
    cpuSeconds,
  };
}

type ToolBlock = { type: string; name?: string; content?: unknown; is_error?: boolean };

// The text of a tool result: a string, or a list of text blocks.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

