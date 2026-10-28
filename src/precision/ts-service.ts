import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import type { CodeSymbol } from '../index/symbols.ts';
import { inJsDocLink, isCodeAt, parseTs, tsExtensions } from '../index/ts-parser.ts';
import { listFiles } from '../workspace/files.ts';
import { LspClient, type Position, type Span } from './lsp-client.ts';

const run = promisify(execFile);

const tsc = join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/tsc');

// LSP requests in flight at once while resolving mentions.
const concurrency = 16;

/**
 * TypeScript and JavaScript precision from the compiler (`tsc --lsp`),
 * started on first use with every tsconfig project of the workspace loaded.
 */
export class TsService {
  private readonly lsp: LspClient;
  readonly root: string;

  private constructor(root: string, lsp: LspClient) {
    this.root = root;
    this.lsp = lsp;
  }

  static async start(root: string): Promise<TsService> {
    const lsp = await LspClient.start(tsc, ['--lsp', '--stdio'], root);
    const sources = await listFiles(root, tsExtensions);
    const configs = (await listFiles(root, new Set(['.json']))).filter(
      (file) => basename(file) === 'tsconfig.json',
    );
    // A symbol request in one file of each project makes the server load it.
    for (const config of configs) {
      const dir = dirname(config);
      const file = sources.find((f) => dir === '.' || f.startsWith(`${dir}/`));
      if (file) await lsp.documentSymbols(file);
    }
    return new TsService(root, lsp);
  }

  /** Where the name at [at] is declared, inside the workspace. */
  definition(at: Position): Promise<Span[]> {
    return this.lsp.definition(at);
  }

  /**
   * Every reference to [symbol]: each place its name is written in code
   * (comments and strings left out, JSDoc `{@link}`s kept) that the compiler
   * resolves to its declaration. Each file resolves through its own project, so references
   * cross workspace packages. Names written under another name
   * (`import { a as b }`) are not followed.
   */
  async references(symbol: CodeSymbol): Promise<Position[]> {
    const candidates = await this.codeMentions(symbol.name);
    const own = (p: Position) => p.file === symbol.file && p.line === symbol.line - 1;
    const resolved = await pool(candidates.filter((p) => !own(p)), concurrency, async (p) => ({
      p,
      span: (await this.definition(p))[0],
    }));
    return resolved
      .filter(({ span }) => span?.file === symbol.file && span.nameLine === symbol.line - 1)
      .map(({ p }) => p);
  }

  async stop(): Promise<void> {
    await this.lsp.stop();
  }

  // Whole-word mentions of [name] in TS/JS code, as LSP positions.
  private async codeMentions(name: string): Promise<Position[]> {
    const globs = [...tsExtensions].flatMap((ext) => ['-g', `*${ext}`]);
    let stdout = '';
    try {
      ({ stdout } = await run(rgPath, ['--vimgrep', '-w', '-F', ...globs, '-e', name, '.'], {
        cwd: this.root,
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
      const at = { file, line: Number(match[2]) - 1, character, text: match[4] };
      byFile.set(file, [...(byFile.get(file) ?? []), at]);
    }
    const mentions: Position[] = [];
    for (const [file, positions] of byFile) {
      const tree = await parseTs(file, await readFile(join(this.root, file), 'utf8'));
      try {
        for (const { text, ...p } of positions) {
          const code = !tree || isCodeAt(tree, p.line, p.character) || inJsDocLink(text, p.character);
          if (code) mentions.push(p);
        }
      } finally {
        tree?.delete();
      }
    }
    return mentions;
  }
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
