import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type Scope = 'project' | 'user';
/** One thing setup does for an agent: a file it writes, or a command it runs. */
export type Step = { target: string; preview: string; apply: () => void };
/**
 * An agent CSyk can set up. Every agent gets the same two: the MCP server and the note always in
 * its context. Where the agent allows it, also the hooks: `session-reset`, so CSyk
 * shows code again once the agent's context no longer holds it, and `pre-bash`, so a shell search
 * of the code goes through CSyk `grep`. [gaps] says what this agent cannot be given, and why.
 */
export type Agent = {
  id: string;
  name: string;
  found: () => boolean;
  steps: (scope: Scope, hooks: boolean) => Step[];
  gaps?: string[];
};

export const home = (...parts: string[]) => join(homedir(), ...parts);

// How this install of CSyk is started: the package's command, or node on a
// clone's build (hooks start in half the time) or else on the CLI's source.
export function self(): string[] {
  const script = process.argv[1] ?? '';
  if (!script.endsWith('.ts')) return ['csyk'];
  const built = resolve(dirname(script), '../dist/cli.js');
  return ['node', existsSync(built) ? built : resolve(script)];
}

// How an agent starts the CSyk server: as self() does, but on Windows the installed command is
// csyk.cmd, which an agent starting servers without a shell runs only through cmd /c. Hooks keep
// self(): Claude Code runs them in Git Bash, which finds csyk and would mangle a /c.
export function launcher(): string[] {
  const csyk = self();
  return process.platform === 'win32' && csyk[0] === 'csyk' ? ['cmd', '/c', 'csyk'] : csyk;
}

/** The command an agent runs for CSyk's hook [name], in the input and answer format of [agent]. */
export function hookCommand(name: string, agent: string): string {
  return [...self(), 'hook', name, ...(agent === 'claude' ? [] : ['--agent', agent])].join(' ');
}

// Something setup cannot write: what to do by hand, printed when it runs.
export function hintStep(target: string, preview: string, text: string): Step {
  return { target, preview, apply: () => console.log(`${target}: ${preview}\n\n${text}\n`) };
}

export function jsonStep(path: string, [section, name]: [string, string], value: unknown): Step {
  return {
    target: path,
    preview: JSON.stringify({ [section]: { [name]: value } }, null, 2),
    apply: () => merge(path, (config) => ({ ...config, [section]: { ...asRecord(config[section]), [name]: value } })),
  };
}

export function sectionStep(path: string, text: string): Step {
  return { target: path, preview: text, apply: () => writeSection(path, text) };
}

/**
 * Removes the csyk skill an earlier setup wrote at [path], and its folder once empty; nothing when
 * there is none, or the file there is not CSyk's. No agent loaded the skill in about 2,700
 * benchmark sessions, and its listing cost tokens on every request.
 */
export function staleSkillStep(path: string): Step[] {
  if (!existsSync(path) || !readFileSync(path, 'utf8').startsWith('---\nname: csyk\n')) return [];
  return [
    {
      target: path,
      preview: 'remove the csyk skill an earlier setup wrote: agents never loaded it',
      apply: () => {
        rmSync(path);
        const folder = dirname(path);
        if (readdirSync(folder).length === 0) rmSync(folder, { recursive: true });
      },
    },
  ];
}

export function fileStep(path: string, text: string): Step {
  return { target: path, preview: text.length > 300 ? `${text.split('\n').slice(0, 4).join('\n')}\n…` : text, apply: () => write(path, text) };
}

/**
 * Adds [entries] to the hook lists in the JSON file at [path], under [key] (`hooks` by default),
 * keeping every other hook; an entry already running the same command is not added twice.
 */
export function hooksStep(path: string, entries: Record<string, Record<string, unknown>[]>, extra: Record<string, unknown> = {}, key = 'hooks'): Step {
  return {
    target: path,
    preview: JSON.stringify({ ...extra, [key]: entries }, null, 2),
    apply: () => merge(path, (config) => ({ ...config, ...extra, [key]: withHooks(asRecord(config[key]), entries) })),
  };
}

export function withHooks(existing: Record<string, unknown>, entries: Record<string, Record<string, unknown>[]>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [event, list] of Object.entries(entries)) {
    const current = Array.isArray(existing[event]) ? (existing[event] as unknown[]) : [];
    const fresh = list.filter((e) => !JSON.stringify(current).includes(JSON.stringify(commandOf(e))));
    merged[event] = [...current, ...fresh];
  }
  return merged;
}

// The command an entry runs: `{ command }` (Cursor) or `{ hooks: [{ command }] }` (Claude Code, Codex, Antigravity).
const commandOf = (entry: Record<string, unknown>) =>
  entry.command ?? (Array.isArray(entry.hooks) ? (entry.hooks[0] as { command?: unknown } | undefined)?.command : undefined);

/** [toml] with the table [block] starts replaced by [block], its subtables included, or [block] added at the end. */
export function withTomlTable(toml: string, block: string): string {
  const header = block.split('\n')[0] ?? '';
  const name = header.slice(1, -1);
  const lines = toml.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) return `${toml}${toml && !toml.endsWith('\n') ? '\n' : ''}${toml ? '\n' : ''}${block}\n`;
  const ownHeader = (line: string) => line === header || line.startsWith(`[${name}.`);
  let end = at + 1;
  while (end < lines.length && !(lines[end]?.startsWith('[') && !ownHeader(lines[end] ?? ''))) end++;
  const rest = lines.slice(end);
  return [...lines.slice(0, at), ...block.split('\n'), ...(rest.length > 0 ? ['', ...rest] : [''])].join('\n');
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
  write(path, next);
}

export function merge(path: string, change: (config: Record<string, unknown>) => Record<string, unknown>): void {
  const config = existsSync(path) ? asRecord(JSON.parse(readFileSync(path, 'utf8'))) : {};
  write(path, `${JSON.stringify(change(config), null, 2)}\n`);
}

export function write(path: string, text: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
