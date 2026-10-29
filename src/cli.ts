#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { note, skill } from './guide.ts';
import { preGrep, preRead, servedRoots, sessionReset, type HookInput } from './hooks/hooks.ts';

const usage = `Usage:
  csyk [serve] [workspace]   serve a workspace (the current folder by default) over MCP stdio
  csyk hook <name>           run a Claude Code hook: pre-read, pre-grep or session-reset
  csyk setup [--write] [--user] [--hooks]
                             print, or write, the Claude Code configuration: the MCP server, CSyk
                             grep in place of the built-in Grep, a CLAUDE.md note (a rules file with
                             --user) and the csyk skill; --hooks adds the hooks that turn down
                             whole-file reads and identifier greps`;

const [command = 'serve', ...rest] = process.argv.slice(2);

if (command === 'hook') await hook(rest[0] ?? '');
else if (command === 'setup') setup(rest.includes('--write'), rest.includes('--user'), rest.includes('--hooks'));
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

// The files `csyk setup` writes: in this project, or with --user for every project.
function setup(write: boolean, user: boolean, withHooks: boolean): void {
  const csyk = self();
  const [program = 'csyk', ...args] = csyk.split(' ');
  const mcp = { mcpServers: { csyk: { command: program, args: [...args, 'serve'] } } };
  const run = (name: string) => [{ type: 'command', command: `${csyk} hook ${name}` }];
  const hooks = {
    ...(withHooks
      ? {
          PreToolUse: [
            { matcher: 'Read', hooks: run('pre-read') },
            { matcher: 'Grep|Bash', hooks: run('pre-grep') },
          ],
        }
      : {}),
    SessionStart: [{ hooks: run('session-reset') }],
    PreCompact: [{ hooks: run('session-reset') }],
  };
  // CSyk grep searches as Grep does and names each hit's symbol; with both listed, agents use
  // both, and Grep's tool description costs more tokens on every turn than all of CSyk's tools.
  const permissions = { deny: ['Grep'] };
  const base = user ? join(homedir(), '.claude') : '.claude';
  const settings = join(base, 'settings.json');
  const skillFile = join(base, 'skills', 'csyk', 'SKILL.md');
  // The note goes where it is always in context: CLAUDE.md here, a rules file for every project.
  const noteFile = user ? join(base, 'rules', 'csyk.md') : 'CLAUDE.md';
  const addMcp = user ? `claude mcp add --scope user csyk -- ${csyk} serve` : `claude mcp add csyk -- ${csyk} serve`;
  if (!write) {
    if (!user) console.log(`.mcp.json (or: ${addMcp})\n${JSON.stringify(mcp, null, 2)}\n`);
    else console.log(`MCP server, for every project:\n  ${addMcp}\n`);
    console.log(`${settings}\n${JSON.stringify({ permissions, hooks }, null, 2)}\n`);
    console.log(`${noteFile}\n${note}\n`);
    console.log(`${skillFile}: the csyk skill (how to use the tools in few turns)\n`);
    console.log(`Run "csyk setup --write${user ? ' --user' : ''}" to write them.`);
    return;
  }
  if (!user) merge('.mcp.json', (config) => ({ ...config, mcpServers: { ...asRecord(config.mcpServers), ...mcp.mcpServers } }));
  merge(settings, (config) => {
    const existing = asRecord(config.hooks);
    const merged: Record<string, unknown> = { ...existing };
    for (const [event, entries] of Object.entries(hooks)) {
      const current = Array.isArray(existing[event]) ? (existing[event] as unknown[]) : [];
      // An entry already running the same command is not added twice.
      const fresh = entries.filter((e) => !JSON.stringify(current).includes(JSON.stringify(e.hooks[0]?.command)));
      merged[event] = [...current, ...fresh];
    }
    const deny = asRecord(config.permissions).deny;
    const denied = Array.isArray(deny) ? deny : [];
    const allDenied = [...denied, ...permissions.deny.filter((rule) => !denied.includes(rule))];
    return { ...config, permissions: { ...asRecord(config.permissions), deny: allDenied }, hooks: merged };
  });
  writeSection(noteFile, note);
  mkdirSync(dirname(skillFile), { recursive: true });
  writeFileSync(skillFile, skill);
  const wrote = [user ? undefined : '.mcp.json', settings, noteFile, skillFile].filter(Boolean).join(', ');
  console.log(`Wrote ${wrote}.${user ? `\nAdd the MCP server for every project with:\n  ${addMcp}` : ''}`);
}

// Puts [text] in [path] between CSyk's markers, replacing what an earlier setup wrote there.
function writeSection(path: string, text: string): void {
  const start = '<!-- csyk:start -->';
  const end = '<!-- csyk:end -->';
  const block = `${start}\n${text}\n${end}`;
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const at = current.indexOf(start);
  const next =
    at >= 0
      ? current.slice(0, at) + block + current.slice(current.indexOf(end, at) + end.length)
      : `${current}${current && !current.endsWith('\n\n') ? (current.endsWith('\n') ? '\n' : '\n\n') : ''}${block}\n`;
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, next);
}

function merge(path: string, change: (config: Record<string, unknown>) => Record<string, unknown>): void {
  const config = existsSync(path) ? asRecord(JSON.parse(readFileSync(path, 'utf8'))) : {};
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(change(config), null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
