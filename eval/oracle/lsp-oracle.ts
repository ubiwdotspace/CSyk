import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver-protocol';
import { isCodeAt, isImportAt, parseFile } from '../../src/index/parse.ts';
import { LspClient, type Position, type Span } from '../../src/precision/lsp-client.ts';
import { resolvesTo, servers, type ServerSpec } from '../../src/precision/lsp-service.ts';

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
    for (const mention of await this.mentions(name)) {
      const own = mention.file === declaration.file && mention.line === declaration.nameLine;
      if (own) continue;
      const span = await this.resolve(mention);
      if (span && resolvesTo(span, declared, lines)) refs.push(mention);
    }
    return refs;
  }

  /** The innermost function, method, class or binding enclosing [line]. */
  async containing(file: string, line: number): Promise<DocumentSymbol | undefined> {
    let best: DocumentSymbol | undefined;
    const visit = (symbols: DocumentSymbol[]) => {
      for (const symbol of symbols) {
        if (symbol.range.start.line > line || symbol.range.end.line < line) continue;
        if (containerKinds.has(symbol.kind)) best = symbol;
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
