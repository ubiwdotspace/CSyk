import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeSymbol } from './symbols.ts';

/**
 * Search by meaning without embeddings: BM25 over the words of each symbol's name, its file's
 * path, its signature, the comment just above it (or a Python docstring) and the names its body
 * uses, stemmed lightly, so `where are tokens refreshed` finds `refreshAccessToken` and `gzip the
 * responses` the middleware whose comment says so. Built on the first question in words, then
 * kept until the index changes; names keep their own search, and the two are fused.
 */
type Doc = { symbol: CodeSymbol; terms: Map<string, number>; length: number };

const stop = new Set(
  'a an and are as at be by can do does each every for from get gets how if in into is it its of on one only or set that the their them then this to was when where which who why with what will would you your all any not use used uses using code file function method class'.split(' '),
);

/** The stemmed words of [text]: split at case changes, digits and punctuation, stop words out. */
export function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !stop.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

// Porter's first step, roughly: plurals, -ed, -ing, -ion and a final e go.
function stem(word: string): string {
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  for (const suffix of ['ing', 'ed', 'ion']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

// Words code uses for the same thing, stemmed as terms() stems them: a question's word also finds
// the others, at half its weight. General verbs and nouns only, no project's own.
const synonymGroups = [
  'make create build new construct init',
  'save persist store write',
  'load read fetch get retrieve',
  'remove delete strip drop clear',
  'compare equal diff',
  'check validate verify assert',
  'send emit dispatch publish',
  'start begin open launch',
  'stop end close shutdown',
  'find search lookup locate query',
  'convert transform parse format serialize',
  'error fail exception panic',
  'list all every collect',
  'update change modify set',
  'sort order',
  'filter hide exclude skip',
  'user account member',
  'auth login authenticate credential password',
  'config setting option',
  'request req',
  'response res reply',
  'compress gzip deflate',
  'url link href path route',
  'id identifier uuid',
  'limit max size',
].map((g) => g.split(' ').map(stem));
const synonyms = new Map<string, string[]>();
for (const group of synonymGroups) for (const w of group) synonyms.set(w, [...new Set([...(synonyms.get(w) ?? []), ...group.filter((o) => o !== w)])]);

// What a question by meaning asks of a kind: what code does ranks before the types it uses.
const kindWeight: Record<string, number> = { interface: 0.6, type: 0.6, enum: 0.7, namespace: 0.7, class: 0.9 };

export class ConceptIndex {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly average: number;

  private constructor(docs: Doc[]) {
    this.docs = docs;
    for (const d of docs) for (const t of d.terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.average = docs.reduce((a, d) => a + d.length, 0) / Math.max(docs.length, 1);
  }

  /** The index of [symbols] under [root]: their files read once each. */
  static async build(root: string, symbols: readonly CodeSymbol[]): Promise<ConceptIndex> {
    const byFile = new Map<string, CodeSymbol[]>();
    for (const s of symbols) {
      if (s.isTest || s.nested || s.kind === 'section' || s.kind === 'field' || s.lang === 'md') continue;
      byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    }
    const docs: Doc[] = [];
    for (const [file, inFile] of byFile) {
      const lines = (await readFile(join(root, file), 'utf8').catch(() => '')).split('\n');
      const path = terms(file.replace(/\.[^./]+$/, ''));
      for (const symbol of inFile) {
        const counts = new Map<string, number>();
        const add = (words: string[], weight: number) => {
          for (const w of words) counts.set(w, (counts.get(w) ?? 0) + weight);
        };
        add(terms(symbol.name), 3);
        add(path, 1);
        add(terms(symbol.signature), 1);
        add(terms(commentAbove(lines, symbol.range[0] - 1) + docstring(lines, symbol.line)), 2);
        // What its body names, once each: a hint, not a weight per mention.
        add([...new Set(terms(lines.slice(symbol.line, Math.min(symbol.range[1], symbol.line + 40)).join(' ')))], 0.5);
        docs.push({ symbol, terms: counts, length: [...counts.values()].reduce((a, b) => a + b, 0) });
      }
    }
    return new ConceptIndex(docs);
  }

  /** The symbols that best answer [query], by BM25, most likely first; none for a query of no content words. */
  search(query: string, options: { limit?: number; kind?: string; path?: string } = {}): { symbol: CodeSymbol; score: number }[] {
    const words = [...new Set(terms(query))];
    if (words.length === 0) return [];
    const expanded = new Map<string, number>(words.map((w) => [w, 1]));
    for (const w of words) for (const o of synonyms.get(w) ?? []) if (!expanded.has(o)) expanded.set(o, 0.5);
    const n = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const scored: { symbol: CodeSymbol; score: number }[] = [];
    for (const d of this.docs) {
      if (options.kind && d.symbol.kind !== options.kind) continue;
      if (options.path && !d.symbol.file.startsWith(options.path)) continue;
      let score = 0;
      const covered = new Set<string>();
      for (const [w, weight] of expanded) {
        const tf = d.terms.get(w);
        if (!tf) continue;
        // A synonym covers the word it stands for.
        for (const q of words) if (q === w || synonyms.get(q)?.includes(w)) covered.add(q);
        const df = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (weight * idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / this.average));
      }
      // An answer that covers more of the question's words beats one that repeats a single word.
      const weight = (kindWeight[d.symbol.kind] ?? 1) * (d.symbol.exported ? 1.1 : 1);
      if (covered.size > 0) scored.push({ symbol: d.symbol, score: score * (covered.size / words.length) * weight });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 10);
  }
}

// The comment block ending just above 0-based [line]: `//`, `#`, `/** … */`, decorators skipped.
function commentAbove(lines: readonly string[], line: number): string {
  const found: string[] = [];
  for (let i = line - 1; i >= 0 && line - i <= 15; i--) {
    const text = (lines[i] ?? '').trim();
    if (text.startsWith('@')) continue;
    if (/^(\/\/|#|\*|\/\*\*|\/\*|\*\/|\/\/\/)/.test(text)) found.unshift(text);
    else break;
  }
  return found.join(' ');
}

// A Python docstring's first lines, after the `def` or `class` at 1-based [line].
function docstring(lines: readonly string[], line: number): string {
  for (let i = line; i < Math.min(lines.length, line + 3); i++) {
    const text = (lines[i] ?? '').trim();
    if (text.startsWith('"""') || text.startsWith("'''")) return ` ${lines.slice(i, i + 6).join(' ')}`;
  }
  return '';
}
