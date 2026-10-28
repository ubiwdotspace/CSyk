import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { resetMarker } from '../token/session.ts';

/** What Claude Code sends a hook on stdin; only the fields used here. */
export type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
};

/** A PreToolUse answer that turns the call down and tells the agent what to do instead. */
export type Denial = {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
};

// The extensions CSyk indexes, as in index/parse.ts; written out here so a
// hook, which runs on every tool call, does not load the parsers.
export const hookedExtensions: ReadonlySet<string> = new Set([
  '.ts', '.mts', '.cts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.dart',
]);

// Files longer than this are worth an outline before a whole read.
const largeFile = 400;
const identifier = /^[A-Za-z_]\w{2,}$/;
const servingDir = () => join(tmpdir(), 'csyk', 'serving');

/**
 * Notes that this process serves [root], so hooks redirect only to a
 * server that is there. Returns what removes the note.
 */
export function markServing(root: string): () => void {
  const file = join(servingDir(), `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
  mkdirSync(servingDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({ root, pid: process.pid }));
  return () => rmSync(file, { force: true });
}

/** The roots that a live CSyk server serves. */
export function servedRoots(): string[] {
  let names: string[];
  try {
    names = readdirSync(servingDir());
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const { root, pid } = JSON.parse(readFileSync(join(servingDir(), name), 'utf8')) as { root: string; pid: number };
      process.kill(pid, 0);
      return [root];
    } catch {
      return [];
    }
  });
}

const inside = (path: string, roots: readonly string[]) => roots.some((root) => path === root || path.startsWith(`${root}/`));

const deny = (reason: string): Denial => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/**
 * PreToolUse on Read: turns down a whole read of a source file over 400
 * lines in a served workspace, pointing at `outline` and `read`. A read
 * with an offset or a limit always passes.
 */
export function preRead(input: HookInput, roots: readonly string[]): Denial | undefined {
  const args = input.tool_input ?? {};
  const path = args.file_path;
  if (typeof path !== 'string' || args.offset !== undefined || args.limit !== undefined) return undefined;
  const absolute = resolve(input.cwd ?? process.cwd(), path);
  if (!hookedExtensions.has(extname(absolute)) || !inside(absolute, roots)) return undefined;
  const lines = readFileSync(absolute, 'utf8').split('\n').length;
  if (lines <= largeFile) return undefined;
  const root = roots.find((r) => inside(absolute, [r])) ?? '';
  const file = relative(root, absolute);
  return deny(
    `Reading a range with offset+limit is allowed and needs no search. ${file} has ${lines} lines: ` +
      `CSyk outline "${file}" lists its symbols with line ranges, and read <id> returns just one.`,
  );
}

/**
 * PreToolUse on Grep or Bash: turns down a search for a bare identifier in
 * a served workspace, pointing at `find` and `refs`. Phrases and regexes,
 * searches elsewhere, and shell commands this cannot follow pass.
 */
export function preGrep(input: HookInput, roots: readonly string[]): Denial | undefined {
  const cwd = input.cwd ?? process.cwd();
  const searches = input.tool_name === 'Grep' ? grepTool(input.tool_input ?? {}, cwd) : shellSearches(String(input.tool_input?.command ?? ''), cwd);
  const hit = searches.find(({ pattern, targets }) => identifier.test(pattern) && targets.every((t) => inside(t, roots)));
  if (!hit) return undefined;
  return deny(
    `"${hit.pattern}" is a name: CSyk find ${hit.pattern} gives its declaration and refs ${hit.pattern} its uses, ` +
      'resolved by the compiler, in fewer tokens. Text and regex searches pass through.',
  );
}

/** SessionStart or PreCompact: what the agent saw is gone, so CSyk shows source again. */
export function sessionReset(input: HookInput, roots: readonly string[]): void {
  const cwd = input.cwd ?? process.cwd();
  for (const root of [cwd, ...roots.filter((r) => inside(cwd, [r]))]) {
    const marker = resetMarker(root);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, String(Date.now()));
  }
}

type Search = { pattern: string; targets: string[] };

function grepTool(args: Record<string, unknown>, cwd: string): Search[] {
  if (typeof args.pattern !== 'string') return [];
  return [{ pattern: args.pattern, targets: [resolve(cwd, typeof args.path === 'string' ? args.path : '.')] }];
}

// Options of rg and grep that take the next word as their value.
const valued = new Set([
  '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--type-add', '-A', '-B', '-C', '-m', '--max-count',
  '-f', '--file', '-j', '--threads', '-M', '--max-columns', '-E', '--encoding', '-r', '--replace', '--sort', '--sortr',
  '-d', '--max-depth', '-D', '--include', '--exclude', '--exclude-dir',
]);

/** The rg and recursive grep searches in a shell [command], each with the folders it searches. */
export function shellSearches(command: string, cwd: string): Search[] {
  const commands = simpleCommands(command);
  if (!commands) return [];
  const searches: Search[] = [];
  let dir = cwd;
  for (const words of commands) {
    const [program = '', ...args] = words;
    if (program === 'cd' && args[0]) {
      dir = resolve(dir, args[0]);
      continue;
    }
    const tool = basename(program);
    // grep reads one file unless told to recurse; only folder searches count.
    const recursive = tool === 'rg' || args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
    if (!(tool === 'rg' || tool === 'grep' || tool === 'egrep') || !recursive) continue;
    let pattern: string | undefined;
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? '';
      if (arg === '-e' || arg === '--regexp') pattern ??= args[++i];
      else if (valued.has(arg) && !(tool !== 'rg' && arg === '-r')) i++;
      else if (arg.startsWith('-')) continue;
      else if (pattern === undefined) pattern = arg;
      else paths.push(arg);
    }
    if (pattern !== undefined) {
      searches.push({ pattern, targets: (paths.length ? paths : ['.']).map((p) => (isAbsolute(p) ? p : resolve(dir, p))) });
    }
  }
  return searches;
}

/**
 * The words of each simple command in [command], split at pipes, `;` and
 * `&&`/`||`, with quotes and escapes undone and redirections dropped; or
 * undefined for what this does not follow: substitutions, subshells,
 * heredocs.
 */
export function simpleCommands(command: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let redirectTarget = false;
  const endWord = () => {
    if (inWord && !redirectTarget) words.push(word);
    if (inWord) redirectTarget = false;
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';
    const next = command[i + 1] ?? '';
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '`' || (command[j] === '$' && command[j + 1] === '(')) return undefined;
        if (command[j] === '\\' && j + 1 < command.length) j++;
        word += command[j];
      }
      if (j >= command.length) return undefined;
      inWord = true;
      i = j;
    } else if (c === '\\') {
      word += next;
      inWord = true;
      i++;
    } else if (/\s/.test(c)) {
      endWord();
    } else if (c === '|' || c === ';' || c === '&') {
      endCommand();
      if (next === c) i++;
    } else if (c === '>' || c === '<') {
      if (next === '<' && c === '<') return undefined;
      // `2>`, `>>`, `>&`: the word before (a descriptor) and the target go.
      if (/^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      if (next === '>' || next === '&') i++;
      redirectTarget = true;
    } else if (c === '`' || c === '(' || c === ')' || (c === '$' && next === '(')) {
      return undefined;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

