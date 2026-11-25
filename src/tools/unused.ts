import { basename } from 'node:path';
import { componentExtensions, componentOf, isComponentFile } from '../index/embedded.ts';
import { codeExtensions } from '../index/parse.ts';
import type { CodeSymbol } from '../index/symbols.ts';
import { textMentions } from '../precision/lsp-service.ts';
import { defaultBudget, fit } from '../token/budget.ts';
import { workspacePackages } from '../workspace/packages.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { references, type ToolResult } from './tools.ts';

/**
 * `refs <folder> unused`: the exported symbols of a folder or file that nothing else uses, as
 * knip or Go's deadcode find them, in two steps cheapest first. A name no other file mentions
 * at all is unused for sure; a name mentioned elsewhere is asked of the compiler, within a time
 * budget, and unused when none of its references is outside its own file. Entry points are left
 * out (index and main files, pages and routes, what a package.json exports), and the answer says
 * these are candidates: a dynamic import, a string or a framework may still reach them.
 */
const checkMs = 20_000;

// Files a program or a framework starts from, whose exports are used from outside the code.
const entry = /(^|\/)(index|main|mod|lib|app|server|cli|__init__|setup|conftest)\.[^/]+$|(^|\/)(pages|routes|app\/api)\/|\.config\.[^/]+$|\.d\.ts$/;

export async function unused(ws: Workspace, path: string, budget = defaultBudget): Promise<ToolResult> {
  const clean = path.replace(/^\.\//, '').replace(/\/$/, '');
  const files = ws.index.files.filter((f) => f === clean || clean === '' || clean === '.' || f.startsWith(`${clean}/`));
  const exported = packageEntries(ws);
  const candidates = files
    .filter((f) => !entry.test(f) && !exported.has(f) && !f.endsWith('.md'))
    .flatMap((f) => ws.index.symbolsIn(f))
    .filter((s) => s.exported && !s.parent && !s.isTest && s.kind !== 'section' && s.kind !== 'field' && !(isComponentFile(s.file) && componentOf(s.file).kind === 'route'));
  if (candidates.length === 0) return { text: `${clean || '.'} · no exported symbols to check here`, locations: [] };
  const extensions = new Set([...codeExtensions, ...componentExtensions]);
  const deadline = Date.now() + checkMs;
  const found: { symbol: CodeSymbol; why: string }[] = [];
  let unchecked = 0;
  for (const symbol of candidates) {
    // A component is mentioned by its file or tag, not its name: its own refs answer that.
    const own = (p: { file: string }) => p.file === symbol.file;
    const mentions = isComponentFile(symbol.file) && symbol.line === 1 ? [] : (await textMentions(ws.root, symbol.name, extensions)).filter((m) => !own(m));
    if (mentions.length === 0 && !(isComponentFile(symbol.file) && symbol.line === 1)) {
      found.push({ symbol, why: 'no other file names it' });
      continue;
    }
    if (Date.now() > deadline) {
      unchecked++;
      continue;
    }
    const answer = await references(ws, symbol, { deadline: Math.min(deadline, Date.now() + 3000) });
    const outside = answer.found.filter((p) => !own(p));
    if (outside.length === 0 && (answer.unconfirmed ?? []).length === 0 && !answer.precision.includes('partial') && !answer.precision.startsWith('text')) {
      found.push({ symbol, why: `named elsewhere, used nowhere else (${answer.precision.split(',')[0]})` });
    }
  }
  const rows = found.map(({ symbol, why }) => `${symbol.file}:${symbol.line}  ${symbol.kind} ${symbol.name}  ${why}`);
  const more = unchecked ? ` · ${unchecked} not checked in ${checkMs / 1000} s: narrow the path` : '';
  const fitted = fit(
    `${clean || '.'} · ${found.length} of ${candidates.length} exported symbols unused · candidates: a dynamic import, a string or a framework may still reach them${more}`,
    rows,
    { budget, narrow: 'narrow the path', compact: found.map(({ symbol }) => `${symbol.file}:${symbol.line}  ${symbol.name}`) },
  );
  return { text: fitted.text, locations: found.slice(0, fitted.shown).map(({ symbol }) => ({ file: symbol.file, line: symbol.line })) };
}

// The files the repo's package.json files name as entries (main, module, exports, bin), whose
// exports are a package's public API.
function packageEntries(ws: Workspace): Set<string> {
  const files = new Set<string>();
  for (const pkg of workspacePackages(ws.root)) {
    const m = pkg.manifest;
    const values = [m.main, m.module, m.types, m.svelte, m.source, m.bin, m.exports].flatMap(strings);
    for (const v of values) {
      const path = `${pkg.dir === '.' ? '' : `${pkg.dir}/`}${v.replace(/^\.\//, '')}`;
      for (const f of ws.index.files) if (f === path || f.replace(/\.[^.]+$/, '') === path.replace(/\.[^.]+$/, '') || basename(f) === basename(path)) files.add(f);
    }
  }
  return files;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}
