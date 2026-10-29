import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver-protocol';
import type { Span } from '../../src/precision/lsp-client.ts';
import type { LspOracle } from './lsp-oracle.ts';
import { shuffle } from './sampling.ts';

export type Expected = { file: string; lines: [number, number] };
export type CallCase = { query: string; direction?: 'in' | 'out'; expect: Expected[] };

const callables: ReadonlySet<SymbolKind> = new Set([SymbolKind.Function, SymbolKind.Method]);

// Names worth asking about: identifiers of five characters or more.
const isSearchable = (name: string) => /^[A-Za-z_$][\w$]{4,}$/.test(name);

/**
 * D cases: the callers of a function or method (`in`), or what it calls
 * (`out`), alternating, as the server's call hierarchy gives them. Only
 * names declared once, so the name alone says which symbol is meant.
 */
export async function callCases(
  oracle: LspOracle,
  files: readonly string[],
  count: number,
  random: () => number,
): Promise<CallCase[]> {
  const cases: CallCase[] = [];
  const seen = new Set<string>();
  for (const file of shuffle(files, random)) {
    if (cases.length >= count) break;
    for (const symbol of shuffle(await oracle.symbols(file), random)) {
      if (!callables.has(symbol.kind) || !isSearchable(symbol.name) || seen.has(symbol.name)) continue;
      seen.add(symbol.name);
      const declarations = await oracle.declarations(symbol.name);
      if (declarations.length !== 1 || declarations[0]?.file !== file) continue;
      const direction = cases.length % 2 === 0 ? 'in' : 'out';
      const expect = ranges(await oracle.calls(at(file, symbol), direction));
      if (expect.length === 0 || expect.length > 30) continue;
      cases.push({ query: symbol.name, direction, expect });
      break;
    }
  }
  return cases;
}

/**
 * G cases: a change to one or two functions of a file, written as the
 * `file:line` of each edited line (the harness adds a space at its end).
 * Expected: the changed functions and their callers two levels up, from the
 * server's call hierarchy.
 */
export async function impactCases(
  oracle: LspOracle,
  files: readonly string[],
  count: number,
  random: () => number,
): Promise<CallCase[]> {
  const cases: CallCase[] = [];
  for (const file of shuffle(files, random)) {
    if (cases.length >= count) break;
    const bodies = shuffle(await oracle.symbols(file), random).filter(
      (s) => callables.has(s.kind) && s.range.end.line - s.range.start.line >= 3,
    );
    const changed = bodies.slice(0, random() < 0.5 ? 1 : 2);
    if (changed.length === 0) continue;
    const spans: Span[] = changed.map((s) => ({
      file,
      startLine: s.range.start.line,
      endLine: s.range.end.line,
      nameLine: s.selectionRange.start.line,
      nameColumn: s.selectionRange.start.character,
    }));
    let level = spans;
    for (let step = 0; step < 2; step++) {
      const next: Span[] = [];
      for (const span of level) next.push(...(await oracle.calls({ file: span.file, line: span.nameLine, character: span.nameColumn }, 'in')));
      spans.push(...next);
      level = next;
    }
    const expect = ranges(spans);
    if (expect.length <= changed.length || expect.length > 40) continue;
    // A line strictly inside each body, so the change is the function's own.
    const edits = changed.map((s) => {
      const inside = s.range.end.line - s.range.start.line - 1;
      return `${file}:${s.range.start.line + 2 + Math.floor(random() * inside)}`;
    });
    cases.push({ query: edits.join(' '), expect });
  }
  return cases;
}

function at(file: string, symbol: DocumentSymbol) {
  return { file, line: symbol.selectionRange.start.line, character: symbol.selectionRange.start.character };
}

// Each span's whole range, 1-based, once.
function ranges(spans: Span[]): Expected[] {
  const unique = new Map<string, Expected>();
  for (const s of spans) unique.set(`${s.file}:${s.startLine}`, { file: s.file, lines: [s.startLine + 1, s.endLine + 1] });
  return [...unique.values()];
}
