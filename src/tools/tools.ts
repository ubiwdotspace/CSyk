// size-ok: the six tools share their formatting, ranking and budget code.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import type { SearchOptions } from '../index/symbol-index.ts';
import { isTestFile, type CodeSymbol } from '../index/symbols.ts';
import type { Position } from '../precision/lsp-client.ts';
import { codeMentions, serverFor, type ReferenceOptions } from '../precision/lsp-service.ts';
import { defaultBudget, estimateTokens, fit } from '../token/budget.ts';
import { bodyHash, Session } from '../token/session.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { mentionsOutsideCode, projectFile } from './other-files.ts';

const run = promisify(execFile);

/** A place a tool answered with: repo-relative file, 1-based line. */
export type Location = { file: string; line: number };

/** What a tool returns: the text the agent reads and the places it names. */
export type ToolResult = { text: string; locations: Location[] };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const row = (s: CodeSymbol) => `${s.id}  ${s.kind} ${s.line}  ${s.signature}`;

/** `find`: symbols whose name matches [query], best first. */
export async function find(
  ws: Workspace,
  query: string,
  options: SearchOptions & { budget?: number } = {},
  session = new Session(),
): Promise<ToolResult> {
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
  // The one symbol of exactly this name, when small, comes with its source.
  const only = hits[0]?.name === query && ws.index.named(query).length === 1 && !session.long ? hits[0] : undefined;
  const body = only ? await bodies(ws, [only], session, 40, (options.budget ?? defaultBudget) - estimateTokens(fitted.text)) : [];
  const hint = body.length ? [] : session.hint('find', 'hint: read <id> for the body, refs <id> for its uses');
  return {
    text: [fitted.text, ...body, ...hint].join('\n'),
    locations: hits.slice(0, fitted.shown).map((s) => ({ file: s.file, line: s.line })),
  };
}

// Tokens a grep may add for the source around its hits. Measured on public
// benchmarks, an agent read a hit's file next after 43% of greps with no
// source, 19% with up to 1,000 tokens of it, and 17% with more: past this,
// source costs more on every later turn than the reads it saves.
const sourceBudget = 1000;

/**
 * The lines around [hits], merged per file, as far as [budget] allows, and
 * the hits they cover (as `file:line`).
 */
async function excerpts(
  ws: Workspace,
  hits: { file: string; line: number }[],
  budget: number,
): Promise<{ parts: string[]; covered: Set<string> }> {
  const parts: string[] = [];
  const covered = new Set<string>();
  for (const file of new Set(hits.map((h) => h.file))) {
    const lines = (await readFile(join(ws.root, file), 'utf8')).split('\n');
    const inFile = hits.filter((h) => h.file === file).sort((a, b) => a.line - b.line);
    const windows: [number, number][] = [];
    for (const { line } of inFile) {
      const [from, to] = [Math.max(1, line - 5), Math.min(lines.length, line + 10)];
      const last = windows.at(-1);
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
      else windows.push([from, to]);
    }
    for (const [from, to] of windows) {
      const part = [`${file} · lines ${from}-${to}`, ...lines.slice(from - 1, to)];
      if (estimateTokens([...parts, ...part].join('\n')) > budget) return { parts, covered };
      parts.push(...part);
      for (const { line } of inFile) if (line >= from && line <= to) covered.add(`${file}:${line}`);
    }
  }
  return { parts, covered };
}

/**
 * The source of [symbols] when they come to at most [maxLines] lines and
 * fit [budget]: reading them would cost the agent a whole turn of context,
 * far more than the lines. A body the session already saw, unchanged, is a
 * pointer instead; bodies shown are recorded, so a later `read` is one too.
 */
async function bodies(ws: Workspace, symbols: CodeSymbol[], session: Session, maxLines: number, budget: number): Promise<string[]> {
  const total = symbols.reduce((n, s) => n + s.range[1] - s.range[0] + 1, 0);
  if (symbols.length === 0 || total > maxLines) return [];
  const parts: string[] = [];
  const shown: { id: string; hash: string }[] = [];
  for (const symbol of symbols) {
    const lines = (await readFile(join(ws.root, symbol.file), 'utf8')).split('\n').slice(symbol.range[0] - 1, symbol.range[1]);
    const hash = bodyHash(lines.join('\n'));
    const at = session.shown(symbol.id, hash);
    if (at !== undefined) {
      parts.push(`[unchanged: ${symbol.id}, shown at call #${at}]`);
      continue;
    }
    parts.push(`${symbol.id} · lines ${symbol.range[0]}-${symbol.range[1]}`, ...lines);
    shown.push({ id: symbol.id, hash });
  }
  if (estimateTokens(parts.join('\n')) > budget) return [];
  for (const { id, hash } of shown) session.record(id, hash);
  return parts;
}

/** `outline`: the symbols of a file, or of every file under a folder. */
export function outline(ws: Workspace, path: string, options: { budget?: number } = {}): ToolResult {
  const budget = options.budget ?? defaultBudget;
  const clean = path.replace(/^\.\//, '').replace(/\/$/, '');
  if (ws.index.has(clean)) {
    // Functions inside functions are found and followed, not listed in an outline.
    const symbols = ws.index.symbolsIn(clean).filter((s) => !s.nested);
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
    narrow: 'read a deeper folder',
    compact: files,
  });
  return { text: fitted.text, locations: [] };
}

/**
 * `read`: the exact source of one symbol, or its signature alone. A body
 * this session already saw, unchanged, comes back as a pointer to the call
 * that showed it.
 */
/** A file or folder: a short file whole, since its outline would only lead to reading it; else its symbols. */
export async function readPath(ws: Workspace, path: string, budget = defaultBudget): Promise<ToolResult> {
  if (ws.index.has(path)) {
    const text = await readFile(join(ws.root, path), 'utf8');
    const count = text.split('\n').length;
    if (count <= 200 && estimateTokens(text) <= budget) return { text: `${path} · lines 1-${count}\n${text}`, locations: [{ file: path, line: 1 }] };
  }
  return outline(ws, path, { budget });
}

/**
 * [file]'s lines [start] to [end], as grep and stack traces print them; one
 * line alone is the small symbol around it, or the lines just after it.
 */
async function readLines(ws: Workspace, file: string, start: number, end: number | undefined, budget = defaultBudget, session: Session): Promise<ToolResult> {
  const home = end === undefined ? ws.index.containing(file, start) : undefined;
  if (home && home.range[1] - home.range[0] < 120) return read(ws, home.id, { budget }, session);
  const all = (await readFile(join(ws.root, file), 'utf8')).split('\n');
  const from = Math.max(1, end === undefined ? start - 10 : start);
  const to = Math.min(all.length, end ?? start + 40, from + 199);
  const header = `${file} · lines ${from}-${to}`;
  let kept = to - from + 1;
  while (kept > 0 && estimateTokens([header, ...all.slice(from - 1, from - 1 + kept)].join('\n')) > budget) kept = Math.floor(kept * 0.8);
  return { text: [`${file} · lines ${from}-${from + kept - 1}`, ...all.slice(from - 1, from - 1 + kept)].join('\n'), locations: [{ file, line: from }] };
}

export async function read(
  ws: Workspace,
  target: string,
  options: { mode?: 'body' | 'signature'; context?: number; budget?: number } = {},
  session = new Session(),
): Promise<ToolResult> {
  const at = /^(.+?):(\d+)(?:-(\d+))?$/.exec(target);
  if (at?.[1] && (ws.index.has(at[1]) || projectFile(ws, at[1]))) return readLines(ws, at[1], Number(at[2]), at[3] ? Number(at[3]) : undefined, options.budget, session);
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
  const rest = `… ${body.length - kept} more lines; read ${symbol.file}:${start + kept}-${end} for them`;
  return { text: [header, ...body.slice(0, kept), rest].join('\n'), locations: location };
}

/**
 * Mentions the compiler could not resolve, by file, as `file line, line; …`
 * with each line written by [label]: code before tests, six files of five
 * lines at most, then how many more.
 */
export function unresolvedRow(mentions: readonly Position[], label: (file: string, line: number) => string = (_, line) => `${line}`): string {
  const byFile = new Map<string, Set<number>>();
  for (const p of mentions) byFile.set(p.file, (byFile.get(p.file) ?? new Set()).add(p.line + 1));
  const files = [...byFile].sort(([a], [b]) => Number(isTestFile(a)) - Number(isTestFile(b)) || a.localeCompare(b));
  const shown = files.slice(0, 6).map(([file, set]) => {
    const lines = [...set].sort((a, b) => a - b);
    const more = lines.length > 5 ? ` +${lines.length - 5}` : '';
    return `${file} ${lines.slice(0, 5).map((n) => label(file, n)).join(', ')}${more}`;
  });
  const rest = files.length > 6 ? ` (+${files.length - 6} more files)` : '';
  return `${shown.join('; ')}${rest}`;
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
  const { found, precision, unconfirmed = [] } = await references(ws, symbol);
  const limit = options.limit ?? Infinity;
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
    narrow: 'grep the name with a path to see them',
    compact: files.map(([file, numbers]) => `${file}  ${numbers.join(', ')}`),
    total: options.code ? found.length : new Set(found.map((p) => p.file)).size,
  });
  // Docs, specs, configs and translations that name it, which the compiler does not see.
  const outside = await mentionsOutsideCode(ws.root, symbol.name);
  const more = outside.total > outside.shown.length ? ` (+${outside.total - outside.shown.length} more)` : '';
  // Every use the compiler confirmed, listed, and no mention it could not
  // resolve: nothing to search again for.
  const complete = precision === 'lsp' && !fitted.truncated && found.length <= limit && unconfirmed.length === 0;
  const listed = complete ? fitted.text.replace(header, `${header} · complete`) : fitted.text;
  const unknown = unconfirmed.length > 0 ? `\nunconfirmed, the compiler cannot tell: ${unresolvedRow(unconfirmed, where)}` : '';
  const text = outside.total > 0 ? `${listed}${unknown}\noutside code: ${outside.shown.join(', ')}${more}` : `${listed}${unknown}`;
  const shownFiles = options.code
    ? new Set(rows.slice(0, fitted.shown).map((r) => r.slice(0, r.indexOf(':'))))
    : new Set(files.slice(0, fitted.shown).map(([file]) => file));
  const locations = files
    .filter(([file]) => shownFiles.has(file))
    .flatMap(([file, numbers]) => numbers.map((line) => ({ file, line })));
  return { text, locations };
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
 * symbol that contains each. Source code ranks before tests and tests before
 * other files; a lower-case pattern ignores case.
 */
// The budget of a brief answer: a few lines, no source.
const briefBudget = 400;

export async function grep(
  ws: Workspace,
  pattern: string,
  options: { literal?: boolean; path?: string; glob?: string; budget?: number; brief?: boolean } = {},
  session = new Session(),
): Promise<ToolResult> {
  // A long session gets a short list: on the public benchmarks, its context
  // grew a thousand tokens a turn faster than with the built-in Grep. A brief
  // answer (the wider search after a miss) is shorter still.
  const listBudget = options.brief ? briefBudget : (options.budget ?? (session.long ? 600 : defaultBudget));
  // --with-filename: a search of one file names it too, as every hit needs.
  const args = ['--line-number', '--with-filename', '--no-heading', '--color', 'never', '--smart-case', '--max-columns', '300'];
  if (options.glob) args.push('--glob', options.glob);
  const search = async (literal: boolean) => {
    const { stdout } = await run(rgPath, ['--path-separator', '/', ...args, ...(literal ? ['--fixed-strings'] : []), '-e', pattern, '--', options.path ?? '.'], {
      cwd: ws.root,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  };
  let stdout = '';
  try {
    // A missing path is searched as no match, not as ripgrep's error.
    if (options.path && !existsSync(join(ws.root, options.path))) throw Object.assign(new Error(), { code: 1 });
    stdout = await search(options.literal === true);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Exit code 1 is ripgrep's "no match"; 2 here is a pattern that is no
    // regex (`f(x`), which is then searched for as written.
    if (code === 2 && !options.literal) stdout = await search(true).catch(() => '');
    else if (code !== 1) throw error;
  }
  // Files hit while the index still fills are indexed first, for their symbols.
  await ws.indexNow([...new Set(stdout.split('\n').map((entry) => /^(?:\.\/)?(.+?):\d+:/.exec(entry)?.[1] ?? ''))].slice(0, 200));
  const hits: Hit[] = [];
  for (const entry of stdout.split('\n')) {
    const match = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(entry);
    if (!match?.[1] || !match[2] || match[3] === undefined) continue;
    const file = match[1];
    const line = Number(match[2]);
    const home = ws.index.containing(file, line);
    const rank = ws.index.has(file) && !file.endsWith('.md') ? (isTestFile(file) ? 1 : 0) : 2;
    hits.push({ file, line, code: match[3].trim().slice(0, 120), ...(home ? { home } : {}), rank });
  }
  if (hits.length === 0) {
    // A guessed folder that misses costs a turn: search everywhere instead,
    // briefly. The agent aimed elsewhere, and a full list of the other hits
    // (over a thousand tokens on the public benchmarks) would be re-read on
    // every later turn.
    if (!options.path || options.path === '.') return { text: 'no match · text', locations: [] };
    const wider = await grep(ws, pattern, { ...options, path: undefined, brief: true }, session);
    return { ...wider, text: `no match in ${options.path}; everywhere: ${wider.text}` };
  }
  hits.sort((a, b) => a.rank - b.rank);
  const byFile = new Map<string, Hit[]>();
  for (const hit of hits) byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit]);
  const places = new Map<string, Hit[]>();
  for (const hit of hits) places.set(hit.home?.id ?? `${hit.file}:${hit.line}`, [...(places.get(hit.home?.id ?? `${hit.file}:${hit.line}`) ?? []), hit]);
  // The most complete answer that fits: every hit with its text, else every
  // place with its lines, else every file with its count. A rung shows all
  // it covers or gives way to the next: a list cut short hid the files past
  // it, and the agent grepped again for them.
  const rows = groupByFile([`${plural(hits.length, 'hit')} in ${plural(places.size, 'place')} · text · complete`, ...hits.map(hitRow)]);
  if (estimateTokens(rows.join('\n')) <= listBudget) return withSource(ws, hits, rows, session, options.brief);
  const lines = [
    `${plural(hits.length, 'hit')} in ${plural(places.size, 'place')} · text · lines per symbol · complete`,
    ...[...byFile].map(([file, fileHits]) => `${file}  ${linesPerPlace(fileHits)}`),
  ];
  if (estimateTokens(lines.join('\n')) <= listBudget) {
    return { text: lines.join('\n'), locations: [...places.values()].map(([h]) => ({ file: h?.file ?? '', line: h?.line ?? 1 })) };
  }
  // The files with the most hits first, code before tests, each with the
  // symbols its hits fall in: where the text lives, not the first files in
  // path order.
  const files = [...byFile.entries()].sort(([a, x], [b, y]) => (x[0]?.rank ?? 0) - (y[0]?.rank ?? 0) || y.length - x.length || a.localeCompare(b));
  const homes = (fileHits: Hit[]) => [...new Set(fileHits.flatMap((h) => (h.home ? [h.home.name] : [])))];
  const fitted = fit(
    `${plural(hits.length, 'hit')} in ${plural(files.length, 'file')} · text · files with the most hits first`,
    files.map(([file, fileHits]) => {
      const names = homes(fileHits);
      return `${file}  ${fileHits.length}${names.length ? ` · ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}` : ''}`;
    }),
    { budget: listBudget, narrow: 'pass path, glob or a longer pattern to see lines', total: files.length },
  );
  return { text: fitted.text, locations: files.slice(0, fitted.shown).map(([file, fileHits]) => ({ file, line: fileHits[0]?.line ?? 1 })) };
}

type Hit = { file: string; line: number; code: string; home?: CodeSymbol; rank: number };

const hitRow = (h: Hit) => `${h.file}:${h.line}  ${h.home?.name ?? '-'}  ${h.code}`;

// One file's hit lines, by the symbol they are in: `12 · render 40, 41`.
function linesPerPlace(fileHits: Hit[]): string {
  const byHome = new Map<string, number[]>();
  for (const h of fileHits) byHome.set(h.home?.name ?? '', [...(byHome.get(h.home?.name ?? '') ?? []), h.line]);
  return [...byHome].map(([name, at]) => `${name ? `${name} ` : ''}${lineRuns(at)}`).join(' · ');
}

// Lines in order, three or more in a row as a range: `113, 120-168`. A table
// or an enum hit on every line listed each one (349 tokens of numbers for one
// grep on vscode); the range says the same.
function lineRuns(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}-${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * Every hit listed, with source when there is room: hits in a few small
 * symbols bring their source, hits in a few files the lines around them.
 * After a grep without them, agents read the place next more often than
 * not, and that turn re-reads the whole context. A hit the source shows
 * need not repeat its text; one past it keeps it, or the agent reads the
 * file for it.
 */
async function withSource(ws: Workspace, hits: Hit[], rows: string[], session: Session, brief?: boolean): Promise<ToolResult> {
  const locations = hits.map((h) => ({ file: h.file, line: h.line }));
  const room = session.long || brief ? 0 : sourceBudget;
  if (room === 0) return { text: rows.join('\n'), locations };
  const homes = [...new Map(hits.flatMap((h) => (h.home ? [[h.home.id, h.home] as const] : []))).values()];
  let body = homes.length <= 3 ? await bodies(ws, homes, session, 120, room) : [];
  let shows = (h: Hit) => h.home !== undefined;
  if (body.length === 0 && byFileCount(hits) <= 3) {
    const around = await excerpts(ws, hits, room);
    body = around.parts;
    shows = (h) => around.covered.has(`${h.file}:${h.line}`);
  }
  if (body.length === 0) return { text: rows.join('\n'), locations };
  const list = groupByFile([rows[0] ?? '', ...hits.map((h) => (shows(h) ? `${h.file}:${h.line}  ${h.home?.name ?? '-'}` : hitRow(h)))]);
  return { text: [...list, ...body].join('\n'), locations };
}

const byFileCount = (hits: Hit[]) => new Set(hits.map((h) => h.file)).size;

/**
 * A grep list with the rows of a file that has several hits under the
 * file's path, given once: in a large repository the path is often longer
 * than the hit, and was repeated on every row. Files keep the order of
 * their first row; a file with one hit keeps its `file:line` row.
 */
function groupByFile(list: string[]): string[] {
  const row = /^(\S.*?):(\d+) {2}(.*)$/;
  const byFile = new Map<string, string[]>();
  const rest: string[] = [];
  for (const line of list.slice(1)) {
    const match = row.exec(line);
    if (match?.[1]) byFile.set(match[1], [...(byFile.get(match[1]) ?? []), `  ${match[2]}  ${match[3]}`]);
    else rest.push(line);
  }
  const grouped = [...byFile].flatMap(([file, rows]) => (rows.length === 1 ? [`${file}:${rows[0]?.trimStart()}`] : [file, ...rows]));
  return [list[0] ?? '', ...grouped, ...rest];
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
): Promise<{ found: Position[]; precision: string; unconfirmed?: Position[] }> {
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
    const { found: all, partial, throughBase, stopped, unconfirmed } = await service.references(symbol, { ...options, viaSupertypes, overloads: group, bases: related });
    if (stopped) {
      const mentions = (await codeMentions(ws.root, symbol.name, serverFor(symbol.file)?.extensions ?? new Set([extname(symbol.file)]), options.where)).filter(
        (p) => !(p.file === symbol.file && p.line === symbol.line - 1),
      );
      return { found: mentions, precision: 'text, unconfirmed: the language server stopped; it starts again on the next call' };
    }
    const found = throughBase?.length ? await withoutSiblingCalls(ws, symbol, all, throughBase) : all;
    // A server still loading the project resolves nothing in time: its unconfirmed mentions beat none.
    if (found.length === 0 && partial?.resolved === 0) {
      const mentions = (await codeMentions(ws.root, symbol.name, serverFor(symbol.file)?.extensions ?? new Set([extname(symbol.file)]), options.where)).filter(
        (p) => !(p.file === symbol.file && p.line === symbol.line - 1),
      );
      return { found: mentions, precision: `text, unconfirmed: the language server is still loading (${partial.total} mentions)` };
    }
    // A much-used name has more mentions than one search resolves in time; say
    // so, and what to do, where the agent reads it rather than in a skill.
    const cut = partial ? `, partial: ${partial.resolved} of ${partial.total} mentions resolved in time; grep the name in a folder for the rest` : '';
    return { found, precision: `lsp${cut}`, ...(unconfirmed?.length ? { unconfirmed } : {}) };
  }
  const extensions = serverFor(symbol.file)?.extensions ?? new Set([extname(symbol.file)]);
  const found = (await codeMentions(ws.root, symbol.name, extensions, options.where)).filter(
    (p) => !(p.file === symbol.file && p.line === symbol.line - 1),
  );
  return { found, precision: ws.stopped(symbol.file) ? 'text (the language server stopped twice)' : 'text (no language server)' };
}

/**
 * [found] less the calls through a supertype's method that cannot run
 * [symbol]: `this.m()` (`self.m()`) in a class that is neither [symbol]'s
 * class nor below or above it, a sibling, dispatches to its own m or the
 * supertype's, never to [symbol]'s.
 */
async function withoutSiblingCalls(ws: Workspace, symbol: CodeSymbol, found: Position[], throughBase: Position[]): Promise<Position[]> {
  const owner = symbol.parent ? ws.index.get(symbol.parent) : undefined;
  if (!owner) return found;
  const above = await ancestorNames(ws, owner);
  const lines = new Map<string, string[]>();
  const sibling = new Set<Position>();
  for (const p of throughBase) {
    if (!lines.has(p.file)) lines.set(p.file, (await readFile(join(ws.root, p.file), 'utf8')).split('\n'));
    if (!/\b(?:this|self)\s*\.\s*$/.test((lines.get(p.file)?.[p.line] ?? '').slice(0, p.character))) continue;
    let home = ws.index.containing(p.file, p.line + 1);
    while (home && !classKinds.has(home.kind)) home = home.parent ? ws.index.get(home.parent) : undefined;
    if (!home || home.name === owner.name || above.has(home.name) || (await ancestorNames(ws, home)).has(owner.name)) continue;
    sibling.add(p);
  }
  const drop = new Set([...sibling].map((p) => `${p.file}:${p.line}:${p.character}`));
  return found.filter((p) => !drop.has(`${p.file}:${p.line}:${p.character}`));
}

// The names of the types [type] extends, up to four levels, as declared in the workspace.
async function ancestorNames(ws: Workspace, type: CodeSymbol): Promise<Set<string>> {
  const names = new Set<string>();
  let level = [type];
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    const next: CodeSymbol[] = [];
    for (const t of level) {
      for (const name of await heritageOf(ws, t)) {
        if (names.has(name)) continue;
        names.add(name);
        const types = (await typesNamed(ws, name, t.file)).filter((s) => classKinds.has(s.kind));
        for (const type of types) names.add(type.name);
        next.push(...types);
      }
    }
    level = next;
  }
  return names;
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
        const bases = await typesNamed(ws, name, type.file);
        if (bases.length === 0) closed = false;
        for (const base of bases) {
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

/**
 * The types [name] stands for in [file]: those declared so in the
 * workspace, or else the default export of the module [file] imports it
 * from, under another name (parse-server's `import BaseCodeAuthAdapter
 * from './BaseCodeAuthAdapter'` for `export default class BaseAuthCodeAdapter`).
 */
async function typesNamed(ws: Workspace, name: string, file: string): Promise<CodeSymbol[]> {
  const named = ws.index.named(name).filter((s) => supertypeKinds.has(s.kind));
  if (named.length > 0) return named;
  const text = await readFile(join(ws.root, file), 'utf8').catch(() => '');
  const imported = new RegExp(`^\\s*import\\s+${name.replace(/[$]/g, '\\$')}\\s*(?:,[^'"]*)?from\\s*['"](\\.{1,2}/[^'"]+)['"]`, 'm').exec(text)?.[1];
  if (!imported) return [];
  const base = join(dirname(file), imported).replace(/\.[cm]?[jt]sx?$/, '');
  const target = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'].map((ext) => base + ext).find((f) => ws.index.has(f));
  if (!target) return [];
  const lines = (await readFile(join(ws.root, target), 'utf8')).split('\n');
  return ws.index.symbolsIn(target).filter((s) => !s.parent && supertypeKinds.has(s.kind) && /\bexport\s+default\b/.test(lines[s.line - 1] ?? ''));
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
  let header = text.slice(0, end).replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
  // Type parameters first, nested ones too: in `class A<P extends Props>`
  // the props type is a bound, not what A extends.
  while (/<[^<>]*>/.test(header)) header = header.replace(/<[^<>]*>/g, '');
  return names(/\b(?:extends|implements|with|on)\b(.*)$/.exec(header)?.[1] ?? '');
}

// The type names in a heritage clause, generic arguments left out.
function names(heritage: string): string[] {
  return (heritage.replace(/<[^>]*>/g, '').match(/[A-Za-z_]\w*/g) ?? []).filter((name) => !heritageWords.has(name));
}

const heritageWords = new Set(['extends', 'implements', 'with', 'on']);

const supertypeKinds: ReadonlySet<string> = new Set(['class', 'interface', 'widget', 'provider', 'type']);
// Kinds a `this` belongs to: classes, React class components included.
export const classKinds: ReadonlySet<string> = new Set(['class', 'component', 'widget', 'provider']);

/**
 * A symbol by id, or by name: an exact name with several declarations takes
 * the best ranked and names the others.
 */
export function resolve(ws: Workspace, target: string): { symbol?: CodeSymbol; note: string } {
  // Agents also write file:name or file::name for file#name.
  const colon = /^(.+?\.\w+)::?([\w.$]+)$/.exec(target);
  const id = !target.includes('#') && colon?.[1] && ws.index.has(colon[1]) ? `${colon[1]}#${colon[2]}` : target;
  if (id.includes('#')) {
    const symbol = ws.index.get(id);
    if (symbol) return { symbol, note: '' };
    // A method named without its class: the one symbol of that name in the file.
    const [file = '', name = ''] = id.split('#');
    const inFile = ws.index.symbolsIn(file).filter((s) => s.name === name.split('.').pop());
    return inFile.length === 1 ? { symbol: inFile[0], note: '' } : { note: `no symbol with id ${id}` };
  }
  if (target.includes('/')) {
    const base = target.split('/').filter(Boolean).pop() ?? '';
    const similar = ws.index.files.filter((f) => f.endsWith(`/${base}`) || f.includes(`/${base}/`)).slice(0, 5);
    return { note: `no file or symbol ${target}${similar.length ? `; similar paths: ${similar.join(', ')}` : ''}` };
  }
  // Class.method without its file.
  const qualified = target.includes('.') ? ws.index.named(target.split('.').pop() ?? '').filter((s) => s.id.endsWith(`#${target}`)) : [];
  if (qualified.length) return { symbol: qualified[0], note: qualified.length > 1 ? `also: ${qualified.slice(1).map((s) => s.id).join(', ')}` : '' };
  const named = ws.index.named(target);
  if (named.length === 0) {
    const near = ws.index.search(target, { limit: 3 }).map((s) => s.id);
    return { note: `no symbol named ${target}${near.length ? `; nearest: ${near.join(', ')}` : ''}` };
  }
  // Ranked among the symbols of exactly this name, not cut first: a close name can rank higher.
  const ranked = ws.index.search(target, { limit: Number.MAX_SAFE_INTEGER }).filter((s) => s.name === target);
  // An override gives way to the declaration it overrides, which calls through the base type reach.
  let best = ranked[0];
  for (let base = best && baseOf(ws, best, ranked); base; base = baseOf(ws, base, ranked)) best = base;
  if (!best) return { note: `no symbol named ${target}` };
  const others = ranked.filter((s) => s !== best);
  return { symbol: best, note: others.length ? `also named so: ${others.map((s) => s.id).join(', ')}` : '' };
}

// Among [candidates], the member that [member] overrides: its class's header names the other's class.
function baseOf(ws: Workspace, member: CodeSymbol, candidates: CodeSymbol[]): CodeSymbol | undefined {
  const owner = member.parent ? ws.index.get(member.parent) : undefined;
  const heritage = owner ? names(/\b(?:extends|implements|with)\b(.*)$/.exec(owner.signature)?.[1] ?? '') : [];
  return candidates.find((c) => c !== member && c.parent && heritage.includes(ws.index.get(c.parent)?.name ?? ''));
}
