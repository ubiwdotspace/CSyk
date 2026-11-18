import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { rgPath } from '@vscode/ripgrep';

/**
 * The packages of a monorepo (npm, pnpm and Yarn workspaces, or any folder with a package.json
 * and a name), so an import by a package's name (`@bamui/astro`, `@acme/ui/Button.svelte`) is
 * followed to the source file it names, as a bundler would, without node_modules.
 */
type Package = { name: string; dir: string; manifest: Record<string, unknown> };

const cache = new Map<string, { at: number; packages: Package[] }>();

/** The named packages under [root], longest name first; read again after 30 seconds. */
export function workspacePackages(root: string): Package[] {
  const kept = cache.get(root);
  if (kept && Date.now() - kept.at < 30_000) return kept.packages;
  let files: string[] = [];
  try {
    const out = execFileSync(rgPath, ['--files', '--path-separator', '/', '-g', 'package.json', '-g', '!**/node_modules/**', '.'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    files = out.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  } catch {
    // No package.json (rg exits 1), or no ripgrep: no packages to follow.
  }
  const packages = files.flatMap((file) => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;
      return typeof manifest.name === 'string' ? [{ name: manifest.name, dir: posix.dirname(file), manifest }] : [];
    } catch {
      return [];
    }
  });
  packages.sort((a, b) => b.name.length - a.name.length);
  cache.set(root, { at: Date.now(), packages });
  return packages;
}

// The conditions a source-reading tool takes, in order: what a bundler of the source would.
const conditions = ['source', 'svelte', 'import', 'module', 'default', 'require', 'types'];

function target(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(target).find(Boolean);
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of conditions) {
    const found = target(record[condition]);
    if (found) return found;
  }
  return undefined;
}

// The export for [subpath] (`.`, `./Badge.astro`), a `*` pattern's included.
function exported(exports: unknown, subpath: string): string | undefined {
  if (typeof exports === 'string' || Array.isArray(exports)) return subpath === '.' ? target(exports) : undefined;
  if (typeof exports !== 'object' || exports === null) return undefined;
  const map = exports as Record<string, unknown>;
  if (!Object.keys(map).some((k) => k.startsWith('.'))) return subpath === '.' ? target(map) : undefined;
  if (subpath in map) return target(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const [before, after] = [key.slice(0, star), key.slice(star + 1)];
    if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= key.length - 1) {
      return target(value)?.replace('*', subpath.slice(before.length, subpath.length - after.length));
    }
  }
  return undefined;
}

/**
 * The source file, as a repo path, that the import [spec] names when it is a workspace
 * package's name or a path in it; a built file (`dist/index.js`) as the source it was built
 * from (`src/index.ts`, `src/lib/…` for svelte-package) when that is there. Undefined when no
 * workspace package has the name.
 */
export function resolvePackageSpec(root: string, spec: string): string | undefined {
  const pkg = workspacePackages(root).find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
  if (!pkg) return undefined;
  const subpath = spec === pkg.name ? '.' : `./${spec.slice(pkg.name.length + 1)}`;
  const m = pkg.manifest;
  const named =
    exported(m.exports, subpath) ??
    (subpath === '.' ? target(m.source) ?? target(m.svelte) ?? target(m.module) ?? target(m.main) ?? './index' : m.exports === undefined ? subpath : undefined);
  if (!named) return undefined;
  const path = posix.normalize(posix.join(pkg.dir, named));
  return sourceOf(root, pkg.dir, path) ?? path;
}

const extensions = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

// [path], or the source a build made it from, whichever is in the repo.
function sourceOf(root: string, dir: string, path: string): string | undefined {
  const base = path.replace(/\.d\.ts$/, '').replace(/\.(?:[cm]?js)$/, '');
  const prefix = dir === '.' ? '' : `${dir}/`;
  const built = /^(?:dist|build|lib|out)\//.exec(path.slice(prefix.length));
  const candidates = [
    ...(built ? [`${prefix}src/${base.slice(prefix.length + built[0].length)}`, `${prefix}src/lib/${base.slice(prefix.length + built[0].length)}`] : []),
    base,
  ];
  for (const candidate of candidates) {
    for (const ext of extensions) {
      const file = `${candidate}${ext}`;
      if (existsSync(join(root, file)) && !file.endsWith('.d.ts')) return file;
    }
  }
  return undefined;
}

const ambientCache = new Map<string, { at: number; modules: Map<string, string> }>();

/**
 * The modules declared by name in the repo's `.d.ts` files, each with the file it stands for:
 * `declare module 'virtual:starlight/components/Banner' { const Banner: typeof
 * import('./src/components/Banner.astro').default; … }`, as frameworks type their virtual
 * modules. The file is the first path the block imports, relative to the `.d.ts` file. Read
 * again after 30 seconds.
 */
export function ambientModules(root: string): Map<string, string> {
  const kept = ambientCache.get(root);
  if (kept && Date.now() - kept.at < 30_000) return kept.modules;
  const modules = new Map<string, string>();
  let files: string[] = [];
  try {
    const out = execFileSync(rgPath, ['-l', '--path-separator', '/', '-g', '*.d.ts', '-g', '!**/node_modules/**', '-F', 'declare module', '.'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    files = out.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  } catch {
    // None (rg exits 1).
  }
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const block of text.matchAll(/declare\s+module\s+['"]([^'"*]+)['"]\s*\{([^]*?)\n\}/g)) {
      const path = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/.exec(block[2] ?? '');
      const target = path?.[1] ?? path?.[2];
      if (block[1] && target) modules.set(block[1], posix.normalize(posix.join(posix.dirname(file), target)));
    }
  }
  ambientCache.set(root, { at: Date.now(), modules });
  return modules;
}

/** A name a `.d.ts` makes global, with the repo file and export it stands for, and where it says so. */
export type DeclaredGlobal = { name: string; target: string; exported: string; file: string; line: number };

const globalCache = new Map<string, { at: number; globals: DeclaredGlobal[] }>();

/**
 * The names the repo's `.d.ts` files make usable with no import, each with the file it comes
 * from: Vue's global components (`TheFooter: typeof import('./components/TheFooter.vue')['default']`
 * in unplugin-vue-components' or Nuxt's components.d.ts) and auto-imported functions
 * (`const isDark: typeof import('./composables/dark').isDark` in auto-imports.d.ts, or `['isDark']`). Only
 * paths inside the repo. Read again after 30 seconds.
 */
export function declaredGlobals(root: string): DeclaredGlobal[] {
  const kept = globalCache.get(root);
  if (kept && Date.now() - kept.at < 30_000) return kept.globals;
  const globals: DeclaredGlobal[] = [];
  let found = '';
  try {
    found = execFileSync(rgPath, ['--vimgrep', '--path-separator', '/', '-g', '*.d.ts', '-g', '!**/node_modules/**', '-e', String.raw`typeof import\(['"]\.{1,2}/`, '.'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // None (rg exits 1).
  }
  for (const hit of found.split('\n')) {
    const match = /^(?:\.\/)?(.+?):(\d+):\d+:\s*(?:(?:export\s+)?(?:const|let|var)\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*typeof\s+import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)\s*(?:\[\s*['"]([\w$]+)['"]\s*\]|\.([\w$]+))/.exec(hit);
    const exported = match?.[5] ?? match?.[6];
    if (!match?.[1] || !match[3] || !match[4] || !exported) continue;
    globals.push({ name: match[3], target: posix.normalize(posix.join(posix.dirname(match[1]), match[4])), exported, file: match[1], line: Number(match[2]) - 1 });
  }
  globalCache.set(root, { at: Date.now(), globals });
  return globals;
}
