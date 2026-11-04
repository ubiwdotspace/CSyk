#!/usr/bin/env node
import { resolve } from 'node:path';
import { formatFor } from './hooks/formats.ts';
import { postRead, preBash, preGrep, preRead, servedRoots, sessionReset } from './hooks/hooks.ts';

const usage = `Usage:
  csyk [serve] [workspace]   serve a workspace (the current folder by default) over MCP stdio
  csyk hook <name> [--agent claude,codex,cursor,antigravity]
                             run a hook: pre-bash, pre-read, pre-grep, post-read or session-reset, reading
                             and answering in the agent's format (Claude Code's by default)
  csyk setup                 in a terminal: pick the agents (Claude Code, Codex, Antigravity,
                             Cursor, OpenCode, Hermes Agent) and the projects, write their
                             configuration, and install missing language servers
  csyk setup [--write] [--user] [--hooks] [--agent claude,codex,antigravity,cursor,opencode,hermes]
                             print, or write, the configuration for the agents named (Claude Code
                             by default): the MCP server, a note the agent always reads and the
                             csyk skill, for this project or with --user for every project; for
                             Claude Code also CSyk grep in place of the built-in Grep, and with
                             --hooks the hooks that turn down whole-file reads and identifier greps`;

const [command = 'serve', ...rest] = process.argv.slice(2);

if (command === 'hook') await hook(rest[0] ?? '', rest.includes('--agent') ? (rest[rest.indexOf('--agent') + 1] ?? 'claude') : 'claude');
else if (command === 'setup') {
  const { setup } = await import('./setup/index.ts');
  await setup(rest);
} else if (command === 'serve' || !command.startsWith('-')) {
  const { serve } = await import('./server/main.ts');
  await serve(resolve(command === 'serve' ? (rest[0] ?? process.cwd()) : command));
} else console.log(usage);

// A hook reads the event on stdin and answers on stdout, each in [agent]'s format. Anything
// that goes wrong lets the tool call through: a hook must never block work.
async function hook(name: string, agent: string): Promise<void> {
  const format = formatFor(agent);
  let answer: unknown;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const input = format.read(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    const roots = servedRoots();
    if (name === 'session-reset') sessionReset(input, roots);
    if (name === 'post-read') postRead(input, roots);
    const denial =
      name === 'pre-bash' ? preBash(input, roots) : name === 'pre-read' ? preRead(input, roots) : name === 'pre-grep' ? preGrep(input, roots) : undefined;
    if (denial) answer = format.deny(denial.hookSpecificOutput.permissionDecisionReason);
  } catch {
    // Fail open.
  }
  if (answer !== undefined) process.stdout.write(JSON.stringify(answer));
}
