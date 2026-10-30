import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver-protocol';
import { isCallAt, isCodeAt, isImportAt, isMemberAt, parseFile } from '../../src/index/parse.ts';
import { LspClient, type Position, type Span } from '../../src/precision/lsp-client.ts';
import { importAliases, resolvesTo, servers, type ServerSpec } from '../../src/precision/lsp-service.ts';

const run = promisify(execFile);

/** The languages cases can be generated for, by the server that answers them. */
export const oracleServers: Record<string, string> = { ts: 'tsc', py: 'pyright', go: 'gopls', dart: 'dart' };

/** Symbol kinds that a case can be about: code you would search for. */
export const caseKinds: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Class,
  SymbolKind.Struct,
  SymbolKind.Interface,
  SymbolKind.Enum,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Method,
  SymbolKind.TypeParameter,
  SymbolKind.EnumMember,
]);

// Kinds whose children are members rather than locals.
const memberParents: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Class,
  SymbolKind.Struct,
  SymbolKind.Interface,
  SymbolKind.Enum,
]);

// Kinds that can contain a line of code worth naming as its home.
const containerKinds: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Constructor,
  SymbolKind.Class,
  SymbolKind.Struct,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Property,
]);

// Symbols a call is made from: functions and classes, and a variable over
// several lines, which holds a function (`const debug = function () {…}`),
// not a one-line variable a result is assigned to.
const callerKinds: ReadonlySet<SymbolKind> = new Set([SymbolKind.Function, SymbolKind.Method, SymbolKind.Constructor, SymbolKind.Class]);
const holderKinds: ReadonlySet<SymbolKind> = new Set([SymbolKind.Variable, SymbolKind.Constant, SymbolKind.Property]);

/**
 * Answers for cases from a language server itself (`tsc --lsp`, pyright,
 * gopls, the Dart analysis server), with no time limit.
 *
 * References are found by resolving each textual mention of a name to its
 * declaration: each file is resolved in its own project, so this crosses
 * package boundaries (re-exports, workspace packages) that one project's
 * reference search can miss, and it tells same-named symbols apart.
 * Mentions under another name (`import { a as b }`) are not followed.
 */
export class LspOracle {
  readonly root: string;
  readonly files: readonly string[];
  private readonly lsp: LspClient;
  private readonly spec: ServerSpec;

  private constructor(root: string, files: string[], lsp: LspClient, spec: ServerSpec) {
    this.root = root;
    this.files = files;
    this.lsp = lsp;
    this.spec = spec;
  }

  /** Starts the server for [lang] (`ts`, `py`, `go` or `dart`) in [root]. */
  static async start(root: string, lang = 'ts'): Promise<LspOracle> {
    const spec = servers.find((s) => s.name === oracleServers[lang]);
    const launch = spec?.command();
    if (!spec || !launch || !existsSync(launch.command)) {
      throw new Error(`No language server for ${lang}: install ${oracleServers[lang] ?? lang}`);
    }
    const files = (await git(root, ['ls-files', ...[...spec.extensions].map((e) => `*${e}`)])).filter(
      (file) => !file.endsWith('.d.ts'),
    );
    const lsp = await LspClient.start(launch.command, launch.args, root);
    await spec.warmup?.(lsp, root);
    return new LspOracle(root, files, lsp, spec);
  }

  /**
   * The top-level symbols of [file] and the members of its types. A
   * function's children are its locals, which nobody searches for by name,
   * so they are left out. Go methods named `(*T).M` are named `M`.
   */
  async symbols(file: string): Promise<DocumentSymbol[]> {
    const top = await this.lsp.documentSymbols(file);
    return top
      .flatMap((symbol) => [symbol, ...(memberParents.has(symbol.kind) ? (symbol.children ?? []) : [])])
      .map((symbol) => ({ ...symbol, name: symbol.name.replace(/^\(\*?[\w[\], ]+\)\./, '') }));
  }

  /** Where the name at [at] is declared, when that is inside the repo. */
  async resolve(at: Position): Promise<Span | undefined> {
    return (await this.lsp.definition(at))[0];
  }

  /**
   * The server's own callers (`in`) or callees (`out`) of the symbol at
   * [at], each spanning its whole declaration as the outline gives it
   * (pyright and gopls give only the name).
   */
  async calls(at: Position, direction: 'in' | 'out'): Promise<Span[]> {
    const spans: Span[] = [];
    for (const { sites, ...span } of await this.lsp.calls(at, direction)) {
      // `super.m()` runs the parent's m, never a sibling's override, though
      // the Dart server counts it for every override.
      if (direction === 'in' && (await this.allSuperCalls(sites))) continue;
      const symbol = find(await this.lsp.documentSymbols(span.file), span);
      // A caller with no outline symbol is the module itself: any line of the file.
      const lastLine = (await this.text(span.file)).split('\n').length - 1;
      spans.push(
        symbol
          ? { ...span, startLine: symbol.range.start.line, endLine: symbol.range.end.line }
          : { ...span, startLine: 0, endLine: lastLine },
      );
    }
    // A server's incoming calls miss what lies outside the projects it has
    // open: pyright's on django, all but 2 of condition()'s 13 callers; the
    // TypeScript server's in a repo with no tsconfig.json over all its files
    // (jitsi-meet's tsconfig.web.json and tsconfig.native.json), or with one
    // that only references others, as Vite's and Nx's do. Its references,
    // kept to calls and grouped by the function each is in, add the rest.
    if (direction === 'in' && (this.spec.name === 'pyright' || this.spec.name === 'tsc')) {
      const have = new Set(spans.map((s) => `${s.file}:${s.startLine}`));
      for (const span of await this.callersByReference(at)) if (!have.has(`${span.file}:${span.startLine}`)) spans.push(span);
    }
    return spans;
  }

  // Whether every call at [sites] is written `super.name(…)`.
  private async allSuperCalls(sites: Position[]): Promise<boolean> {
    if (sites.length === 0) return false;
    for (const site of sites) {
      const line = (await this.text(site.file)).split('\n')[site.line] ?? '';
      if (!/\bsuper\.$/.test(line.slice(0, site.character))) return false;
    }
    return true;
  }

  /** Every place [name] is written as a whole word in a file of this language. */
  async mentions(name: string): Promise<Position[]> {
    const pathspecs = [...this.spec.extensions].map((e) => `*${e}`);
    const lines = await git(this.root, ['grep', '-n', '-w', '-F', name, '--', ...pathspecs, ':!*.d.ts']);
    const word = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`, 'g');
    const positions: Position[] = [];
    for (const entry of lines) {
      const match = /^(.+?):(\d+):(.*)$/.exec(entry);
      if (!match?.[1] || !match[2] || match[3] === undefined) continue;
      for (const hit of match[3].matchAll(word)) {
        positions.push({ file: match[1], line: Number(match[2]) - 1, character: hit.index });
      }
    }
    return positions;
  }

  /**
   * The distinct declarations of [name] that a search for it means: those
   * that mentions in code resolve to and that are top-level symbols or
   * members, not function locals or imports. Mentions inside strings and
   * comments are skipped; an import path resolves to its module, which is
   * no declaration.
   */
  async declarations(name: string): Promise<Span[]> {
    const found = new Map<string, Span>();
    for (const mention of await this.codeMentions(name)) {
      const span = await this.resolve(mention);
      const declared = span && (await this.declared(name, span));
      if (declared) found.set(`${declared.file}:${declared.nameLine}`, declared);
    }
    return [...found.values()];
  }

  /**
   * Every mention of [name] that resolves to [declaration], except the
   * declared name itself: imports, re-exports and uses, as lines.
   */
  async references(name: string, declaration: Span): Promise<Position[]> {
    const lines = (await this.text(declaration.file)).split('\n');
    const declared = { ...declaration, name };
    const refs: Position[] = [];
    // Uses under a name it is imported as (`import { a as b }`) are its uses too.
    const named = await this.mentions(name);
    const texts = await Promise.all(named.map(async (m) => ({ file: m.file, text: (await this.text(m.file)).split('\n')[m.line] ?? '' })));
    const renamed = await Promise.all(
      importAliases(name, texts).map(async ({ alias, file }) => (await this.mentions(alias)).filter((m) => !file || m.file === file)),
    );
    for (const mention of [...named, ...renamed.flat()]) {
      const own = mention.file === declaration.file && mention.line === declaration.nameLine;
      if (own) continue;
      // An overloaded function resolves to all its signatures.
      const spans = await this.lsp.definition(mention);
      if (spans.some((span) => resolvesTo(span, declared, lines))) refs.push(mention);
    }
    // One per line, in file order: a renamed import names the symbol twice on its line.
    const byLine = new Map(refs.map((r) => [`${r.file}:${String(r.line).padStart(8, '0')}`, r]));
    return [...byLine.keys()].sort().map((key) => byLine.get(key) as Position);
  }

  /** The innermost function, method, class or binding enclosing [line]. */
  // The functions (or the module) whose code calls the declaration at [at].
  private async callersByReference(at: Position): Promise<Span[]> {
    const declaration = await this.resolve(at);
    const name = /^[A-Za-z_]\w*/.exec((await this.text(at.file)).split('\n')[at.line]?.slice(at.character) ?? '')?.[0];
    if (!declaration || !name) return [];
    // Reading a property (`@property`, `@cached_property`) runs it.
    const above = (await this.text(declaration.file)).split('\n').slice(0, declaration.nameLine).reverse();
    const decorators = above.slice(0, Math.max(above.findIndex((l) => !l.trim().startsWith('@')), 0));
    const property = decorators.some((l) => /@(?:[\w.]*\.)?(?:cached_)?property\b/.test(l));
    const callers = new Map<string, Span>();
    for (const ref of await this.references(name, declaration)) {
      const text = await this.text(ref.file);
      const tree = await parseFile(ref.file, text);
      const called = tree ? isCallAt(tree, ref.line, ref.character) || (property && isMemberAt(tree, ref.line, ref.character)) : false;
      tree?.delete();
      if (!called) continue;
      const home = await this.callerAt(ref.file, ref.line);
      const span = home
        ? { file: ref.file, startLine: home.range.start.line, endLine: home.range.end.line, nameLine: home.selectionRange.start.line, nameColumn: home.selectionRange.start.character }
        : { file: ref.file, startLine: 0, endLine: text.split('\n').length - 1, nameLine: 0, nameColumn: 0 };
      callers.set(`${span.file}:${span.startLine}`, span);
    }
    return [...callers.values()];
  }

  // The innermost function, class or function-holding variable around [line].
  private async callerAt(file: string, line: number): Promise<DocumentSymbol | undefined> {
    let best: DocumentSymbol | undefined;
    const visit = (symbols: DocumentSymbol[]) => {
      for (const symbol of symbols) {
        if (symbol.range.start.line > line || symbol.range.end.line < line) continue;
        const spans = symbol.range.end.line > symbol.range.start.line;
        if (callerKinds.has(symbol.kind) || (holderKinds.has(symbol.kind) && spans)) best = symbol;
        visit(symbol.children ?? []);
      }
    };
    visit(await this.lsp.documentSymbols(file));
    return best;
  }

  async containing(file: string, line: number, kinds = containerKinds): Promise<DocumentSymbol | undefined> {
    let best: DocumentSymbol | undefined;
    const visit = (symbols: DocumentSymbol[]) => {
      for (const symbol of symbols) {
        if (symbol.range.start.line > line || symbol.range.end.line < line) continue;
        if (kinds.has(symbol.kind)) best = symbol;
        visit(symbol.children ?? []);
      }
    };
    visit(await this.lsp.documentSymbols(file));
    return best;
  }

  /** Whether the name at [at] in [file] is bound by an import. */
  async isImport(file: string, at: { line: number; character: number }): Promise<boolean> {
    const tree = await parseFile(file, await this.text(file));
    try {
      return tree ? isImportAt(tree, at.line, at.character) : false;
    } finally {
      tree?.delete();
    }
  }

  /** Every symbol name in the outlines of [files]. */
  async names(files: readonly string[]): Promise<Set<string>> {
    const names = new Set<string>();
    for (const file of files) for (const symbol of await this.symbols(file)) names.add(symbol.name);
    return names;
  }

  async text(file: string): Promise<string> {
    return readFile(join(this.root, file), 'utf8');
  }

  async stop(): Promise<void> {
    await this.lsp.stop();
  }

  // The declaration [span] points at, spanning all of it as the outline
  // does (pyright and gopls give only the name), when it is a symbol of its
  // file's outline called [name] and not a name the file only imports.
  private async declared(name: string, span: Span): Promise<Span | undefined> {
    const symbols = await this.symbols(span.file);
    const symbol = symbols.find((s) => s.name === name && s.selectionRange.start.line === span.nameLine);
    // Only the kinds a case is about: a Dart constructor shares its class's
    // name but is no second answer to it.
    if (!symbol || !caseKinds.has(symbol.kind)) return undefined;
    if (await this.isImport(span.file, symbol.selectionRange.start)) return undefined;
    return { ...span, startLine: symbol.range.start.line, endLine: symbol.range.end.line };
  }

  // Mentions of [name] outside strings and comments.
  private async codeMentions(name: string): Promise<Position[]> {
    const mentions = await this.mentions(name);
    const code: Position[] = [];
    for (const file of new Set(mentions.map((m) => m.file))) {
      const tree = await parseFile(file, await this.text(file));
      try {
        for (const m of mentions) {
          if (m.file === file && (!tree || isCodeAt(tree, m.line, m.character))) code.push(m);
        }
      } finally {
        tree?.delete();
      }
    }
    return code;
  }
}

async function git(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean);
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The outline symbol, at any depth, whose name starts where [span]'s does.
function find(symbols: DocumentSymbol[], span: Span): DocumentSymbol | undefined {
  for (const symbol of symbols) {
    const name = symbol.selectionRange.start;
    if (name.line === span.nameLine && name.character === span.nameColumn) return symbol;
    const inner = find(symbol.children ?? [], span);
    if (inner) return inner;
  }
  return undefined;
}

