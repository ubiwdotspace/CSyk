import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Tree } from 'web-tree-sitter';
import { declaresFunctionAt, isCallAt, isImportAt, isMemberAt, isValueUseAt, parseFile } from '../index/parse.ts';
import type { SymbolKind } from '../index/symbols.ts';
import { pool, serverFor, textMentions } from '../precision/lsp-service.ts';
import { isTestFile, type CodeSymbol } from '../index/symbols.ts';
import { defaultBudget, fit } from '../token/budget.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { plural, references, resolve, type Location, type ToolResult } from './tools.ts';

const run = promisify(execFile);

// A test has no callers worth following; a helper in a test file (a
// factory, a fixture) has: the tests that use it are what a change reaches.
const isTestCase = (s: CodeSymbol) => s.isTest && /^(test|Test|Benchmark|Fuzz|Example)/.test(s.name);

// More callers than this at one level are listed, not followed further.
const maxFanOut = 40;
// How long `calls` and `impact` resolve mentions in all before answering with
// what they have. Accuracy comes first: at 6 seconds, impact on Prometheus
// found 87.8% of what a change touches, as the language server was still
// loading; at 30, 91.5%, for 28% more CPU.
const toolMs = 30000;

// Kinds a member access calls when it reaches them.
const callableKinds: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'hook', 'component', 'route']);

// Node types a called name can be, across the grammars.
const nameTypes = ['identifier', 'property_identifier', 'field_identifier', 'type_identifier'];

/** One caller of a symbol, or the top level of a file, and the lines it calls from. */
type Caller = { file: string; home?: CodeSymbol; lines: number[] };

/**
 * One callee of a symbol and the lines it is called on: an indexed symbol,
 * or a function local to another, which only has a place and a name.
 */
type Callee = { label: string; file: string; line: number; symbol?: CodeSymbol; lines: number[] };

/**
 * `calls`: who calls a symbol (`in`), or what it calls (`out`), down to
 * [depth] levels. Callers are the references the compiler resolves that sit
 * in call position or behind a member access (`this.f` as a callback),
 * grouped by the symbol around them; callees are the names called in the
 * symbol's body, resolved to their declarations.
 */
export async function calls(
  ws: Workspace,
  target: string,
  options: { direction?: 'in' | 'out'; depth?: number; limit?: number; budget?: number } = {},
): Promise<ToolResult> {
  const { symbol, note } = resolve(ws, target);
  if (!symbol) return { text: note, locations: [] };
  const direction = options.direction ?? 'in';
  const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
  const limit = options.limit ?? Infinity;
  // Each row and the places it names, so only shown rows count as answers.
  const rows: Row[] = [];
  // Callers not followed further, or not listed, make the answer incomplete.
  let cut = false;
  const seen = new Set([symbol.id]);
  let precision = 'lsp';
  const deadline = Date.now() + toolMs;

  const visit = async (from: CodeSymbol, level: number): Promise<void> => {
    const indent = '  '.repeat(level - 1);
    if (direction === 'in') {
      const found = await callersOf(ws, from, deadline);
      if (found.precision !== 'lsp') precision = found.precision;
      // Following every caller of a much-used symbol takes long and shows little.
      const deeper = level < depth && found.callers.length <= maxFanOut;
      if ((level < depth && !deeper) || found.callers.length > limit) cut = true;
      for (const caller of found.callers.slice(0, limit)) {
        const id = caller.home?.id ?? `${caller.file} (top level)`;
        rows.push({
          text: `${indent}${id}  ${caller.lines.join(', ')}`,
          compact: `${indent}${id}`,
          locations: caller.lines.map((line) => ({ file: caller.file, line })),
        });
        if (deeper && caller.home && !isTestCase(caller.home) && !seen.has(caller.home.id)) {
          seen.add(caller.home.id);
          await visit(caller.home, level + 1);
        }
      }
      return;
    }
    const found = await calleesOf(ws, from);
    if (found.precision !== 'lsp') precision = found.precision;
    if (found.callees.length > limit) cut = true;
    for (const callee of found.callees.slice(0, limit)) {
      rows.push({ text: `${indent}${callee.label}  ${callee.line}`, compact: `${indent}${callee.label}`, locations: [{ file: callee.file, line: callee.line }] });
      if (level < depth && callee.symbol && !seen.has(callee.symbol.id)) {
        seen.add(callee.symbol.id);
        await visit(callee.symbol, level + 1);
      }
    }
  };
  await visit(symbol, 1);

  const what = direction === 'in' ? 'caller' : 'callee';
  const header = `calls ${direction} · ${symbol.id} · ${plural(rows.length, what)} · ${precision}${note ? ` · ${note}` : ''}`;
  return shown(header, rows, options.budget ?? defaultBudget, !cut && precision === 'lsp');
}

/**
 * `impact`: what a change touches. The symbols whose lines differ from
 * [since] (the working tree against that revision), their callers down to
 * [depth] levels, and the test files among them.
 */
export async function impact(
  ws: Workspace,
  options: { since?: string; depth?: number; budget?: number } = {},
): Promise<ToolResult> {
  const since = options.since ?? 'HEAD';
  const budget = options.budget ?? defaultBudget;
  const depth = Math.min(Math.max(options.depth ?? 2, 1), 3);
  const changed = new Map<string, CodeSymbol>();
  const files = new Set<string>();
  for (const [file, lines] of await changedLines(ws.root, since)) {
    files.add(file);
    for (const line of lines) {
      const home = ws.index.containing(file, line);
      if (home) changed.set(home.id, home);
    }
  }
  const rows: Row[] = [...changed.values()].map((s) => ({
    text: `changed  ${s.id}  ${s.line}`,
    compact: `changed  ${s.id}`,
    locations: [{ file: s.file, line: s.line }],
  }));
  const tests = new Set([...files].filter(isTestFile));
  const seen = new Set(changed.keys());
  let level = [...changed.values()];
  let precision = 'lsp';
  const deadline = Date.now() + toolMs;
  let stoppedAt = 0;
  for (let step = 1; step <= depth && level.length > 0; step++) {
    const next: CodeSymbol[] = [];
    // A level's searches run a few at a time; their answers are read in order.
    const searches = (await pool(level, 4, async (symbol) => ({ symbol, found: await callersOf(ws, symbol, deadline) }))).filter(
      (s) => s !== undefined,
    );
    for (const { symbol, found } of searches) {
      if (found.precision !== 'lsp') precision = found.precision;
      for (const caller of found.callers) {
        if (isTestFile(caller.file)) tests.add(caller.file);
        const id = caller.home?.id ?? `${caller.file} (top level)`;
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({
          text: `caller ${step}  ${id}  ${caller.lines.join(', ')}  ← ${symbol.name}`,
          compact: `caller ${step}  ${id}`,
          locations: caller.lines.map((line) => ({ file: caller.file, line })),
        });
        if (caller.home && !isTestCase(caller.home)) next.push(caller.home);
      }
    }
    if (step < depth && next.length > maxFanOut) {
      stoppedAt = step;
      break;
    }
    level = next;
  }
  rows.push(...[...tests].sort().map((file) => ({ text: `test  ${file}`, compact: `test  ${file}`, locations: [] })));
  const stopped = stoppedAt ? ` · stopped at caller level ${stoppedAt}: ${maxFanOut}+ callers to follow; run calls on one` : '';
  const header =
    `impact · since ${since} · ${plural(changed.size, 'symbol')} changed in ${plural(files.size, 'file')}` +
    ` · ${plural(tests.size, 'test file')} · ${precision}${stopped}`;
  return shown(header, rows, budget, !stoppedAt && precision === 'lsp');
}

/** A row of `calls` or `impact`, the same without its lines, and the places it names. */
type Row = { text: string; compact: string; locations: Location[] };

// Fits [rows] in the budget; the answer names only the places of rows shown.
// One that lists everything the compiler confirmed says `complete`, so the
// agent need not search again to make sure.
function shown(header: string, rows: Row[], budget: number, complete: boolean): ToolResult {
  const fitted = fit(header, rows.map((r) => r.text), { budget, narrow: 'lower depth', compact: rows.map((r) => r.compact) });
  const text = complete && !fitted.truncated ? fitted.text.replace(header, `${header} · complete`) : fitted.text;
  return { text, locations: rows.slice(0, fitted.shown).flatMap((r) => r.locations) };
}

// The callers of [symbol]: its references in call position, by enclosing symbol.
async function callersOf(
  ws: Workspace,
  symbol: CodeSymbol,
  deadline: number,
): Promise<{ callers: Caller[]; precision: string }> {
  // Dispatch matters here: a call through an interface reaches its implementations.
  // Only uses as a value are resolved, which spares imports, exports and types.
  const { found, precision } = await references(ws, symbol, { viaSupertypes: true, where: isValueUseAt, deadline });
  const byHome = new Map<string, Caller>();
  for (const site of found) {
    const home = ws.index.containing(site.file, site.line + 1);
    const key = home?.id ?? site.file;
    const caller = byHome.get(key) ?? { file: site.file, ...(home ? { home } : {}), lines: [] };
    if (!caller.lines.includes(site.line + 1)) caller.lines.push(site.line + 1);
    byHome.set(key, caller);
  }
  for (const caller of await superCallers(ws, symbol)) {
    const key = caller.home?.id ?? caller.file;
    if (!byHome.has(key)) byHome.set(key, caller);
  }
  const callers = [...byHome.values()].sort((a, b) => a.file.localeCompare(b.file) || (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
  return { callers, precision };
}

// The subclasses of the Dart class [symbol], whose constructors call its
// own through `: super(...)` or `: super.named(...)`, which name no class,
// or, calling none, without a word. TS needs none: its `extends` clause is
// a value, so a use already.
async function superCallers(ws: Workspace, symbol: CodeSymbol): Promise<Caller[]> {
  if (symbol.kind !== 'class' || symbol.lang !== 'dart') return [];
  const extensions = serverFor(symbol.file)?.extensions ?? new Set([extname(symbol.file)]);
  // Another class of the same name: the language server says which one each subclass extends.
  const ambiguous = ws.index.named(symbol.name).filter((s) => s.kind === 'class').length > 1;
  const service = ambiguous ? await ws.precision(symbol.file) : undefined;
  if (ambiguous && !service) return [];
  const callers: Caller[] = [];
  for (const mention of await textMentions(ws.root, symbol.name, extensions)) {
    if (!/\bextends\s+$/.test(mention.text.slice(0, mention.character))) continue;
    const sub = ws.index.containing(mention.file, mention.line + 1);
    if (sub?.kind !== 'class' || sub.id === symbol.id) continue;
    if (service && !(await service.definition(mention)).some((s) => s.file === symbol.file && s.nameLine === symbol.line - 1)) continue;
    const lines = (await readFile(join(ws.root, sub.file), 'utf8')).split('\n');
    const calls: number[] = [];
    for (let n = sub.range[0]; n <= sub.range[1]; n++) {
      const text = lines[n - 1] ?? '';
      if (/(^|[^.\w])super\s*\(|[:,]\s*super\s*\.\s*\w+\s*\(/.test(text)) calls.push(n);
    }
    callers.push({ file: sub.file, home: sub, lines: calls.length > 0 ? calls : [sub.line] });
  }
  return callers;
}

// The callees of [symbol]: each name called in its body, resolved to its
// declaration by the language server, or without one by name.
async function calleesOf(ws: Workspace, symbol: CodeSymbol): Promise<{ callees: Callee[]; precision: string }> {
  const tree = await parseFile(symbol.file, await readFile(join(ws.root, symbol.file), 'utf8'));
  if (!tree) return { callees: [], precision: 'index' };
  const service = await ws.precision(symbol.file);
  const byId = new Map<string, Callee>();
  const trees = new Map<string, Tree | undefined>([[symbol.file, tree]]);
  const treeOf = async (file: string) => {
    if (!trees.has(file)) trees.set(file, await parseFile(file, await readFile(join(ws.root, file), 'utf8')));
    return trees.get(file);
  };
  try {
    // Called names, and names reached through a member access, such as a
    // Python property or a method handed over as a callback.
    const names = tree.rootNode
      .descendantsOfType(nameTypes, { row: symbol.range[0] - 1, column: 0 }, { row: symbol.range[1] - 1, column: 100_000 })
      .flatMap((n) => {
        if (!n) return [];
        const { row, column } = n.startPosition;
        const called = isCallAt(tree, row, column);
        return called || isMemberAt(tree, row, column) ? [{ text: n.text, row, column, called }] : [];
      });
    const resolved = await pool(names, 16, async (name) => {
      const declared: Omit<Callee, 'lines'>[] = [];
      if (!service) {
        const named = ws.index.named(name.text).filter((s) => name.called || callableKinds.has(s.kind));
        declared.push(...named.map((s) => ({ label: s.id, file: s.file, line: s.line, symbol: s })));
      }
      for (const span of service ? await service.definition({ file: symbol.file, line: name.row, character: name.column }) : []) {
        const callee = calleeAt(ws, span.file, span.nameLine + 1, name.text);
        // A member access counts only when it reaches a function.
        if (!name.called && !(callee.symbol && callableKinds.has(callee.symbol.kind))) continue;
        if (callee.symbol) {
          declared.push(callee);
          continue;
        }
        // Without a symbol of its own, the declaration is local: a function
        // declared in another (kept), or a parameter, a destructured name or
        // a variable such as a React state setter, which is no callee. A name
        // a file imports from outside the repo resolves to its import.
        const tree = await treeOf(span.file);
        if (tree && !isImportAt(tree, span.nameLine, span.nameColumn) && declaresFunctionAt(tree, span.nameLine, span.nameColumn)) {
          declared.push(callee);
        }
      }
      return { line: name.row + 1, declared };
    });
    for (const { line, declared } of resolved.filter((r) => r !== undefined)) {
      for (const callee of declared) {
        // The signatures of an overloaded function are one callee: the first.
        const key = callee.symbol ? `${callee.file}#${callee.symbol.parent ?? ''}.${callee.symbol.name}` : callee.label;
        const entry = byId.get(key);
        if (!entry) byId.set(key, { ...callee, lines: [line] });
        else if (!entry.lines.includes(line)) entry.lines.push(line);
        if (entry && callee.line < entry.line) Object.assign(entry, callee);
      }
    }
  } finally {
    for (const t of trees.values()) t?.delete();
  }
  return { callees: [...byId.values()], precision: service ? 'lsp' : 'index' };
}

// The callee declared at [line] of [file] and called as [name]: the symbol
// declared there, a constructor (named by its class, placed at its own
// line), or a local function.
function calleeAt(ws: Workspace, file: string, line: number, name: string): Omit<Callee, 'lines'> {
  // By name too: a parameter declared on its function's line is not the function.
  const exact = ws.index.symbolsIn(file).find((s) => s.line === line && (s.name === name || s.parent === `${file}#${name}`));
  if (exact) return { label: exact.id, file, line, symbol: exact };
  const home = ws.index.containing(file, line);
  if (home?.name === name) return { label: home.id, file, line, symbol: home };
  return { label: `${file}:${line} ${name}`, file, line };
}

// The 1-based lines of each file that differ between [since] and the
// working tree; a deletion marks the line after it.
async function changedLines(root: string, since: string): Promise<Map<string, number[]>> {
  // --relative: paths from the workspace, which may be a folder inside the repo.
  const { stdout } = await run('git', ['diff', '--relative', '--unified=0', '--no-color', '--no-ext-diff', since, '--'], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  const changed = new Map<string, number[]>();
  let file: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk?.[1] || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = changed.get(file) ?? [];
    for (let n = 0; n < Math.max(count, 1); n++) lines.push(Math.max(start + n, 1));
    changed.set(file, lines);
  }
  return changed;
}
