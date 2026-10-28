import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SearchOptions } from '../index/symbol-index.ts';
import type { CodeSymbol } from '../index/symbols.ts';
import type { Workspace } from '../workspace/workspace.ts';

/** A place a tool answered with: repo-relative file, 1-based line. */
export type Location = { file: string; line: number };

/** What a tool returns: the text the agent reads and the places it names. */
export type ToolResult = { text: string; locations: Location[] };

const row = (s: CodeSymbol) => `${s.id}  ${s.kind}  :${s.line}  ${s.signature}`;

/** `find`: symbols whose name matches [query], best first. */
export function find(ws: Workspace, query: string, options: SearchOptions = {}): ToolResult {
  const hits = ws.index.search(query, options);
  if (hits.length === 0) {
    return { text: `find "${query}" · no symbol matches · precision: index`, locations: [] };
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
