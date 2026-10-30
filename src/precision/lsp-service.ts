import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import type { Tree } from 'web-tree-sitter';
import { inDocLink, isCodeAt, parseFile } from '../index/parse.ts';
import type { CodeSymbol } from '../index/symbols.ts';
import { listFiles } from '../workspace/files.ts';
import { LspClient, type Position, type Span } from './lsp-client.ts';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// A command a dependency ships, run with this Node, found from the package
// itself so it works from a clone and from an install alike.
function packageCommand(pkg: string, name: string, args: string[]): { command: string; args: string[] } {
  const manifest = require.resolve(`${pkg}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: string | Record<string, string> };
  const script = typeof bin === 'string' ? bin : (bin[name] ?? '');
  return { command: process.execPath, args: [join(dirname(manifest), script), ...args] };
}

/** A language server CSyk can start, and the files it answers for. */
export type ServerSpec = {
  name: string;
  extensions: ReadonlySet<string>;
  /** The command to start it, or undefined when it is not installed. */
  command: () => { command: string; args: string[] } | undefined;
  /** Work done once it starts, such as loading every project. */
  warmup?: (lsp: LspClient, root: string) => Promise<void>;
  /** Interfaces name no implementations (Go): ask the server which a method satisfies. */
  implicitInterfaces?: boolean;
  /**
   * The server's references of a method span every implementation of the
   * interface or base method it implements (tsc, Dart); its call hierarchy
   * does too, so a method's callers include what that search adds.
   */
  hierarchyReferences?: boolean;
  /**
   * The server's own reference search covers the whole workspace and is fast
   * once it has analyzed it (Dart), so it replaces resolving each mention.
   */
  completeReferences?: boolean;
};

// The first of [names] found on PATH or in Go's install folder.
export function onPath(...names: string[]): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(process.env.GOPATH ?? join(homedir(), 'go'), 'bin')];
  for (const name of names) {
    for (const dir of dirs) {
      const path = join(dir, name);
      if (dir && existsSync(path)) return path;
    }
  }
  return undefined;
}

const tsExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export const servers: readonly ServerSpec[] = [
  {
    name: 'tsc',
    extensions: tsExtensions,
    hierarchyReferences: true,
    command: () => packageCommand('typescript', 'tsc', ['--lsp', '--stdio']),
    // A symbol request in one file of each tsconfig project makes the server load it.
    warmup: async (lsp, root) => {
      const sources = await listFiles(root, tsExtensions);
      const configs = (await listFiles(root, new Set(['.json']))).filter((f) => basename(f) === 'tsconfig.json');
      for (const config of configs) {
        const dir = dirname(config);
        const file = sources.find((f) => dir === '.' || f.startsWith(`${dir}/`));
        if (file) await lsp.documentSymbols(file);
      }
    },
  },
  {
    name: 'pyright',
    extensions: new Set(['.py']),
    command: () => packageCommand('pyright', 'pyright-langserver', ['--stdio']),
  },
  {
    name: 'gopls',
    extensions: new Set(['.go']),
    implicitInterfaces: true,
    command: () => {
      const gopls = onPath('gopls');
      return gopls ? { command: gopls, args: [] } : undefined;
    },
  },
  {
    name: 'dart',
    extensions: new Set(['.dart']),
    hierarchyReferences: true,
    completeReferences: true,
    command: () => {
      const dart = onPath('dart');
      return dart ? { command: dart, args: ['language-server', '--protocol=lsp', '--client-id=csyk'] } : undefined;
    },
  },
];

/** How to install each server CSyk cannot start, for `status`. */
export const installHints: Record<string, string> = {
  gopls: 'go install golang.org/x/tools/gopls@latest',
  dart: 'install the Dart or Flutter SDK',
};

/** The server for [file]'s language, if CSyk has one. */
export function serverFor(file: string): ServerSpec | undefined {
  return servers.find((s) => s.extensions.has(extname(file)));
}

// LSP requests in flight at once while resolving mentions.
const concurrency = 16;
// How long one search resolves mentions before answering with what it has.
const searchMs = 5000;

/** References found, and how far a search cut short by its deadline got. */
export type References = { found: Position[]; partial?: { resolved: number; total: number } };

// How far apart two files are: 0 for the same file, then the folders that
// do not share a path.
function distance(from: string, to: string): number {
  if (from === to) return 0;
  const a = from.split('/');
  const b = to.split('/');
  let shared = 0;
  while (shared < a.length - 1 && a[shared] === b[shared]) shared++;
  return 1 + (a.length - 1 - shared) + (b.length - 1 - shared);
}

/** Precision from one language server, started with its warm-up done. */
export class LspService {
  readonly root: string;
  readonly spec: ServerSpec;
  private readonly lsp: LspClient;
  private readonly definitions = new Map<string, Promise<Span[]>>();
  private readonly mentions = new Map<string, Promise<Mention[]>>();

  private constructor(root: string, spec: ServerSpec, lsp: LspClient) {
    this.root = root;
    this.spec = spec;
    this.lsp = lsp;
  }

  /** Starts [spec]'s server, or undefined when it is not installed. */
  static async start(root: string, spec: ServerSpec): Promise<LspService | undefined> {
    const launch = spec.command();
    if (!launch || !existsSync(launch.command)) return undefined;
    const lsp = await LspClient.start(launch.command, launch.args, root);
    await spec.warmup?.(lsp, root);
    return new LspService(root, spec, lsp);
  }

  /**
   * Where the name at [at] is declared, inside the workspace. Answers are
   * kept until a file changes: callers two levels up ask about the same
   * mentions many times.
   */
  definition(at: Position): Promise<Span[]> {
    const key = `${at.file}:${at.line}:${at.character}`;
    let found = this.definitions.get(key);
    if (!found) {
      if (this.definitions.size > 500_000) this.definitions.clear();
      found = this.lsp.definition(at);
      this.definitions.set(key, found);
    }
    return found;
  }

  /**
   * Every reference to [symbol]: each place its name is written in code
   * (comments and strings left out, documentation links kept) that the
   * server resolves to its declaration. Each file resolves in its own
   * project, so references cross packages. Names written under another
   * name (`import { a as b }`) are not followed. The [overloads] (and any
   * other declarations passed there) count as the symbol: a use of any is a
   * use of it. With [viaSupertypes], a Go method also gets the calls through
   * the interfaces it satisfies, which Go code does not name, and a TS method
   * what the compiler's own search adds across implementations. Only
   * references [where] accepts are kept.
   */
  async references(symbol: CodeSymbol, options: ReferenceOptions = {}): Promise<References> {
    const group = [symbol, ...(options.overloads ?? [])];
    const own = (p: Position) => group.some((s) => p.file === s.file && p.line === s.line - 1);
    // A member's search follows the whole type hierarchy, framework included:
    // slow, and more than its uses. Members resolve their mentions instead.
    const member = symbol.kind === 'method' || symbol.parent !== undefined;
    if (this.spec.completeReferences && !member) {
      const answer = await this.serverReferences(symbol, options, own);
      if (answer) return answer;
    }
    // Every text mention is resolved, nearest first, so a search cut short by
    // its deadline has the likeliest answers. The server answers nothing in a
    // comment or string, so only files with answers are parsed afterwards.
    const candidates = (await this.mentionsOf(symbol.name))
      .filter((p) => !own(p))
      .sort((a, b) => distance(symbol.file, a.file) - distance(symbol.file, b.file));
    // An overloaded function resolves to all its signatures; any of them will do.
    const deadline = options.deadline ?? Date.now() + searchMs;
    const resolved = (
      await pool(candidates, concurrency, async (p) => ({ p, spans: await this.definition(p) }), deadline)
    ).filter((r) => r !== undefined);
    let partial = resolved.length < candidates.length ? { resolved: resolved.length, total: candidates.length } : undefined;
    const lines = (await readFile(join(this.root, symbol.file), 'utf8')).split('\n');
    const declared = group.map((s) => ({
      file: s.file,
      name: s.name,
      nameLine: s.line - 1,
      startLine: s.range[0] - 1,
      endLine: s.range[1] - 1,
    }));
    const bases = new Set(options.bases?.map((s) => `${s.file}:${s.line - 1}`));
    // `super.m()`, and Python's `super().m()` or `super(C, self).m()`.
    const viaSuper = (p: Mention) => /\bsuper(\([^)]*\))?\.$/.test(p.text.slice(0, p.character));
    const isOurs = (p: Mention, spans: Span[]) =>
      spans.some((span) => declared.some((d) => resolvesTo(span, d, lines) && !(viaSuper(p) && bases.has(`${d.file}:${d.nameLine}`))));
    const ours = resolved.filter(({ p, spans }) => isOurs(p, spans)).map(({ p }) => p);
    const found = await inCode(this.root, ours, options.where);
    // A Go method whose type is declared in another file has no parent, but is a method.
    if (!options.viaSupertypes || (symbol.kind !== 'method' && !symbol.parent)) return { found, partial };
    const key = (p: Position) => `${p.file}:${p.line}:${p.character}`;
    const have = new Set(ours.map(key));
    const column = Math.max(lines[symbol.line - 1]?.indexOf(symbol.name) ?? 0, 0);
    const at = { file: symbol.file, line: symbol.line - 1, character: column };
    // A Go interface names no implementations; gopls tells which interface
    // methods this one satisfies, and calls resolved to those reach it too.
    const interfaces: Span[] = [];
    for (const span of this.spec.implicitInterfaces ? await this.lsp.implementations(at) : []) {
      if (await isBodiless(this.root, span)) interfaces.push(span);
    }
    const throughInterfaces = resolved
      .filter(({ p, spans }) => !have.has(key(p)) && spans.some((s) => interfaces.some((i) => i.file === s.file && i.nameLine === s.nameLine)))
      .map(({ p }) => p);
    // Within the same deadline; a search the server has not finished by then is left out.
    const fromServer = this.spec.hierarchyReferences ? await this.lsp.references(at, deadline) : [];
    if (!fromServer) partial ??= { resolved: resolved.length, total: candidates.length };
    const added = (fromServer ?? [])
      .map((s) => ({ file: s.file, line: s.nameLine, character: s.nameColumn, text: '' }))
      .filter((p) => !have.has(key(p)) && !own(p));
    const unique = new Map([...throughInterfaces, ...(await this.withoutSuperCalls(added))].map((p) => [key(p), p]));
    return { found: [...found, ...(await inCode(this.root, [...unique.values()], options.where))], partial };
  }

  // [mentions] less `super.m()` calls, which the Dart server's search counts
  // for every override but which run the parent's m.
  private async withoutSuperCalls(mentions: Mention[]): Promise<Mention[]> {
    const kept: Mention[] = [];
    for (const file of new Set(mentions.map((m) => m.file))) {
      const lines = (await readFile(join(this.root, file), 'utf8')).split('\n');
      for (const m of mentions) {
        if (m.file === file && !/\bsuper\.$/.test((lines[m.line] ?? '').slice(0, m.character))) kept.push(m);
      }
    }
    return kept;
  }

  // The server's own search, once it has analyzed the workspace; until then undefined.
  private async serverReferences(
    symbol: CodeSymbol,
    options: ReferenceOptions,
    own: (p: Position) => boolean,
  ): Promise<References | undefined> {
    const lines = (await readFile(join(this.root, symbol.file), 'utf8')).split('\n');
    const at = { file: symbol.file, line: symbol.line - 1, character: Math.max(lines[symbol.line - 1]?.indexOf(symbol.name) ?? 0, 0) };
    // Until the server has analyzed the workspace, its search waits for that.
    if (!this.lsp.idle) return undefined;
    const deadline = options.deadline ?? Date.now() + searchMs;
    const spans = await this.lsp.references(at, deadline);
    if (!spans) return { found: [], partial: { resolved: 0, total: 0 } };
    const positions = spans.map((s) => ({ file: s.file, line: s.nameLine, character: s.nameColumn, text: '' })).filter((p) => !own(p));
    const found = await inCode(this.root, positions, options.where);
    return { found };
  }

  // The text mentions of [name], kept until a file changes.
  private mentionsOf(name: string): Promise<Mention[]> {
    let found = this.mentions.get(name);
    if (!found) {
      found = textMentions(this.root, name, this.spec.extensions);
      this.mentions.set(name, found);
    }
    return found;
  }

  /** Tells the server [file] changed on disk; what was kept may no longer hold. */
  changed(file: string): Promise<void> {
    this.definitions.clear();
    this.mentions.clear();
    return this.lsp.changed(file);
  }

  async stop(): Promise<void> {
    await this.lsp.stop();
  }
}

export type ReferenceOptions = {
  viaSupertypes?: boolean;
  /** Declarations that count as the symbol: overloads, supertypes' methods. */
  overloads?: readonly CodeSymbol[];
  /**
   * Those of [overloads] that are a supertype's methods: a call through the
   * supertype may reach the symbol, but `super.m()` runs the supertype's own.
   */
  bases?: readonly CodeSymbol[];
  /** Which mentions in code count, such as calls only; all by default. */
  where?: (tree: Tree, line: number, column: number) => boolean;
  /** When to stop resolving mentions (a Date.now() time); five seconds from the start by default. */
  deadline?: number;
};

/** A text mention: its place and its line's text. */
export type Mention = Position & { text: string };

/** Mentions of [name] in code; see textMentions and inCode. */
export async function codeMentions(
  root: string,
  name: string,
  extensions: ReadonlySet<string>,
  where?: ReferenceOptions['where'],
): Promise<Position[]> {
  return inCode(root, await textMentions(root, name, extensions), where);
}

/**
 * Whole-word mentions of [name] in files with one of [extensions], as LSP
 * positions with their line's text: a ripgrep search, nothing parsed.
 */
export async function textMentions(root: string, name: string, extensions: ReadonlySet<string>): Promise<Mention[]> {
  const globs = [...extensions].flatMap((ext) => ['-g', `*${ext}`]);
  let stdout = '';
  try {
    ({ stdout } = await run(rgPath, ['--vimgrep', '-w', '-F', ...globs, '-e', name, '.'], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  const mentions: Mention[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(?:\.\/)?(.+?):(\d+):(\d+):(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || match[4] === undefined) continue;
    const file = match[1];
    if (file.endsWith('.d.ts')) continue;
    // ripgrep counts bytes; LSP counts UTF-16 units.
    const character = Buffer.from(match[4]).subarray(0, Number(match[3]) - 1).toString().length;
    mentions.push({ file, line: Number(match[2]) - 1, character, text: match[4] });
  }
  return mentions;
}

/**
 * Of [mentions], those in code (not comments or strings, though
 * documentation links count); with [where], only the code mentions it
 * accepts. Each file is parsed once.
 */
export async function inCode(root: string, mentions: readonly Mention[], where?: ReferenceOptions['where']): Promise<Position[]> {
  const kept: Position[] = [];
  for (const file of new Set(mentions.map((m) => m.file))) {
    const text = await readFile(join(root, file), 'utf8');
    const lines = text.split('\n');
    const tree = await parseFile(file, text);
    try {
      for (const { text: _, ...p } of mentions) {
        if (p.file !== file) continue;
        if (where) {
          if (tree && isCodeAt(tree, p.line, p.character) && where(tree, p.line, p.character)) kept.push(p);
        } else if (!tree || isCodeAt(tree, p.line, p.character) || inDocLink(lines[p.line] ?? '', p.character)) {
          kept.push(p);
        }
      }
    } finally {
      tree?.delete();
    }
  }
  return kept;
}

/**
 * Maps [items] through [task], at most [limit] at a time, keeping order.
 * After [deadline] (a Date.now() time) no item starts and none is waited
 * for; those left out are undefined.
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  deadline = Infinity,
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && Date.now() < deadline) {
      const i = next++;
      results[i] = await task(items[i] as T);
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (!Number.isFinite(deadline)) {
    await all;
    return results;
  }
  // Tasks still running at the deadline are not waited for; their answers are dropped.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([all, new Promise<void>((done) => (timer = setTimeout(done, Math.max(deadline - Date.now(), 0))))]);
  clearTimeout(timer);
  return results.slice();
}

/**
 * Whether a definition [span] is the [declared] symbol, whose file reads as
 * [lines]: its own name, or one of its constructors, which a Dart
 * instantiation resolves to and which carry the class's name inside its
 * body.
 */
export function resolvesTo(
  span: Span,
  declared: { file: string; name: string; nameLine: number; startLine: number; endLine: number },
  lines: readonly string[],
): boolean {
  if (span.file !== declared.file) return false;
  if (span.nameLine === declared.nameLine) return true;
  const inside = span.nameLine > declared.startLine && span.nameLine <= declared.endLine;
  return inside && (lines[span.nameLine] ?? '').startsWith(declared.name, span.nameColumn);
}

// Declarations without a body: methods of a Go or TS interface, abstract methods.
const bodilessTypes = new Set(['method_elem', 'method_spec', 'method_signature', 'abstract_method_signature']);

// Whether the declaration named at [span] is a method of an interface or an abstract one.
async function isBodiless(root: string, span: Span): Promise<boolean> {
  const tree = await parseFile(span.file, await readFile(join(root, span.file), 'utf8'));
  try {
    const node = tree?.rootNode.descendantForPosition({ row: span.nameLine, column: span.nameColumn });
    return !!node?.parent && bodilessTypes.has(node.parent.type);
  } finally {
    tree?.delete();
  }
}

