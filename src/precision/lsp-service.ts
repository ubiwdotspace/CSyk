import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { inDocLink, isCodeAt, parseFile } from '../index/parse.ts';
import type { CodeSymbol } from '../index/symbols.ts';
import { listFiles } from '../workspace/files.ts';
import { LspClient, type Position, type Span } from './lsp-client.ts';

const run = promisify(execFile);
const bin = (name: string) => join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin', name);

/** A language server CSyk can start, and the files it answers for. */
export type ServerSpec = {
  name: string;
  extensions: ReadonlySet<string>;
  /** The command to start it, or undefined when it is not installed. */
  command: () => { command: string; args: string[] } | undefined;
  /** Work done once it starts, such as loading every project. */
  warmup?: (lsp: LspClient, root: string) => Promise<void>;
};

// The first of [names] found on PATH or in Go's install folder.
function onPath(...names: string[]): string | undefined {
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
    command: () => ({ command: bin('tsc'), args: ['--lsp', '--stdio'] }),
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
    command: () => ({ command: bin('pyright-langserver'), args: ['--stdio'] }),
  },
  {
    name: 'gopls',
    extensions: new Set(['.go']),
    command: () => {
      const gopls = onPath('gopls');
      return gopls ? { command: gopls, args: [] } : undefined;
    },
  },
  {
    name: 'dart',
    extensions: new Set(['.dart']),
    command: () => {
      const dart = onPath('dart');
      return dart ? { command: dart, args: ['language-server', '--protocol=lsp', '--client-id=csyk'] } : undefined;
    },
  },
];

/** The server for [file]'s language, if CSyk has one. */
export function serverFor(file: string): ServerSpec | undefined {
  return servers.find((s) => s.extensions.has(extname(file)));
}

// LSP requests in flight at once while resolving mentions.
const concurrency = 16;

/** Precision from one language server, started with its warm-up done. */
export class LspService {
  readonly root: string;
  readonly spec: ServerSpec;
  private readonly lsp: LspClient;

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

  /** Where the name at [at] is declared, inside the workspace. */
  definition(at: Position): Promise<Span[]> {
    return this.lsp.definition(at);
  }

  /**
   * Every reference to [symbol]: each place its name is written in code
   * (comments and strings left out, documentation links kept) that the
   * server resolves to its declaration. Each file resolves in its own
   * project, so references cross packages. Names written under another
   * name (`import { a as b }`) are not followed.
   */
  async references(symbol: CodeSymbol): Promise<Position[]> {
    const own = (p: Position) => p.file === symbol.file && p.line === symbol.line - 1;
    const candidates = (await codeMentions(this.root, symbol.name, this.spec.extensions)).filter((p) => !own(p));
    const resolved = await pool(candidates, concurrency, async (p) => ({ p, span: (await this.definition(p))[0] }));
    const lines = (await readFile(join(this.root, symbol.file), 'utf8')).split('\n');
    const declared = {
      file: symbol.file,
      name: symbol.name,
      nameLine: symbol.line - 1,
      startLine: symbol.range[0] - 1,
      endLine: symbol.range[1] - 1,
    };
    return resolved.filter(({ span }) => span && resolvesTo(span, declared, lines)).map(({ p }) => p);
  }

  async stop(): Promise<void> {
    await this.lsp.stop();
  }
}

/**
 * Whole-word mentions of [name] in code (not comments or strings, though
 * documentation links count) in files with one of [extensions], as LSP
 * positions.
 */
export async function codeMentions(root: string, name: string, extensions: ReadonlySet<string>): Promise<Position[]> {
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
  const byFile = new Map<string, (Position & { text: string })[]>();
  for (const line of stdout.split('\n')) {
    const match = /^(?:\.\/)?(.+?):(\d+):(\d+):(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || match[4] === undefined) continue;
    const file = match[1];
    if (file.endsWith('.d.ts')) continue;
    // ripgrep counts bytes; LSP counts UTF-16 units.
    const character = Buffer.from(match[4]).subarray(0, Number(match[3]) - 1).toString().length;
    byFile.set(file, [...(byFile.get(file) ?? []), { file, line: Number(match[2]) - 1, character, text: match[4] }]);
  }
  const mentions: Position[] = [];
  for (const [file, positions] of byFile) {
    const tree = await parseFile(file, await readFile(join(root, file), 'utf8'));
    try {
      for (const { text, ...p } of positions) {
        if (!tree || isCodeAt(tree, p.line, p.character) || inDocLink(text, p.character)) mentions.push(p);
      }
    } finally {
      tree?.delete();
    }
  }
  return mentions;
}

/** Maps [items] through [task], at most [limit] at a time, keeping order. */
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

