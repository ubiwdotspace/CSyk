#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { preGrep, preRead, servedRoots, sessionReset, type HookInput } from './hooks/hooks.ts';

const usage = `Usage:
  csyk [serve] [workspace]   serve a workspace (the current folder by default) over MCP stdio
  csyk hook <name>           run a Claude Code hook: pre-read, pre-grep or session-reset
  csyk setup [--write]       print, or write into this folder, the Claude Code configuration`;

const [command = 'serve', ...rest] = process.argv.slice(2);

if (command === 'hook') await hook(rest[0] ?? '');
else if (command === 'setup') setup(rest.includes('--write'));
else if (command === 'serve' || !command.startsWith('-')) {
  const { serve } = await import('./server/main.ts');
  await serve(resolve(command === 'serve' ? (rest[0] ?? process.cwd()) : command));
} else console.log(usage);

// A hook reads the event on stdin and answers on stdout. Anything that goes
// wrong lets the tool call through: a hook must never block work.
async function hook(name: string): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
    const roots = servedRoots();
    if (name === 'session-reset') return sessionReset(input, roots);
    const answer = name === 'pre-read' ? preRead(input, roots) : name === 'pre-grep' ? preGrep(input, roots) : undefined;
    if (answer) process.stdout.write(JSON.stringify(answer));
  } catch {
    // Fail open.
  }
}

// How this install of CSyk is started: the package's command, or node on a
// clone's build (hooks start in half the time) or else on this file.
function self(): string {
  const script = process.argv[1] ?? '';
  if (!script.endsWith('.ts')) return 'csyk';
  const built = resolve(dirname(script), '../dist/cli.js');
  return `node ${existsSync(built) ? built : resolve(script)}`;
}

function setup(write: boolean): void {
  const csyk = self();
  const [program = 'csyk', ...args] = csyk.split(' ');
  const mcp = { mcpServers: { csyk: { command: program, args: [...args, 'serve'] } } };
  const run = (name: string) => [{ type: 'command', command: `${csyk} hook ${name}` }];
  const hooks = {
    PreToolUse: [
      { matcher: 'Read', hooks: run('pre-read') },
      { matcher: 'Grep|Bash', hooks: run('pre-grep') },
    ],
    SessionStart: [{ hooks: run('session-reset') }],
    PreCompact: [{ hooks: run('session-reset') }],
  };
  const guide = [
    '## Code search',
    '',
    'Use the CSyk tools for code: `find` a symbol by name, `outline` a file, `read` one',
    'symbol, `refs` and `calls` for its uses and callers, `impact` after edits, `grep` for',
    'text. Read a whole file only when you need most of it.',
  ].join('\n');
  if (!write) {
    console.log(`.mcp.json (or: claude mcp add csyk -- ${csyk} serve)\n${JSON.stringify(mcp, null, 2)}\n`);
    console.log(`.claude/settings.json\n${JSON.stringify({ hooks }, null, 2)}\n`);
    console.log(`CLAUDE.md\n${guide}\n\nRun "csyk setup --write" to merge the first two into this folder.`);
    return;
  }
  merge('.mcp.json', (config) => ({ ...config, mcpServers: { ...asRecord(config.mcpServers), ...mcp.mcpServers } }));
  merge(join('.claude', 'settings.json'), (config) => {
    const existing = asRecord(config.hooks);
    const merged: Record<string, unknown> = { ...existing };
    for (const [event, entries] of Object.entries(hooks)) {
      const current = Array.isArray(existing[event]) ? (existing[event] as unknown[]) : [];
      // An entry already running the same command is not added twice.
      const fresh = entries.filter((e) => !JSON.stringify(current).includes(JSON.stringify(e.hooks[0]?.command)));
      merged[event] = [...current, ...fresh];
    }
    return { ...config, hooks: merged };
  });
  console.log(`Wrote .mcp.json and .claude/settings.json; add this to CLAUDE.md:\n\n${guide}`);
}

function merge(path: string, change: (config: Record<string, unknown>) => Record<string, unknown>): void {
  const config = existsSync(path) ? asRecord(JSON.parse(readFileSync(path, 'utf8'))) : {};
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(change(config), null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
