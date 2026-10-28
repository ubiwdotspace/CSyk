import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listFiles } from '../workspace/files.ts';
import type { CodeSymbol, SymbolKind } from './symbols.ts';
import { extractSymbols, sourceExtensions } from './parse.ts';

export type SearchOptions = { kind?: SymbolKind; path?: string; limit?: number };

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

  private constructor(root: string) {
    this.root = root;
  }

  static async build(root: string): Promise<SymbolIndex> {
    const index = new SymbolIndex(root);
    const files = await listFiles(root, sourceExtensions);
    // Parsing is quick; reading files a batch at a time keeps it from waiting on disk.
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(files.slice(i, i + 64).map((file) => index.update(file)));
    }
    return index;
  }

  /** Re-reads [file]; a file that is gone leaves the index. */
  async update(file: string): Promise<void> {
    this.remove(file);
    let text: string;
    try {
      text = await readFile(join(this.root, file), 'utf8');
    } catch {
      return;
    }
    const symbols = await extractSymbols(file, text);
    this.byFile.set(file, symbols);
    for (const symbol of symbols) {
      this.byName.set(symbol.name, [...(this.byName.get(symbol.name) ?? []), symbol]);
    }
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
    for (const symbols of this.byFile.values()) {
      for (const symbol of symbols) {
        if (options.kind && symbol.kind !== options.kind) continue;
        if (options.path && !symbol.file.startsWith(options.path)) continue;
        const match = nameScore(symbol.name, query, squashed, queryWords);
        if (match === 0) continue;
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

  private remove(file: string): void {
    for (const symbol of this.byFile.get(file) ?? []) {
      const rest = (this.byName.get(symbol.name) ?? []).filter((s) => s.file !== file);
      if (rest.length > 0) this.byName.set(symbol.name, rest);
      else this.byName.delete(symbol.name);
    }
    this.byFile.delete(file);
  }
}

// How well a name answers a query, 0 for not at all.
function nameScore(name: string, query: string, squashed: string, queryWords: string[]): number {
  if (name === query) return 100;
  const squashedName = squash(name);
  if (squashedName === squashed) return 90;
  if (squashedName.startsWith(squashed)) return 70;
  if (squashedName.includes(squashed)) return 55;
  // Each query word starts a name word, in order: `calc total` → `calculateTotal`.
  const nameWords = words(name);
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

