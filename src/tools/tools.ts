// size-ok: the six tools share their formatting, ranking and budget code.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import type { SearchOptions } from '../index/symbol-index.ts';
import { isTestFile, type CodeSymbol } from '../index/symbols.ts';
import type { Position } from '../precision/lsp-client.ts';
import { codeMentions, serverFor, type ReferenceOptions } from '../precision/lsp-service.ts';
import { defaultBudget, estimateTokens, fit } from '../token/budget.ts';
import { bodyHash, Session } from '../token/session.ts';
import type { Workspace } from '../workspace/workspace.ts';

const run = promisify(execFile);

/** A place a tool answered with: repo-relative file, 1-based line. */
export type Location = { file: string; line: number };

/** What a tool returns: the text the agent reads and the places it names. */
export type ToolResult = { text: string; locations: Location[] };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const row = (s: CodeSymbol) => `${s.id}  ${s.kind} ${s.line}  ${s.signature}`;

/** `find`: symbols whose name matches [query], best first. */
export function find(
  ws: Workspace,
  query: string,
  options: SearchOptions & { budget?: number } = {},
  session = new Session(),
): ToolResult {
  const hits = ws.index.search(query, options);
  if (hits.length === 0) {
    const near = ws.index.nearest(query);
    return { text: `no symbol matches${near.length ? `; nearest: ${near.join(', ')}` : ''} · index`, locations: [] };
  }
  const fitted = fit(`${plural(hits.length, 'symbol')} · index`, hits.map(row), {
    budget: options.budget ?? defaultBudget,
    narrow: 'pass kind or path',
    compact: hits.map((s) => `${s.id}  ${s.kind} ${s.line}`),
  });
  const hint = session.hint('find', 'hint: read <id> for the body, refs <id> for its uses');
  return {
    text: [fitted.text, ...hint].join('\n'),
    locations: hits.slice(0, fitted.shown).map((s) => ({ file: s.file, line: s.line })),
  };
}

/** `outline`: the symbols of a file, or of every file under a folder. */
export function outline(ws: Workspace, path: string, options: { budget?: number } = {}): ToolResult {
  const budget = options.budget ?? defaultBudget;
  const clean = path.replace(/^\.\//, '').replace(/\/$/, '');
  if (ws.index.has(clean)) {
    const symbols = ws.index.symbolsIn(clean);
    const indent = (s: CodeSymbol) => (s.parent ? '  ' : '');
    const fitted = fit(
      `${clean} · ${plural(symbols.length, 'symbol')}`,
      symbols.map((s) => `${indent(s)}${s.range[0]}-${s.range[1]} ${s.kind} ${s.name}${s.exported ? '' : ' (local)'}`),
      { budget, narrow: 'read a symbol', compact: symbols.map((s) => `${indent(s)}${s.range[0]} ${s.name}`) },
    );
    return { text: fitted.text, locations: symbols.slice(0, fitted.shown).map((s) => ({ file: s.file, line: s.line })) };
  }
  const files = ws.index.files.filter((f) => clean === '' || clean === '.' || f.startsWith(`${clean}/`));
  if (files.length === 0) return { text: `${clean} · no indexed files here`, locations: [] };
  const names = (file: string) => ws.index.symbolsIn(file).filter((s) => !s.parent).map((s) => s.name);
  const fitted = fit(`${clean || '.'}/ · ${plural(files.length, 'file')}`, files.map((f) => `${f}  ${names(f).join(', ')}`), {
    budget,
    narrow: 'outline a deeper folder',
    compact: files,
  });
  return { text: fitted.text, locations: [] };
}

/**
 * `read`: the exact source of one symbol, or its signature alone. A body
 * this session already saw, unchanged, comes back as a pointer to the call
 * that showed it.
 */
export async function read(
  ws: Workspace,
  target: string,
  options: { mode?: 'body' | 'signature'; context?: number; budget?: number } = {},
  session = new Session(),
): Promise<ToolResult> {
  const { symbol, note } = resolve(ws, target);
  if (!symbol) return { text: note, locations: [] };
  const location = [{ file: symbol.file, line: symbol.line }];
  if (options.mode === 'signature') return { text: `${symbol.id}  ${symbol.signature}`, locations: location };
  const lines = (await readFile(join(ws.root, symbol.file), 'utf8')).split('\n');
  const context = options.context ?? 0;
  const start = Math.max(1, symbol.range[0] - context);
  const end = Math.min(lines.length, symbol.range[1] + context);
  const body = lines.slice(start - 1, end);
  const hash = bodyHash(body.join('\n'));
  const shownAt = session.shown(symbol.id, hash);
  if (shownAt !== undefined) return { text: `[unchanged: ${symbol.id}, shown at call #${shownAt}]`, locations: location };
  const header = `${symbol.id} · lines ${start}-${end}${note ? ` · ${note}` : ''}`;
  const budget = options.budget ?? defaultBudget;
  let kept = body.length;
  while (kept > 0 && estimateTokens([header, ...body.slice(0, kept)].join('\n')) > budget) kept = Math.floor(kept * 0.8);
  if (kept === body.length) {
    session.record(symbol.id, hash);
    return { text: [header, ...body].join('\n'), locations: location };
  }
  // A cut body is not recorded: the agent has not seen all of it.
  const rest = `… ${body.length - kept} more lines; raise budget or read a smaller symbol`;
  return { text: [header, ...body.slice(0, kept), rest].join('\n'), locations: location };
}

/**
 * `refs`: every reference to one symbol from the compiler, one row per file
 * with each line and the symbol it sits in; [code] adds each line's text.
 */
export async function refs(
  ws: Workspace,
  target: string,
  options: { limit?: number; code?: boolean; budget?: number } = {},
): Promise<ToolResult> {
  const { symbol, note } = resolve(ws, target);
  if (!symbol) return { text: note, locations: [] };
  const { found, precision } = await references(ws, symbol);
  const limit = options.limit ?? 50;
  const byFile = new Map<string, number[]>();
  for (const p of found.slice(0, limit)) {
    byFile.set(p.file, [...new Set([...(byFile.get(p.file) ?? []), p.line + 1])].sort((a, b) => a - b));
  }
  const files = [...byFile].sort(([a], [b]) => a.localeCompare(b));
  const header = `${symbol.id} · ${plural(found.length, 'ref')} in ${plural(new Set(found.map((p) => p.file)).size, 'file')} · ${precision}${note ? ` · ${note}` : ''}`;
  const where = (file: string, line: number) => {
    const home = ws.index.containing(file, line);
    return home && home.id !== symbol.id ? `${line}·${home.name}` : `${line}`;
  };
  let rows = files.map(([file, numbers]) => `${file}  ${numbers.map((n) => where(file, n)).join(', ')}`);
  if (options.code) {
    rows = [];
    for (const [file, numbers] of files) {
      const text = (await readFile(join(ws.root, file), 'utf8')).split('\n');
      for (const n of numbers) rows.push(`${file}:${where(file, n)}  ${(text[n - 1] ?? '').trim().slice(0, 100)}`);
    }
  }
  const fitted = fit(header, rows, {
    budget: options.budget ?? defaultBudget,
    narrow: 'raise limit or budget',
    compact: files.map(([file, numbers]) => `${file}  ${numbers.join(', ')}`),
    total: options.code ? found.length : new Set(found.map((p) => p.file)).size,
  });
  const shownFiles = options.code
    ? new Set(rows.slice(0, fitted.shown).map((r) => r.slice(0, r.indexOf(':'))))
    : new Set(files.slice(0, fitted.shown).map(([file]) => file));
  const locations = files
    .filter(([file]) => shownFiles.has(file))
    .flatMap(([file, numbers]) => numbers.map((line) => ({ file, line })));
  return { text: fitted.text, locations };
}

/** `def`: where a name, or the name at a file position, is declared. */
export async function def(
  ws: Workspace,
  target: string | { file: string; line: number; column: number },
): Promise<ToolResult> {
  if (typeof target === 'string') {
    const named = target.includes('#') ? [ws.index.get(target)].filter((s) => s !== undefined) : ws.index.named(target);
    if (named.length === 0) return find(ws, target, { limit: 5 });
    return {
      text: [`${plural(named.length, 'declaration')} · index`, ...named.map(row)].join('\n'),
      locations: named.map((s) => ({ file: s.file, line: s.line })),
    };
  }
  const service = await ws.precision(target.file);
  if (!service) return { text: 'no language server for this file', locations: [] };
  const spans = await service.definition({ file: target.file, line: target.line - 1, character: target.column - 1 });
  if (spans.length === 0) return { text: 'no declaration in the workspace · lsp', locations: [] };
  const locations = spans.map((s) => ({ file: s.file, line: s.nameLine + 1 }));
  const lines = locations.map((l) => {
    const home = ws.index.containing(l.file, l.line);
    return home ? row(home) : `${l.file}:${l.line}`;
  });
  return { text: [`${plural(locations.length, 'declaration')} · lsp`, ...lines].join('\n'), locations };
}

/**
 * `grep`: text matches (a literal, or a regex with [regex]) mapped to the
 * symbol that contains each, at most two per symbol. Source code ranks
 * before tests and tests before other files; a lower-case pattern ignores
 * case.
 */
export async function grep(
  ws: Workspace,
  pattern: string,
  options: { literal?: boolean; path?: string; glob?: string; limit?: number; budget?: number } = {},
): Promise<ToolResult> {
  // --with-filename: a search of one file names it too, as every hit needs.
  const args = ['--line-number', '--with-filename', '--no-heading', '--color', 'never', '--smart-case', '--max-columns', '300'];
  if (options.glob) args.push('--glob', options.glob);
  const search = async (literal: boolean) => {
    const { stdout } = await run(rgPath, [...args, ...(literal ? ['--fixed-strings'] : []), '-e', pattern, '--', options.path ?? '.'], {
      cwd: ws.root,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  };
  let stdout = '';
  try {
    stdout = await search(options.literal === true);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Exit code 1 is ripgrep's "no match"; 2 here is a pattern that is no
    // regex (`f(x`), which is then searched for as written.
    if (code === 2 && !options.literal) stdout = await search(true).catch(() => '');
    else if (code !== 1) throw error;
  }
  type Hit = { file: string; line: number; code: string; home?: CodeSymbol; rank: number };
  const hits: Hit[] = [];
  for (const entry of stdout.split('\n')) {
    const match = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(entry);
    if (!match?.[1] || !match[2] || match[3] === undefined) continue;
    const file = match[1];
    const line = Number(match[2]);
    const home = ws.index.containing(file, line);
    const rank = ws.index.has(file) ? (isTestFile(file) ? 1 : 0) : 2;
    hits.push({ file, line, code: match[3].trim().slice(0, 120), ...(home ? { home } : {}), rank });
  }
  if (hits.length === 0) return { text: 'no match · text', locations: [] };
  hits.sort((a, b) => a.rank - b.rank);
  const limit = options.limit ?? 30;
  const perPlace = new Map<string, number>();
  const shown: Hit[] = [];
  for (const hit of hits) {
    const key = hit.home?.id ?? `${hit.file}:${hit.line}`;
    const count = perPlace.get(key) ?? 0;
    perPlace.set(key, count + 1);
    if (count < 2 && shown.length < limit) shown.push(hit);
  }
  // Too many places to list: the files with the most hits first, code before
  // tests, each with the symbols its hits fall in, so one call shows where
  // the text lives instead of the first thirty lines in path order.
  if (perPlace.size > limit) {
    const byFile = new Map<string, Hit[]>();
    for (const hit of hits) byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit]);
    const files = [...byFile.entries()].sort(
      ([a, x], [b, y]) => (x[0]?.rank ?? 0) - (y[0]?.rank ?? 0) || y.length - x.length || a.localeCompare(b),
    );
    const homes = (fileHits: Hit[]) => [...new Set(fileHits.flatMap((h) => (h.home ? [h.home.name] : [])))];
    const fitted = fit(
      `${plural(hits.length, 'hit')} in ${plural(files.length, 'file')} · text · files with the most hits first`,
      files.map(([file, fileHits]) => {
        const names = homes(fileHits);
        return `${file}  ${fileHits.length}${names.length ? ` · ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}` : ''}`;
      }),
      { budget: options.budget ?? defaultBudget, narrow: 'pass path, glob or a longer pattern to see lines', total: files.length },
    );
    return {
      text: fitted.text,
      locations: files.slice(0, fitted.shown).map(([file, fileHits]) => ({ file, line: fileHits[0]?.line ?? 1 })),
    };
  }
  const fitted = fit(
    `${plural(hits.length, 'hit')} in ${plural(perPlace.size, 'place')} · text`,
    shown.map((h) => `${h.file}:${h.line}  ${h.home?.name ?? '-'}  ${h.code}`),
    {
      budget: options.budget ?? defaultBudget,
      narrow: 'pass path or a longer pattern',
      compact: shown.map((h) => `${h.file}:${h.line}  ${h.home?.name ?? '-'}`),
      total: hits.length,
    },
  );
  return { text: fitted.text, locations: shown.slice(0, fitted.shown).map((h) => ({ file: h.file, line: h.line })) };
}

/**
 * Every reference to [symbol] from its language server (see
 * LspService.references), or without one the mentions of its name in code,
 * which are the best there is.
 */
export async function references(
  ws: Workspace,
  symbol: CodeSymbol,
  options: Omit<ReferenceOptions, 'overloads'> = {},
): Promise<{ found: Position[]; precision: string }> {
  const service = await ws.precision(symbol.file);
  const overloads = ws.index
    .symbolsIn(symbol.file)
    .filter((s) => s !== symbol && s.name === symbol.name && s.parent === symbol.parent);
  // A call through a supertype's method may reach this one: those methods count as it.
  const { methods: related, closed } = options.viaSupertypes ? await supertypeMethods(ws, symbol) : { methods: [], closed: true };
  // Go: its server says which interfaces fit. TS and Dart: the server's own
  // search spans implementations and overrides; Dart's is asked only when
  // the hierarchy stays in the workspace, since a framework one is huge.
  const viaSupertypes =
    options.viaSupertypes === true && (symbol.lang === 'go' || (related.length > 0 && (symbol.lang !== 'dart' || closed)));
  if (service) {
    const group = [...overloads, ...related];
    const { found, partial } = await service.references(symbol, { ...options, viaSupertypes, overloads: group });
    // A much-used name has more mentions than one search resolves in time; say so.
    const cut = partial ? `, partial: ${partial.resolved} of ${partial.total} mentions resolved in time` : '';
    return { found, precision: `lsp${cut}` };
  }
  const extensions = serverFor(symbol.file)?.extensions ?? new Set([extname(symbol.file)]);
  const found = (await codeMentions(ws.root, symbol.name, extensions, options.where)).filter(
    (p) => !(p.file === symbol.file && p.line === symbol.line - 1),
  );
  return { found, precision: 'text (no language server)' };
}

// The same-named methods of the types [symbol]'s type extends, implements
// or mixes in, up to three levels, as declared in the workspace: a call
// through one of those types may reach [symbol]. A framework base such as
// Flutter's State is not in the workspace and adds nothing.
async function supertypeMethods(ws: Workspace, symbol: CodeSymbol): Promise<{ methods: CodeSymbol[]; closed: boolean }> {
  const owner = symbol.parent ? ws.index.get(symbol.parent) : undefined;
  if (!owner) return { methods: [], closed: true };
  const methods: CodeSymbol[] = [];
  // Whether every supertype is declared in the workspace, framework bases none.
  let closed = true;
  const seen = new Set([owner.id]);
  let types = [owner];
  for (let depth = 0; depth < 3 && types.length > 0; depth++) {
    const next: CodeSymbol[] = [];
    for (const type of types) {
      for (const name of await heritageOf(ws, type)) {
        if (!ws.index.named(name).some((s) => supertypeKinds.has(s.kind))) closed = false;
        for (const base of ws.index.named(name)) {
          if (seen.has(base.id) || !supertypeKinds.has(base.kind)) continue;
          seen.add(base.id);
          next.push(base);
          const method = ws.index.symbolsIn(base.file).find((s) => s.parent === base.id && s.name === symbol.name);
          if (method) methods.push(method);
        }
      }
    }
    types = next;
  }
  return { methods, closed };
}

// The type names a declaration extends, implements or mixes in, read from
// its header, which may span lines.
async function heritageOf(ws: Workspace, type: CodeSymbol): Promise<string[]> {
  const lines = (await readFile(join(ws.root, type.file), 'utf8')).split('\n').slice(type.range[0] - 1, type.range[0] + 5);
  const text = lines.join(' ');
  if (type.lang === 'py') return names(/\bclass\s+\w+\s*\(([^)]*)\)/.exec(text)?.[1] ?? '');
  // The header ends at the body's brace, not one inside a Dart primary constructor's parameters.
  let depth = 0;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === '{' && depth === 0) {
      end = i;
      break;
    }
  }
  const header = text.slice(0, end).replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
  return names(/\b(?:extends|implements|with|on)\b(.*)$/.exec(header)?.[1] ?? '');
}

// The type names in a heritage clause, generic arguments left out.
function names(heritage: string): string[] {
  return heritage.replace(/<[^>]*>/g, '').match(/[A-Za-z_]\w*/g) ?? [];
}

const supertypeKinds: ReadonlySet<string> = new Set(['class', 'interface', 'widget', 'provider', 'type']);

/**
 * A symbol by id, or by name: an exact name with several declarations takes
 * the best ranked and names the others.
 */
export function resolve(ws: Workspace, target: string): { symbol?: CodeSymbol; note: string } {
  if (target.includes('#')) {
    const symbol = ws.index.get(target);
    return symbol ? { symbol, note: '' } : { note: `no symbol with id ${target}` };
  }
  const named = ws.index.named(target);
  if (named.length === 0) {
    const near = ws.index.search(target, { limit: 3 }).map((s) => s.id);
    return { note: `no symbol named ${target}${near.length ? `; nearest: ${near.join(', ')}` : ''}` };
  }
  // Ranked among the symbols of exactly this name, not cut first: a close name can rank higher.
  const [best, ...others] = ws.index.search(target, { limit: Number.MAX_SAFE_INTEGER }).filter((s) => s.name === target);
  if (!best) return { note: `no symbol named ${target}` };
  return { symbol: best, note: others.length ? `also named so: ${others.map((s) => s.id).join(', ')}` : '' };
}
