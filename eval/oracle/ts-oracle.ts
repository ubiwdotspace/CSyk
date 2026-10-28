import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver-protocol';
import { isCodeAt, parseTs } from '../../src/index/ts-parser.ts';
import { LspClient, type Position, type Span } from '../../src/precision/lsp-client.ts';

const run = promisify(execFile);

const tsc = join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/tsc');

/** Symbol kinds that a case can be about: code you would search for. */
export const caseKinds: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.Enum,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Method,
  SymbolKind.TypeParameter,
]);

// Kinds whose children are members rather than locals.
const memberParents: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.Enum,
]);

// Kinds that can contain a line of code worth naming as its home.
const containerKinds: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Constructor,
  SymbolKind.Class,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Property,
]);

/**
 * Answers for TypeScript cases from the compiler itself (`tsc --lsp`), with
 * every tsconfig project loaded and no time limit.
 *
 * References are found by resolving each textual mention of a name to its
 * declaration: each file is resolved by its own project, so this crosses
 * package boundaries (re-exports, workspace packages) that a single
 * project's reference search misses, and it tells apart same-named symbols.
 * Mentions under another name (`import { a as b }`) are not followed.
 */
export class TsOracle {
  readonly root: string;
  readonly files: readonly string[];
  private readonly lsp: LspClient;

  private constructor(root: string, files: string[], lsp: LspClient) {
    this.root = root;
    this.files = files;
    this.lsp = lsp;
  }

  static async start(root: string): Promise<TsOracle> {
    const files = (await git(root, ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts']))
      .filter((file) => !file.endsWith('.d.ts'));
    const lsp = await LspClient.start(tsc, ['--lsp', '--stdio'], root);
    const oracle = new TsOracle(root, files, lsp);
    // A symbol request in one file of each project makes the server load it.
    for (const config of await git(root, ['ls-files', '*tsconfig.json'])) {
      const dir = dirname(config);
      const file = files.find((f) => dir === '.' || f.startsWith(`${dir}/`));
      if (file) await lsp.documentSymbols(file);
    }
    return oracle;
  }

  /**
   * The top-level symbols of [file] and the members of its classes,
   * interfaces and enums. A function's children are its locals, which
   * nobody searches for by name, so they are left out.
   */
  async symbols(file: string): Promise<DocumentSymbol[]> {
    const top = await this.lsp.documentSymbols(file);
    return top.flatMap((symbol) => [
      symbol,
      ...(memberParents.has(symbol.kind) ? (symbol.children ?? []) : []),
    ]);
  }

  /** Where the name at [at] is declared, when that is inside the repo. */
  async resolve(at: Position): Promise<Span | undefined> {
    return (await this.lsp.definition(at))[0];
  }

  /** Every place [name] is written as a whole word in a TS file. */
  async mentions(name: string): Promise<Position[]> {
    const lines = await git(this.root, ['grep', '-n', '-w', '-F', name, '--', ...tsPathspecs]);
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
   * members, not function locals. Mentions inside strings and comments are
   * skipped; an import path resolves to its module, which is no declaration.
   */
  async declarations(name: string): Promise<Span[]> {
    const found = new Map<string, Span>();
    for (const mention of await this.codeMentions(name)) {
      const span = await this.resolve(mention);
      if (span && (await this.isSymbol(name, span))) found.set(`${span.file}:${span.nameLine}`, span);
    }
    return [...found.values()];
  }

  // Whether [span] declares a symbol of its file's outline called [name].
  private async isSymbol(name: string, span: Span): Promise<boolean> {
    const symbols = await this.symbols(span.file);
    return symbols.some((s) => s.name === name && s.selectionRange.start.line === span.nameLine);
  }

  // Mentions of [name] outside strings and comments.
  private async codeMentions(name: string): Promise<Position[]> {
    const mentions = await this.mentions(name);
    const code: Position[] = [];
    for (const file of new Set(mentions.map((m) => m.file))) {
      const tree = await parseTs(file, await this.text(file));
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

  /**
   * Every mention of [name] that resolves to [declaration], except the
   * declared name itself: imports, re-exports and uses, as lines.
   */
  async references(name: string, declaration: Span): Promise<Position[]> {
    const refs: Position[] = [];
    for (const mention of await this.mentions(name)) {
      const own = mention.file === declaration.file && mention.line === declaration.nameLine;
      if (own) continue;
      const span = await this.resolve(mention);
      if (span?.file === declaration.file && span.nameLine === declaration.nameLine) {
        refs.push(mention);
      }
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

  async text(file: string): Promise<string> {
    return readFile(join(this.root, file), 'utf8');
  }

  async stop(): Promise<void> {
    await this.lsp.stop();
  }
}

const tsPathspecs = ['*.ts', '*.tsx', '*.mts', '*.cts', ':!*.d.ts'];

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
