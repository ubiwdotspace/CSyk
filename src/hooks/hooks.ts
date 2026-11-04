import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { toPosix } from '../paths.ts';
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

// Files longer than this are worth a list of their symbols before a whole read.
const largeFile = 400;
const identifier = /^[A-Za-z_]\w{2,}$/;
const servingDir = () => join(tmpdir(), 'csyk', 'serving');

/**
 * Notes that this process serves [root], so hooks redirect only to a
 * server that is there. Returns what removes the note.
 */
export function markServing(root: string): () => void {
  root = real(root);
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

// A path with its symlinks followed, so a root and a hook's cwd compare
// alike (macOS's /var is /private/var); as given when it does not exist.
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// The folder the agent's tool runs in, as the served roots are written.
const cwdOf = (input: HookInput) => real(input.cwd ?? process.cwd());

// Paths compared with forward slashes, and on Windows without regard to case (C: and c:).
const comparable = (path: string) => (process.platform === 'win32' ? toPosix(path).toLowerCase() : path);
const inside = (path: string, roots: readonly string[]) =>
  roots.some((root) => {
    const [p, r] = [comparable(path), comparable(root)];
    return p === r || p.startsWith(`${r}/`);
  });

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
  const absolute = resolve(cwdOf(input), path);
  if (!hookedExtensions.has(extname(absolute)) || !inside(absolute, roots)) return undefined;
  const lines = readFileSync(absolute, 'utf8').split('\n').length;
  if (lines <= largeFile) return undefined;
  const root = roots.find((r) => inside(absolute, [r])) ?? '';
  const file = toPosix(relative(root, absolute));
  return deny(
    `Reading a range with offset+limit is allowed and needs no search. ${file} has ${lines} lines: ` +
      `CSyk read "${file}" lists its symbols with line ranges, and read <id> returns just one.`,
  );
}

/**
 * PreToolUse on Grep or Bash: turns down a search for a bare identifier in
 * a served workspace, pointing at `find` and `refs`. Phrases and regexes,
 * searches elsewhere, and shell commands this cannot follow pass.
 */
export function preGrep(input: HookInput, roots: readonly string[]): Denial | undefined {
  const cwd = cwdOf(input);
  const searches = input.tool_name === 'Grep' ? grepTool(input.tool_input ?? {}, cwd) : shellSearches(String(input.tool_input?.command ?? ''), cwd);
  const hit = searches.find(({ pattern, targets }) => identifier.test(pattern) && targets.every((t) => inside(t, roots)));
  if (!hit) return undefined;
  return deny(
    `"${hit.pattern}" is a name: CSyk find ${hit.pattern} gives its declaration and refs ${hit.pattern} its uses, ` +
      'resolved by the compiler, in fewer tokens. Text and regex searches pass through.',
  );
}

// Folders of dependencies and builds, as in workspace/workspace.ts: CSyk's
// grep leaves them out, so a shell search in them passes.
export const hookedDependencyDirs: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.dart_tool', 'vendor', 'target', '.venv', 'venv', '__pycache__', 'Pods', '.gradle',
]);

/**
 * PreToolUse on Bash: turns down a shell search of a served workspace's
 * files (rg, grep over files or folders, git grep), with the CSyk grep
 * that finds the same matches. With the built-in Grep turned off, agents
 * search with the shell instead, which costs more tokens and names no
 * function. A grep of a command's output, searches outside the workspace
 * or in its dependencies, and commands this cannot follow pass.
 */
export function preBash(input: HookInput, roots: readonly string[]): Denial | undefined {
  const cwd = cwdOf(input);
  const hit = fileSearches(String(input.tool_input?.command ?? ''), cwd).find(({ targets }) =>
    targets.every((t) => inside(t, roots) && !toPosix(t).split('/').some((part) => hookedDependencyDirs.has(part))),
  );
  if (!hit) return undefined;
  const root = roots.find((r) => inside(hit.targets[0] ?? '', [r])) ?? cwd;
  const paths = hit.targets.map((t) => toPosix(relative(root, t))).filter(Boolean);
  const args = [
    `pattern: ${JSON.stringify(hit.pattern)}`,
    ...(hit.literal ? ['literal: true'] : []),
    ...(paths.length === 1 ? [`path: ${JSON.stringify(paths[0])}`] : []),
    ...(hit.glob ? [`glob: ${JSON.stringify(hit.glob)}`] : []),
  ];
  return deny(
    `Search the code with CSyk grep (${args.join(', ')}): the same matches, each with the function it is in, ` +
      'in fewer tokens. A grep of a command\'s output still runs.',
  );
}

type FileSearch = Search & { literal: boolean; glob?: string };

/**
 * The searches of files in a shell [command]: rg, git grep, and grep given
 * files or told to recurse, each as a ripgrep pattern (grep's basic `\|`
 * and `\(…\)`, -i and -w written into it) with the paths it searches.
 */
export function fileSearches(command: string, cwd: string): FileSearch[] {
  const commands = simpleCommands(command);
  if (!commands) return [];
  const searches: FileSearch[] = [];
  let dir = cwd;
  for (const words of commands) {
    let [program = '', ...args] = words;
    if (program === 'cd' && args[0]) {
      dir = resolve(dir, args[0]);
      continue;
    }
    const gitGrep = basename(program) === 'git' && args[0] === 'grep';
    if (gitGrep) [program = '', ...args] = args;
    const tool = basename(program);
    if (!['rg', 'grep', 'egrep', 'fgrep'].includes(tool)) continue;
    let pattern: string | undefined;
    let glob: string | undefined;
    const paths: string[] = [];
    const flags = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? '';
      if (arg === '--') continue;
      if (arg === '-e' || arg === '--regexp') pattern ??= args[++i];
      else if (arg === '-g' || arg === '--glob' || arg === '--include') glob ??= args[++i];
      else if (arg.startsWith('--include=') || arg.startsWith('--glob=')) glob ??= arg.slice(arg.indexOf('=') + 1);
      else if (takesValue(tool, arg)) i++;
      else if (arg.startsWith('--')) flags.add(arg);
      else if (arg.startsWith('-')) for (const f of arg.slice(1)) flags.add(f);
      else if (pattern === undefined) pattern = arg;
      else paths.push(arg);
    }
    const recursive = tool === 'rg' || gitGrep || flags.has('r') || flags.has('R') || flags.has('--recursive');
    // grep with no file reads its input: a pipe, not the code.
    if (pattern === undefined || (!recursive && paths.length === 0)) continue;
    const fixed = tool === 'fgrep' || flags.has('F') || flags.has('--fixed-strings');
    const extended = tool === 'rg' || tool === 'egrep' || flags.has('E') || flags.has('P') || flags.has('--extended-regexp');
    const word = flags.has('w') || flags.has('--word-regexp');
    const nocase = flags.has('i') || flags.has('--ignore-case');
    // A fixed string stays literal unless -w or -i need a regex around it.
    const literal = fixed && !word && !nocase;
    let regex = fixed ? (literal ? pattern : escapeRegex(pattern)) : extended ? pattern : fromBasic(pattern);
    if (!literal && word) regex = `\\b(?:${regex})\\b`;
    if (!literal && nocase) regex = `(?i)${regex}`;
    searches.push({
      pattern: regex,
      literal,
      ...(glob ? { glob } : {}),
      targets: (paths.length ? paths : ['.']).map((p) => toPosix(isAbsolute(p) ? p : resolve(dir, p))),
    });
  }
  return searches;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A grep basic regex as ripgrep reads one: there `\|`, `\(`, `\)`, `\{`,
// `\}`, `\+` and `\?` are the operators and the bare characters literal,
// the other way round from ripgrep.
function fromBasic(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    const next = pattern[i + 1] ?? '';
    if (c === '\\' && '|(){}+?'.includes(next) && next) {
      out += next;
      i++;
    } else if (c === '\\') {
      out += c + next;
      i++;
    } else out += '|(){}+?'.includes(c) ? `\\${c}` : c;
  }
  return out;
}

/** SessionStart or PreCompact: what the agent saw is gone, so CSyk shows source again. */
export function sessionReset(input: HookInput, roots: readonly string[]): void {
  const cwd = cwdOf(input);
  for (const root of [cwd, ...roots.filter((r) => inside(cwd, [r]))]) {
    const marker = resetMarker(root);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, String(Date.now()));
  }
}

type Search = { pattern: string; targets: string[] };

function grepTool(args: Record<string, unknown>, cwd: string): Search[] {
  if (typeof args.pattern !== 'string') return [];
  return [{ pattern: args.pattern, targets: [toPosix(resolve(cwd, typeof args.path === 'string' ? args.path : '.'))] }];
}

// Options that take the next word as their value: of both, then of rg only,
// where grep reads the same letters as flags (-E extended, -r recursive).
const valued = new Set([
  '-g', '--glob', '--iglob', '--type', '--type-not', '--type-add', '-A', '-B', '-C', '-m', '--max-count',
  '-f', '--file', '--threads', '--max-columns', '--encoding', '--replace', '--sort', '--sortr',
  '-d', '--max-depth', '-D', '--include', '--exclude', '--exclude-dir',
]);
const valuedInRg = new Set(['-t', '-T', '-j', '-M', '-E', '-r']);
const takesValue = (tool: string, arg: string) => valued.has(arg) || (tool === 'rg' && valuedInRg.has(arg));

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
      else if (takesValue(tool, arg)) i++;
      else if (arg.startsWith('-')) continue;
      else if (pattern === undefined) pattern = arg;
      else paths.push(arg);
    }
    if (pattern !== undefined) {
      searches.push({ pattern, targets: (paths.length ? paths : ['.']).map((p) => toPosix(isAbsolute(p) ? p : resolve(dir, p))) });
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
        // In double quotes a backslash escapes only these; `"a\|b"` keeps it, as bash does.
        if (command[j] === '\\' && j + 1 < command.length && '$`"\\\n'.includes(command[j + 1] ?? '')) j++;
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

