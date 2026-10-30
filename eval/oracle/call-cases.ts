import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver-protocol';
import type { Position, Span } from '../../src/precision/lsp-client.ts';
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
      const expect = await callAnswer(oracle, at(file, symbol), direction);
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
    const expect = await impactAnswer(oracle, changed.map((s) => spanOf(file, s)));
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

/** A D case's answer: the calls in or out of the function at [position]. */
export async function callAnswer(oracle: LspOracle, position: Position, direction: 'in' | 'out'): Promise<Expected[]> {
  return ranges(await oracle.calls(position, direction));
}

/** A G case's answer: the [changed] functions and their callers two levels up. */
export async function impactAnswer(oracle: LspOracle, changed: Span[]): Promise<Expected[]> {
  const spans = [...changed];
  let level = changed;
  for (let step = 0; step < 2; step++) {
    const next: Span[] = [];
    for (const span of level) next.push(...(await oracle.calls({ file: span.file, line: span.nameLine, character: span.nameColumn }, 'in')));
    spans.push(...next);
    level = next;
  }
  return ranges(spans);
}

/**
 * The cases of [cases], each answered again by [oracle]: the same
 * questions, for answers from a better oracle. A D case asks about its
 * name's one declaration; a G case's edits are in the functions it names
 * by line.
 */
export async function answerAgain(oracle: LspOracle, category: 'D' | 'G', cases: CallCase[]): Promise<CallCase[]> {
  const answered: CallCase[] = [];
  // An old answer stays: one the oracle does not give again was found by a server set up otherwise.
  const kept = (c: CallCase, expect: Expected[]) => ({ ...c, expect: union(c.expect, expect) });
  for (const c of cases) {
    if (category === 'D') {
      const [only] = await oracle.declarations(c.query);
      const direction = c.direction ?? 'in';
      // A name no longer declared once keeps its old answer.
      answered.push(only ? kept(c, await callAnswer(oracle, { file: only.file, line: only.nameLine, character: only.nameColumn }, direction)) : c);
      continue;
    }
    const changed: Span[] = [];
    for (const edit of c.query.split(/\s+/)) {
      const [, file = '', line = '0'] = /^(.+):(\d+)$/.exec(edit) ?? [];
      // The smallest function around the edited line.
      const around = (await oracle.symbols(file))
        .filter((s) => callables.has(s.kind) && s.range.start.line < Number(line) && s.range.end.line >= Number(line) - 1)
        .sort((a, b) => a.range.end.line - a.range.start.line - (b.range.end.line - b.range.start.line))[0];
      if (around && !changed.some((s) => s.file === file && s.startLine === around.range.start.line)) changed.push(spanOf(file, around));
    }
    answered.push(kept(c, await impactAnswer(oracle, changed)));
  }
  return answered;
}

/** [old] and the places of [found] it lacks. */
export function union(old: readonly Expected[], found: readonly Expected[]): Expected[] {
  const key = (e: Expected) => `${e.file}:${e.lines.join('-')}`;
  const have = new Set(old.map(key));
  return [...old, ...found.filter((e) => !have.has(key(e)))];
}

function spanOf(file: string, s: DocumentSymbol): Span {
  return { file, startLine: s.range.start.line, endLine: s.range.end.line, nameLine: s.selectionRange.start.line, nameColumn: s.selectionRange.start.character };
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
