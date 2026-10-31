import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Tree } from 'web-tree-sitter';
import { declaresFunctionAt, isCallAt, isImportAt, isMemberAt, isValueUseAt, parseFile } from '../index/parse.ts';
import type { SymbolKind } from '../index/symbols.ts';
import type { Position } from '../precision/lsp-client.ts';
import { distance, pool, serverFor, textMentions } from '../precision/lsp-service.ts';
import { isTestFile, type CodeSymbol } from '../index/symbols.ts';
import { defaultBudget, fit } from '../token/budget.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { classKinds, plural, references, resolve, unresolvedRow, type Location, type ToolResult } from './tools.ts';

const run = promisify(execFile);

// A test has no callers worth following; a helper in a test file (a
// factory, a fixture) has: the tests that use it are what a change reaches.
// Python's runners take any name starting test; Go's take TestXxx (and
// Benchmark, Fuzz, Example), so its testXxx is a helper, as pocketbase's
// testDefaultFieldIdValidation, which thirteen tests call. A TS, JS or
// Dart test is a callback (`it`, `test`), so a named function there is a
// helper, as zustand's TestUseShallowSimple component.
const isTestCase = (s: CodeSymbol) =>
  s.isTest &&
  ((s.lang === 'py' && /^(test|Test)/.test(s.name)) || (s.lang === 'go' && /^(Test|Benchmark|Fuzz|Example)(?![a-z])/.test(s.name)));

// The callers a level is followed further through, at most, the nearest
// first: past this, or past the deadline, the answer says how many were
// followed. A fixed 40 had dropped every second-level caller of a
// much-used function (django's Model.save expects 257 places); the
// deadline bounds the time, this the work.
const maxFollow = 200;

// [callers] to follow next, at most maxFollow: code before tests, then the
// files nearest [from].
function nearestFirst(callers: CodeSymbol[], from: string[]): CodeSymbol[] {
  const near = (s: CodeSymbol) => Math.min(...from.map((f) => distance(f, s.file)));
  return [...callers].sort((a, b) => Number(a.isTest) - Number(b.isTest) || near(a) - near(b)).slice(0, maxFollow);
}
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
  const unknown = new Map<string, Position[]>();

  const visit = async (from: CodeSymbol, level: number): Promise<void> => {
    const indent = '  '.repeat(level - 1);
    if (direction === 'in') {
      const found = await callersOf(ws, from, deadline);
      if (found.precision !== 'lsp') precision = found.precision;
      if (found.unconfirmed.length > 0) unknown.set(from.name, [...(unknown.get(from.name) ?? []), ...found.unconfirmed]);
      const homes = found.callers.flatMap((c) => (c.home && !isTestCase(c.home) ? [c.home] : []));
      const followed = new Set(level < depth ? nearestFirst(homes, [from.file]).map((s) => s.id) : []);
      if ((level < depth && followed.size < homes.length) || found.callers.length > limit) cut = true;
      for (const caller of found.callers.slice(0, limit)) {
        const id = caller.home?.id ?? `${caller.file} (top level)`;
        rows.push({
          text: `${indent}${id}  ${caller.lines.join(', ')}`,
          compact: `${indent}${id}`,
          locations: caller.lines.map((line) => ({ file: caller.file, line })),
        });
        if (caller.home && followed.has(caller.home.id) && !seen.has(caller.home.id)) {
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
  const answer = shown(header, rows, options.budget ?? defaultBudget, !cut && precision === 'lsp' && unknown.size === 0);
  return { ...answer, text: answer.text + unconfirmedLines(ws, unknown) };
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
      // A change in a nested function (a component's handler) is one in the
      // function around it too, whose callers it reaches as directly.
      for (let inner = home; inner?.nested && inner.parent; ) {
        inner = ws.index.get(inner.parent);
        if (inner && !inner.nested) changed.set(inner.id, inner);
      }
    }
  }
  const rows: Row[] = [...changed.values()].map((s) => ({
    text: `changed  ${s.id}  ${s.line}`,
    compact: `changed  ${s.id}`,
    locations: [{ file: s.file, line: s.line }],
  }));
  const tests = new Set([...files].filter(isTestFile));
  const seen = new Set(changed.keys());
  // A caller reached again through another callee keeps the lines of both:
  // the top level of a file is one caller however many functions it calls.
  const callerRows = new Map<string, { step: number; lines: number[]; callees: string[]; row: Row }>();
  // Constructors followed only on the class reached (see receiverOf); one
  // reached otherwise as well is followed on its own class.
  const receivers = new Map<string, CodeSymbol | undefined>();
  let level = [...changed.values()];
  let precision = 'lsp';
  const deadline = Date.now() + toolMs;
  // What a level left out, by time or by maxFollow.
  const notes: string[] = [];
  const unknown = new Map<string, Position[]>();
  for (let step = 1; step <= depth && level.length > 0; step++) {
    const next: CodeSymbol[] = [];
    // A level's searches run a few at a time; their answers are read in order.
    const searches = (
      await pool(level, 4, async (symbol) => ({ symbol, found: await callersOf(ws, symbol, deadline, receivers.get(symbol.id)) }))
    ).filter((s) => s !== undefined);
    if (searches.length < level.length) notes.push(`callers of ${searches.length} of ${level.length} at level ${step} searched in time`);
    for (const { symbol, found } of searches) {
      if (found.precision !== 'lsp') precision = found.precision;
      if (found.unconfirmed.length > 0) unknown.set(symbol.name, [...(unknown.get(symbol.name) ?? []), ...found.unconfirmed]);
      for (const caller of found.callers) {
        if (isTestFile(caller.file)) tests.add(caller.file);
        const id = caller.home?.id ?? `${caller.file} (top level)`;
        const again = callerRows.get(id);
        if (again) {
          if (receivers.get(id) !== (await receiverOf(ws, symbol, caller))) receivers.set(id, undefined);
          const lines = caller.lines.filter((line) => !again.lines.includes(line));
          again.lines.push(...lines);
          if (!again.callees.includes(symbol.name)) again.callees.push(symbol.name);
          again.row.locations.push(...lines.map((line) => ({ file: caller.file, line })));
          again.row.text = `caller ${again.step}  ${id}  ${again.lines.join(', ')}  ← ${again.callees.join(', ')}`;
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        const row: Row = {
          text: `caller ${step}  ${id}  ${caller.lines.join(', ')}  ← ${symbol.name}`,
          compact: `caller ${step}  ${id}`,
          locations: caller.lines.map((line) => ({ file: caller.file, line })),
        };
        callerRows.set(id, { step, lines: [...caller.lines], callees: [symbol.name], row });
        receivers.set(id, await receiverOf(ws, symbol, caller));
        rows.push(row);
        if (caller.home && !isTestCase(caller.home)) next.push(caller.home);
      }
    }
    if (step < depth && next.length > maxFollow) notes.push(`${maxFollow} of ${next.length} callers at level ${step} followed, nearest first`);
    level = nearestFirst(next, [...files]);
  }
  rows.push(...[...tests].sort().map((file) => ({ text: `test  ${file}`, compact: `test  ${file}`, locations: [] })));
  const stopped = notes.length > 0 ? ` · ${notes.join('; ')}; run calls on one for the rest` : '';
  const header =
    `impact · since ${since} · ${plural(changed.size, 'symbol')} changed in ${plural(files.size, 'file')}` +
    ` · ${plural(tests.size, 'test file')} · ${precision}${stopped}`;
  const answer = shown(header, rows, budget, notes.length === 0 && precision === 'lsp' && unknown.size === 0);
  return { ...answer, text: answer.text + unconfirmedLines(ws, unknown) };
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
  receiver?: CodeSymbol,
): Promise<{ callers: Caller[]; precision: string; unconfirmed: Position[] }> {
  // Dispatch matters here: a call through an interface reaches its implementations.
  // Only uses as a value are resolved, which spares imports, exports and types.
  const { found, precision, unconfirmed = [] } = await references(ws, symbol, { viaSupertypes: true, where: isValueUseAt, deadline });
  const byHome = new Map<string, Caller>();
  for (const site of [...found, ...(await constructorCalls(ws, symbol, deadline, receiver))]) {
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
  return { callers, precision, unconfirmed };
}

// Uses the compiler could not resolve of the first three symbols that have
// them, a line each: they may be calls too, so the answer is not complete.
function unconfirmedLines(ws: Workspace, of: Map<string, Position[]>): string {
  const label = (file: string, line: number) => {
    const home = ws.index.containing(file, line);
    return home ? `${line}·${home.name}` : `${line}`;
  };
  const named = [...of].filter(([, mentions]) => mentions.length > 0);
  const lines = named.slice(0, 3).map(([name, mentions]) => `unconfirmed uses of ${name}, the compiler cannot tell: ${unresolvedRow(mentions, label)}`);
  if (named.length > 3) lines.push(`unconfirmed uses of ${named.length - 3} more; run refs on one for them`);
  return lines.map((line) => `\n${line}`).join('');
}

// Where the TS or JS constructor [symbol] runs: on [receiver] and its
// subclasses when given, else on its own class's. Its name is in no call,
// so its own references are none: `new` on its class calls it, and so does
// `new` on a subclass that declares no constructor, which runs the base's;
// one that declares its own calls it through `super()`.
async function constructorCalls(ws: Workspace, symbol: CodeSymbol, deadline: number, receiver?: CodeSymbol): Promise<Position[]> {
  const base = symbol.parent ? ws.index.get(symbol.parent) : undefined;
  if (symbol.name !== 'constructor' || !base || (symbol.lang !== 'ts' && symbol.lang !== 'js')) return [];
  const files = new Map<string, string[]>();
  const linesOf = async (file: string) => {
    if (!files.has(file)) files.set(file, (await readFile(join(ws.root, file), 'utf8')).split('\n'));
    return files.get(file) ?? [];
  };
  const calls: Position[] = [];
  let classes = [receiver ?? base];
  const seen = new Set(classes.map((c) => c.id));
  for (let depth = 0; depth < 4 && classes.length > 0; depth++) {
    const next: CodeSymbol[] = [];
    for (const type of classes) {
      const own = type === base ? undefined : ws.index.symbolsIn(type.file).find((s) => s.parent === type.id && s.name === 'constructor');
      if (own) {
        const lines = await linesOf(own.file);
        for (let n = own.range[0]; n <= own.range[1]; n++) {
          const at = /(?:^|[^.\w$])super\s*\(/.exec(lines[n - 1] ?? '');
          if (at) calls.push({ file: own.file, line: n - 1, character: at.index });
        }
        continue;
      }
      for (const site of (await references(ws, type, { where: isValueUseAt, deadline })).found) {
        const before = ((await linesOf(site.file))[site.line] ?? '').slice(0, site.character);
        if (/\bnew\s+(?:[\w$]+\s*\.\s*)*$/.test(before)) calls.push(site);
        if (!/\bextends\s+$/.test(before)) continue;
        // A one-line class contains its methods on the same line.
        let sub = ws.index.containing(site.file, site.line + 1);
        while (sub && !classKinds.has(sub.kind)) sub = sub.parent ? ws.index.get(sub.parent) : undefined;
        if (!sub || seen.has(sub.id)) continue;
        seen.add(sub.id);
        next.push(sub);
      }
    }
    classes = next;
  }
  return calls;
}

// The class whose instances alone run [symbol] from [caller]: a base
// constructor calling it as `this.m()` reaches a subclass's override only on
// that subclass, so only `new` on it or below runs the changed code.
async function receiverOf(ws: Workspace, symbol: CodeSymbol, caller: Caller): Promise<CodeSymbol | undefined> {
  if (caller.home?.name !== 'constructor' || !symbol.parent || caller.home.parent === symbol.parent) return undefined;
  const lines = (await readFile(join(ws.root, caller.file), 'utf8')).split('\n');
  const self = new RegExp(`\\bthis\\s*\\.\\s*${symbol.name.replace(/\$/g, '\\$')}\\s*\\(`);
  return caller.lines.every((n) => self.test(lines[n - 1] ?? '')) ? ws.index.get(symbol.parent) : undefined;
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
  // A server that stopped meanwhile resolved some calls to nothing.
  const precision = !service ? 'index' : service.alive ? 'lsp' : 'index, unconfirmed: the language server stopped; it starts again on the next call';
  return { callees: [...byId.values()], precision };
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
