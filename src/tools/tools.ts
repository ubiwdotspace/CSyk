import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import type { SearchOptions } from '../index/symbol-index.ts';
import { isTestFile, type CodeSymbol } from '../index/symbols.ts';
import type { Workspace } from '../workspace/workspace.ts';

const run = promisify(execFile);

/** A place a tool answered with: repo-relative file, 1-based line. */
export type Location = { file: string; line: number };

/** What a tool returns: the text the agent reads and the places it names. */
export type ToolResult = { text: string; locations: Location[] };

const row = (s: CodeSymbol) => `${s.id}  ${s.kind}  :${s.line}  ${s.signature}`;

/** `find`: symbols whose name matches [query], best first. */
export function find(ws: Workspace, query: string, options: SearchOptions = {}): ToolResult {
  const hits = ws.index.search(query, options);
  if (hits.length === 0) {
    const near = ws.index.nearest(query);
    return {
      text: `find "${query}" · no exact hit${near.length ? `; nearest: ${near.join(', ')}` : ''} · precision: index`,
      locations: [],
    };
  }
  return {
    text: [
      `find "${query}" · ${hits.length} hit${hits.length === 1 ? '' : 's'} · precision: index`,
      ...hits.map(row),
      'hint: read <id> for the body · refs <id> for usages',
    ].join('\n'),
    locations: hits.map((s) => ({ file: s.file, line: s.line })),
  };
}

/** `outline`: the symbols of a file, or of every file under a folder. */
export function outline(ws: Workspace, path: string): ToolResult {
  const clean = path.replace(/^\.\//, '').replace(/\/$/, '');
  const exact = ws.index.symbolsIn(clean);
  if (exact.length > 0 || ws.index.files.includes(clean)) {
    const lines = exact.map((s) => {
      const indent = s.parent ? '  ' : '';
      return `${indent}${s.range[0]}-${s.range[1]}  ${s.kind}  ${s.name}${s.exported ? '' : '  (local)'}`;
    });
    return {
      text: [`outline ${clean} · ${exact.length} symbols`, ...lines].join('\n'),
      locations: exact.map((s) => ({ file: s.file, line: s.line })),
    };
  }
  const files = ws.index.files.filter((f) => clean === '' || clean === '.' || f.startsWith(`${clean}/`));
  if (files.length === 0) return { text: `outline ${clean} · no indexed files here`, locations: [] };
  const lines = files.map((file) => {
    const top = ws.index.symbolsIn(file).filter((s) => !s.parent);
    return `${file}  ${top.map((s) => s.name).join(', ')}`;
  });
  return { text: [`outline ${clean}/ · ${files.length} files`, ...lines].join('\n'), locations: [] };
}

/** `read`: the exact source of one symbol, or its signature alone. */
export async function read(
  ws: Workspace,
  target: string,
  mode: 'body' | 'signature' = 'body',
  context = 0,
): Promise<ToolResult> {
  const { symbol, note } = resolve(ws, target);
  if (!symbol) return { text: note, locations: [] };
  const location = [{ file: symbol.file, line: symbol.line }];
  if (mode === 'signature') return { text: `${symbol.id}  ${symbol.signature}`, locations: location };
  const lines = (await readFile(join(ws.root, symbol.file), 'utf8')).split('\n');
  const start = Math.max(1, symbol.range[0] - context);
  const end = Math.min(lines.length, symbol.range[1] + context);
  return {
    text: [`${symbol.id} · ${symbol.file}:${start}-${end}${note ? ` · ${note}` : ''}`, ...lines.slice(start - 1, end)].join('\n'),
    locations: location,
  };
}

/** `refs`: every reference to one symbol, grouped by file, from the compiler. */
export async function refs(ws: Workspace, target: string, limit = 50): Promise<ToolResult> {
  const { symbol, note } = resolve(ws, target);
  if (!symbol) return { text: note, locations: [] };
  const found = await (await ws.ts()).references(symbol);
  const byFile = new Map<string, number[]>();
  for (const p of found) byFile.set(p.file, [...new Set([...(byFile.get(p.file) ?? []), p.line + 1])]);
  const lines = [`refs ${symbol.id} · ${found.length} in ${byFile.size} files · precision: lsp${note ? ` · ${note}` : ''}`];
  const locations: Location[] = [];
  for (const [file, numbers] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    if (locations.length >= limit) break;
    const text = (await readFile(join(ws.root, file), 'utf8')).split('\n');
    lines.push(file);
    for (const line of numbers.sort((a, b) => a - b)) {
      if (locations.length >= limit) break;
      const home = ws.index.containing(file, line);
      const code = (text[line - 1] ?? '').trim().slice(0, 100);
      lines.push(`  ${line}  ${home ? home.name : '-'}  ${code}`);
      locations.push({ file, line });
    }
  }
  if (locations.length < found.length) lines.push(`… ${found.length - locations.length} more; raise limit`);
  return { text: lines.join('\n'), locations };
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
      text: [`def ${target} · ${named.length} · precision: index`, ...named.map(row)].join('\n'),
      locations: named.map((s) => ({ file: s.file, line: s.line })),
    };
  }
  const spans = await (await ws.ts()).definition({
    file: target.file,
    line: target.line - 1,
    character: target.column - 1,
  });
  if (spans.length === 0) {
    return { text: `def ${target.file}:${target.line}:${target.column} · no declaration in the workspace`, locations: [] };
  }
  const locations = spans.map((s) => ({ file: s.file, line: s.nameLine + 1 }));
  const lines = locations.map((l) => {
    const home = ws.index.containing(l.file, l.line);
    return `${l.file}:${l.line}${home ? `  ${home.id}  ${home.signature}` : ''}`;
  });
  return { text: [`def ${target.file}:${target.line}:${target.column} · precision: lsp`, ...lines].join('\n'), locations };
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
  options: { regex?: boolean; path?: string; limit?: number } = {},
): Promise<ToolResult> {
  const limit = options.limit ?? 30;
  const args = ['--line-number', '--no-heading', '--color', 'never', '--smart-case', '--max-columns', '300'];
  if (!options.regex) args.push('--fixed-strings');
  let stdout = '';
  try {
    ({ stdout } = await run(rgPath, [...args, '-e', pattern, '--', options.path ?? '.'], {
      cwd: ws.root,
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    // Exit code 1 is ripgrep's "no match".
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  type Hit = { file: string; line: number; code: string; home?: CodeSymbol; rank: number };
  const hits: Hit[] = [];
  for (const entry of stdout.split('\n')) {
    const match = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(entry);
    if (!match?.[1] || !match[2] || match[3] === undefined) continue;
    const file = match[1];
    const line = Number(match[2]);
    const home = ws.index.containing(file, line);
    const indexed = ws.index.has(file);
    const rank = indexed && !isTestFile(file) ? 0 : indexed ? 1 : 2;
    hits.push({ file, line, code: match[3].trim().slice(0, 120), ...(home ? { home } : {}), rank });
  }
  if (hits.length === 0) return { text: `grep "${pattern}" · no match · precision: text`, locations: [] };
  hits.sort((a, b) => a.rank - b.rank);
  const perSymbol = new Map<string, number>();
  const shown: Hit[] = [];
  for (const hit of hits) {
    const key = hit.home?.id ?? `${hit.file}:${hit.line}`;
    const count = perSymbol.get(key) ?? 0;
    perSymbol.set(key, count + 1);
    if (count < 2 && shown.length < limit) shown.push(hit);
  }
  const lines = [
    `grep "${pattern}" · ${hits.length} hit${hits.length === 1 ? '' : 's'} in ${perSymbol.size} place${perSymbol.size === 1 ? '' : 's'} · precision: text`,
    ...shown.map((h) => `${h.file}:${h.line}  ${h.home?.name ?? '-'}  ${h.code}`),
  ];
  if (shown.length < hits.length) lines.push(`… ${hits.length - shown.length} more; narrow with path or a longer pattern`);
  return { text: lines.join('\n'), locations: shown.map((h) => ({ file: h.file, line: h.line })) };
}

// A symbol by id, or by name: an exact name with several declarations takes
// the best ranked and names the others.
function resolve(ws: Workspace, target: string): { symbol?: CodeSymbol; note: string } {
  if (target.includes('#')) {
    const symbol = ws.index.get(target);
    return symbol ? { symbol, note: '' } : { note: `no symbol with id ${target}` };
  }
  const named = ws.index.named(target);
  if (named.length === 0) {
    const near = ws.index.search(target, { limit: 3 }).map((s) => s.id);
    return { note: `no symbol named ${target}${near.length ? `; nearest: ${near.join(', ')}` : ''}` };
  }
  const [best, ...others] = ws.index.search(target, { limit: named.length }).filter((s) => s.name === target);
  if (!best) return { note: `no symbol named ${target}` };
  return { symbol: best, note: others.length ? `also named so: ${others.map((s) => s.id).join(', ')}` : '' };
}
