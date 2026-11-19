import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rgPath } from '@vscode/ripgrep';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { importsIn, parseClause, resolveSpec } from '../precision/components.ts';
import { isTestFile } from '../index/symbols.ts';
import { defaultBudget, fit } from '../token/budget.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { ToolResult } from './tools.ts';

/**
 * A map of a folder or the whole repository, as Aider's repo map gives one: its files ranked by
 * how much the rest of the code imports them (PageRank over the file import graph, so a file
 * imported by much-imported files ranks high), each with the names others import from it, what
 * it is for. Asked for with `read .` or `read <folder>`, when an agent needs the shape of a
 * project before searching; never given unasked.
 */
type Graph = { files: string[]; edges: Map<string, Set<string>>; names: Map<string, Map<string, number>> };

const cache = new WeakMap<Workspace, { at: number; count: number; graph: Promise<Graph> }>();

export async function repoMap(ws: Workspace, folder: string, budget = defaultBudget): Promise<ToolResult> {
  const graph = await graphOf(ws);
  const inside = (f: string) => folder === '' || f.startsWith(`${folder}/`);
  const rank = pageRank(graph);
  const files = graph.files.filter(inside).sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0) || a.localeCompare(b));
  if (files.length === 0) return { text: `${folder || '.'} · no indexed files here`, locations: [] };
  const users = new Map<string, number>();
  for (const [from, tos] of graph.edges) for (const to of tos) if (to !== from) users.set(to, (users.get(to) ?? 0) + 1);
  const row = (file: string) => {
    const imported = [...(graph.names.get(file) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const own = [...new Set(imported.length ? imported : ws.index.symbolsIn(file).filter((s) => !s.parent && s.exported).map((s) => s.name))];
    const by = users.get(file) ?? 0;
    return `${file}${by ? `  ← ${by}` : ''}${own.length ? `  ${own.slice(0, 8).join(', ')}${own.length > 8 ? ', …' : ''}` : ''}`;
  };
  const code = files.filter((f) => !isTestFile(f));
  const tests = files.length - code.length;
  const fitted = fit(
    `${folder || '.'}/ · ${files.length} files, most imported first (← files that import it) · names others import${tests ? ` · ${tests} test files left out` : ''}`,
    code.map(row),
    { budget, narrow: 'read a folder for its own map', compact: code },
  );
  return { text: fitted.text, locations: code.slice(0, fitted.shown).map((file) => ({ file, line: 1 })) };
}

// The import graph, built once and again when the index has other files or after a minute.
function graphOf(ws: Workspace): Promise<Graph> {
  const kept = cache.get(ws);
  if (kept && kept.count === ws.index.files.length && Date.now() - kept.at < 60_000) return kept.graph;
  const graph = build(ws);
  cache.set(ws, { at: Date.now(), count: ws.index.files.length, graph });
  return graph;
}

async function build(ws: Workspace): Promise<Graph> {
  const files = ws.index.files.filter((f) => !f.endsWith('.md'));
  const known = new Set(files);
  const edges = new Map<string, Set<string>>();
  const names = new Map<string, Map<string, number>>();
  // Every Go module and Dart package of the repo, by its folder: a monorepo has several.
  const goModules = manifests(ws.root, 'go.mod', /^module\s+(\S+)/m);
  const dartPackages = manifests(ws.root, 'pubspec.yaml', /^name:\s*(\S+)/m);
  const add = (from: string, to: string | undefined, imported: string[] = []) => {
    if (!to || to === from || !known.has(to)) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)?.add(to);
    const counts = names.get(to) ?? new Map<string, number>();
    for (const n of imported) if (n && n !== 'default' && n !== '*') counts.set(n, (counts.get(n) ?? 0) + 1);
    names.set(to, counts);
  };
  const byDir = new Map<string, string[]>();
  for (const f of files) byDir.set(posix.dirname(f), [...(byDir.get(posix.dirname(f)) ?? []), f]);
  for (const file of files) {
    const text = await readFile(join(ws.root, file), 'utf8').catch(() => '');
    if (/\.py$/.test(file)) {
      for (const { module, imported } of pythonImports(text)) {
        // `from app import crud`, crud a module of its own: the import is of app/crud.py.
        const target = pythonModule(file, module, known);
        const modules = imported.flatMap((name) => pythonModule(file, `${module}${module.endsWith('.') ? '' : '.'}${name}`, known) ?? []);
        if (modules.length) for (const m of modules) add(file, m);
        if (modules.length < imported.length || imported.length === 0) add(file, target, imported.filter((name) => !pythonModule(file, `${module}${module.endsWith('.') ? '' : '.'}${name}`, known)));
      }
    } else if (/\.go$/.test(file)) {
      for (const path of goImports(text)) {
        const owner = goModules.find((m) => path === m.name || path.startsWith(`${m.name}/`));
        if (!owner) continue;
        const rest = path === owner.name ? '' : path.slice(owner.name.length + 1);
        const dir = posix.normalize(posix.join(owner.dir, rest || '.'));
        for (const target of byDir.get(dir) ?? []) if (target.endsWith('.go') && !target.endsWith('_test.go')) add(file, target);
      }
    } else if (/\.dart$/.test(file)) {
      for (const [, spec = ''] of text.matchAll(/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm)) {
        const pkg = spec.startsWith('package:') ? dartPackages.find((p) => spec.startsWith(`package:${p.name}/`)) : undefined;
        const target = spec.startsWith('package:')
          ? pkg && posix.normalize(posix.join(pkg.dir, 'lib', spec.slice(`package:${pkg.name}/`.length)))
          : posix.normalize(posix.join(posix.dirname(file), spec));
        add(file, target);
      }
    } else {
      for (const i of importsIn(file, text)) {
        const clause = parseClause(i.clause);
        add(file, moduleFile(ws.root, known, resolveSpec(ws.root, file, i.spec)), [...clause.named.map(([n]) => n), ...(clause.default ? [clause.default] : [])]);
      }
      // require('./x') and import('./x'), which carry no names.
      for (const [, spec = ''] of text.matchAll(/\b(?:require|import)\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) add(file, moduleFile(ws.root, known, resolveSpec(ws.root, file, spec)));
    }
  }
  return { files, edges, names };
}

// Each [file] (go.mod, pubspec.yaml) of the repo with the name [pattern] reads from it, and its folder.
function manifests(root: string, file: string, pattern: RegExp): { name: string; dir: string }[] {
  let out = '';
  try {
    out = execFileSync(rgPath, ['--files', '--path-separator', '/', '-g', file, '-g', '!**/node_modules/**', '.'], { cwd: root, encoding: 'utf8' });
  } catch {
    return [];
  }
  return out.split('\n').filter(Boolean).flatMap((path) => {
    const name = pattern.exec(readFileSync(join(root, path), 'utf8'))?.[1];
    return name ? [{ name, dir: posix.dirname(path.replace(/^\.\//, '')) }] : [];
  }).sort((a, b) => b.name.length - a.name.length);
}

const tryExtensions = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

function moduleFile(root: string, known: ReadonlySet<string>, resolved: string | undefined): string | undefined {
  if (!resolved) return undefined;
  const base = resolved.replace(/\.(?:js|mjs|cjs)$/, '');
  for (const candidate of [resolved, ...tryExtensions.map((ext) => `${base}${ext}`)]) if (known.has(candidate)) return candidate;
  return undefined;
}

// `from a.b import c, d`, `from . import x`, `import a.b`: each module and the names taken.
function pythonImports(text: string): { module: string; imported: string[] }[] {
  const found: { module: string; imported: string[] }[] = [];
  for (const [, module = '', names = ''] of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([^)\n#]+)/gm)) {
    found.push({ module, imported: names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0] ?? '').filter((n) => /^\w+$/.test(n)) });
  }
  for (const [, modules = ''] of text.matchAll(/^\s*import\s+([\w.,\s]+)$/gm)) {
    for (const m of modules.split(',')) found.push({ module: m.trim().split(/\s+as\s+/)[0] ?? '', imported: [] });
  }
  return found;
}

// The repo file a Python module names from [file]: relative (`.`, `..x`), or by its path from the
// repo or its src/ folder, as a module or a package's __init__.py.
function pythonModule(file: string, module: string, known: ReadonlySet<string>): string | undefined {
  const dots = /^\.*/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots).split('.').filter(Boolean).join('/');
  // Absolute: from a folder above the file (backend/ for backend/app/main.py's `app.models`), the
  // nearest first, then the repo and its src/.
  const above: string[] = [];
  for (let dir = posix.dirname(file); dir !== '.' && dir !== '/'; dir = posix.dirname(dir)) above.push(dir);
  const bases = dots > 0 ? [posix.join(posix.dirname(file), ...Array(dots - 1).fill('..'))] : [...above, '', 'src'];
  for (const base of bases) {
    const path = posix.normalize(posix.join(base || '.', rest));
    for (const candidate of [`${path}.py`, `${path}/__init__.py`]) if (known.has(candidate.replace(/^\.\//, ''))) return candidate.replace(/^\.\//, '');
  }
  return undefined;
}

function goImports(text: string): string[] {
  const found: string[] = [];
  for (const [, block = ''] of text.matchAll(/^import\s*\(([^)]*)\)/gm)) for (const [, p = ''] of block.matchAll(/"([^"]+)"/g)) found.push(p);
  for (const [, p = ''] of text.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm)) found.push(p);
  return found;
}

// PageRank over the graph, files with no imports spreading theirs evenly.
function pageRank(graph: Graph, damping = 0.85, rounds = 30): Map<string, number> {
  const n = graph.files.length || 1;
  let rank = new Map(graph.files.map((f) => [f, 1 / n]));
  for (let round = 0; round < rounds; round++) {
    const next = new Map(graph.files.map((f) => [f, (1 - damping) / n]));
    let dangling = 0;
    for (const f of graph.files) {
      const out = graph.edges.get(f);
      const share = rank.get(f) ?? 0;
      if (!out || out.size === 0) dangling += share;
      else for (const to of out) next.set(to, (next.get(to) ?? 0) + (damping * share) / out.size);
    }
    for (const f of graph.files) next.set(f, (next.get(f) ?? 0) + (damping * dangling) / n);
    rank = next;
  }
  return rank;
}
