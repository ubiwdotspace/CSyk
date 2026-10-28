import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from '../workspace/files.ts';
import type { CodeSymbol, SymbolKind } from './symbols.ts';
import { extractSymbols, sourceExtensions } from './parse.ts';

export type SearchOptions = { kind?: SymbolKind; path?: string; limit?: number };

// What the index knows of a file's content, to tell whether it changed.
type FileState = { mtimeMs: number; size: number; hash: string };

/** The index of a workspace as saved on disk, to start without re-parsing. */
type Snapshot = { version: string; files: Record<string, FileState & { symbols: CodeSymbol[] }> };

// How much a kind of symbol is usually what a search is after.
const kindWeight: Record<SymbolKind, number> = {
  function: 1,
  component: 1,
  widget: 1,
  route: 0.95,
  hook: 0.95,
  provider: 0.9,
  class: 0.9,
  method: 0.85,
  interface: 0.8,
  type: 0.8,
  enum: 0.8,
  const: 0.75,
  field: 0.7,
};

/** Lower case, letters and digits only: `token store` and `TokenStore` meet. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `parseHTTPResponse` → `parse`, `http`, `response`. */
const words = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The symbols of a workspace, held in memory and found by name.
 *
 * Name matching here is exact, squashed, prefix, substring and word-prefix;
 * ranked full-text search and typo tolerance come in a later phase.
 */
export class SymbolIndex {
  readonly root: string;
  private readonly byFile = new Map<string, CodeSymbol[]>();
  private readonly byName = new Map<string, CodeSymbol[]>();
  private readonly states = new Map<string, FileState>();
  private readonly nameKeys = new Map<string, { squashed: string; words: string[] }>();
  /** Files taken from a snapshot as they were, when the index was built from one. */
  reused = 0;

  private constructor(root: string) {
    this.root = root;
  }

  /**
   * Indexes every source file of [root]. With a [snapshot] path, files whose
   * size and modification time match the saved index are taken from it, and
   * the result is saved back there.
   */
  static async build(root: string, options: { snapshot?: string } = {}): Promise<SymbolIndex> {
    const index = new SymbolIndex(root);
    const files = await listFiles(root, sourceExtensions);
    const saved = options.snapshot ? await readSnapshot(options.snapshot) : undefined;
    // Reading files a batch at a time keeps parsing from waiting on disk.
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(
        files.slice(i, i + 64).map(async (file) => {
          const entry = saved?.files[file];
          const info = entry && (await stat(join(root, file)).catch(() => undefined));
          if (!entry || info?.mtimeMs !== entry.mtimeMs || info.size !== entry.size) return index.update(file);
          index.put(file, entry.symbols, entry);
          index.reused++;
          return true;
        }),
      );
    }
    if (options.snapshot) await index.save(options.snapshot);
    return index;
  }

  /**
   * Re-reads [file]; a file that is gone leaves the index. Whether its
   * content changed: an unchanged file is not parsed again.
   */
  async update(file: string): Promise<boolean> {
    let text: string;
    let info: { mtimeMs: number; size: number };
    try {
      [text, info] = await Promise.all([readFile(join(this.root, file), 'utf8'), stat(join(this.root, file))]);
    } catch {
      const known = this.byFile.has(file);
      this.remove(file);
      return known;
    }
    const hash = createHash('sha1').update(text).digest('hex');
    const known = this.states.get(file);
    if (known?.hash === hash) {
      this.states.set(file, { mtimeMs: info.mtimeMs, size: info.size, hash });
      return false;
    }
    this.put(file, await extractSymbols(file, text), { mtimeMs: info.mtimeMs, size: info.size, hash });
    return true;
  }

  /** Saves the index to [path], for the next start. */
  async save(path: string): Promise<void> {
    const files: Snapshot['files'] = {};
    for (const [file, state] of this.states) files[file] = { ...state, symbols: this.byFile.get(file) ?? [] };
    const snapshot: Snapshot = { version: await indexVersion(), files };
    await mkdir(dirname(path), { recursive: true });
    // Written aside and renamed, so a reader never sees half a file.
    await writeFile(`${path}.tmp`, JSON.stringify(snapshot));
    await rename(`${path}.tmp`, path);
  }

  get files(): string[] {
    return [...this.byFile.keys()].sort();
  }

  get size(): number {
    let count = 0;
    for (const symbols of this.byFile.values()) count += symbols.length;
    return count;
  }

  has(file: string): boolean {
    return this.byFile.has(file);
  }

  symbolsIn(file: string): CodeSymbol[] {
    return this.byFile.get(file) ?? [];
  }

  named(name: string): CodeSymbol[] {
    return this.byName.get(name) ?? [];
  }

  get(id: string): CodeSymbol | undefined {
    const file = id.slice(0, id.indexOf('#'));
    return this.symbolsIn(file).find((symbol) => symbol.id === id);
  }

  /** The innermost symbol whose range holds the 1-based [line] of [file]. */
  containing(file: string, line: number): CodeSymbol | undefined {
    let best: CodeSymbol | undefined;
    for (const symbol of this.symbolsIn(file)) {
      if (symbol.range[0] > line || symbol.range[1] < line) continue;
      if (!best || symbol.range[1] - symbol.range[0] <= best.range[1] - best.range[0]) best = symbol;
    }
    return best;
  }

  /** Symbols whose name matches [query], best first. */
  search(query: string, options: SearchOptions = {}): CodeSymbol[] {
    const squashed = squash(query);
    const queryWords = words(query);
    if (!squashed) return [];
    const scored: { symbol: CodeSymbol; score: number }[] = [];
    // Each distinct name is matched once, with its squashed form and words kept.
    for (const [name, symbols] of this.byName) {
      let key = this.nameKeys.get(name);
      if (!key) {
        key = { squashed: squash(name), words: words(name) };
        this.nameKeys.set(name, key);
      }
      const match = nameScore(name, query, squashed, queryWords, key);
      if (match === 0) continue;
      for (const symbol of symbols) {
        if (options.kind && symbol.kind !== options.kind) continue;
        if (options.path && !symbol.file.startsWith(options.path)) continue;
        const weight =
          kindWeight[symbol.kind] *
          (symbol.isTest ? 0.3 : 1) *
          (symbol.exported ? 1 : 0.95) *
          // A leading underscore marks a private helper.
          (symbol.name.startsWith('_') ? 0.9 : 1);
        scored.push({ symbol, score: match * weight });
      }
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.symbol.name.length - b.symbol.name.length ||
        a.symbol.file.localeCompare(b.symbol.file) ||
        a.symbol.line - b.symbol.line,
    );
    return scored.slice(0, options.limit ?? 10).map((entry) => entry.symbol);
  }

  /**
   * Up to three names closest to [query] for a search that found nothing:
   * within two edits of it, ignoring case and separators.
   */
  nearest(query: string): string[] {
    const target = squash(query);
    const scored: { name: string; distance: number }[] = [];
    for (const name of this.byName.keys()) {
      const distance = editDistance(target, squash(name), 2);
      if (distance <= 2) scored.push({ name, distance });
    }
    scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
    return scored.slice(0, 3).map((s) => s.name);
  }

  private put(file: string, symbols: CodeSymbol[], state: FileState): void {
    this.remove(file);
    this.byFile.set(file, symbols);
    this.states.set(file, state);
    for (const symbol of symbols) {
      this.byName.set(symbol.name, [...(this.byName.get(symbol.name) ?? []), symbol]);
    }
  }

  private remove(file: string): void {
    this.states.delete(file);
    for (const symbol of this.byFile.get(file) ?? []) {
      const rest = (this.byName.get(symbol.name) ?? []).filter((s) => s.file !== file);
      if (rest.length > 0) this.byName.set(symbol.name, rest);
      else this.byName.delete(symbol.name);
    }
    this.byFile.delete(file);
  }
}

// How well a name answers a query, 0 for not at all.
function nameScore(
  name: string,
  query: string,
  squashed: string,
  queryWords: string[],
  key: { squashed: string; words: string[] },
): number {
  if (name === query) return 100;
  const squashedName = key.squashed;
  if (squashedName === squashed) return 90;
  if (squashedName.startsWith(squashed)) return 70;
  if (squashedName.includes(squashed)) return 55;
  // Each query word starts a name word, in order: `calc total` → `calculateTotal`.
  const nameWords = key.words;
  let at = 0;
  for (const word of queryWords) {
    while (at < nameWords.length && !nameWords[at]?.startsWith(word)) at++;
    if (at === nameWords.length) return 0;
    at++;
  }
  return 45;
}

// Levenshtein distance between [a] and [b], cut off just above [max].
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

// A snapshot saved by this version of the index code, or none.
async function readSnapshot(path: string): Promise<Snapshot | undefined> {
  try {
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
    return snapshot.version === (await indexVersion()) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

let version: Promise<string> | undefined;

// A hash of the code that turns files into symbols: a snapshot made by other
// code is not reused.
function indexVersion(): Promise<string> {
  version ??= (async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const hash = createHash('sha1');
    for (const name of (await readdir(dir, { recursive: true })).sort()) {
      if (/\.[jt]s$/.test(name) && !name.includes('.test.')) hash.update(name).update(await readFile(join(dir, name)));
    }
    return hash.digest('hex').slice(0, 16);
  })();
  return version;
}

