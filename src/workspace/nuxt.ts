import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { rgPath } from '@vscode/ripgrep';

/**
 * Nuxt's auto-imports, by its own conventions, since the `.d.ts` files it generates for them
 * (`.nuxt/components.d.ts`, `.nuxt/imports.d.ts`) are not in git: every component under a Nuxt
 * app's `components/` is usable as a tag with no import, named after its path; every export of a
 * file at the top of `composables/` or `utils/` (or of a folder's index there) is usable as is.
 * Nuxt 3's folders sit next to nuxt.config, Nuxt 4's in its `app/`.
 */
type NuxtComponent = { names: string[]; file: string };

const cache = new Map<string, { at: number; apps: string[]; files: string[] }>();

// The folders with a nuxt.config, and the repo's .vue, .ts and .js files; read again after 30 seconds.
function scan(root: string): { apps: string[]; files: string[] } {
  const kept = cache.get(root);
  if (kept && Date.now() - kept.at < 30_000) return kept;
  let out = '';
  try {
    out = execFileSync(rgPath, ['--files', '--path-separator', '/', '-g', 'nuxt.config.*', '-g', '*.vue', '-g', '*.{ts,js,mjs,tsx,jsx}', '-g', '!**/node_modules/**', '.'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // No files (rg exits 1).
  }
  const all = out.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  const apps = all.filter((f) => /(^|\/)nuxt\.config\.[cm]?[jt]s$/.test(f)).map((f) => posix.dirname(f));
  const entry = { at: Date.now(), apps, files: apps.length ? all : [] };
  cache.set(root, entry);
  return entry;
}

// The Nuxt app [file] is in, with the folder its components/, composables/ and utils/ are in.
function appOf(root: string, file: string): string | undefined {
  const { apps } = scan(root);
  for (const app of apps.sort((a, b) => b.length - a.length)) {
    const base = app === '.' ? '' : `${app}/`;
    for (const src of [`${base}app/`, base]) if (file.startsWith(src)) return src;
  }
  return undefined;
}

/** Whether [file]'s exports are auto-imported in its Nuxt app (`composables/`, `utils/`, top level or a folder's index). */
export function isNuxtAutoImport(root: string, file: string): boolean {
  const src = appOf(root, file);
  if (src === undefined) return false;
  return new RegExp(`^${escape(src)}(?:composables|utils)/(?:[^/]+\\.[cm]?[jt]sx?|[^/]+/index\\.[cm]?[jt]sx?)$`).test(file);
}

/** The Nuxt components of the repo, each with the tag names it is used by: `HomeChart`, `LazyHomeChart`. */
export function nuxtComponents(root: string): NuxtComponent[] {
  const found: NuxtComponent[] = [];
  for (const file of scan(root).files) {
    if (!file.endsWith('.vue')) continue;
    const src = appOf(root, file);
    if (src === undefined || !file.startsWith(`${src}components/`)) continue;
    const parts = file.slice(`${src}components/`.length).replace(/\.vue$/, '').replace(/\.(client|server)$/, '').split('/');
    const base = parts.pop() ?? '';
    const name = componentName(base === 'index' ? (parts.pop() ?? base) : base, parts);
    if (name) found.push({ names: [name, `Lazy${name}`], file });
  }
  return found;
}

// Nuxt's resolveComponentNameSegments: the folders' words, less those the file's name repeats
// (components/home/HomeChart.vue is HomeChart, components/customers/AddModal.vue CustomersAddModal).
function componentName(fileName: string, prefixParts: string[]): string {
  const fileNameParts = splitByCase(fileName);
  const content = fileNameParts.join('/').toLowerCase();
  const parts = [...prefixParts];
  const matched: string[] = [];
  for (let index = prefixParts.length - 1; index >= 0; index--) {
    matched.unshift(...splitByCase(prefixParts[index] ?? '').map((p) => p.toLowerCase()));
    const suffix = matched.join('/');
    if (content === suffix || content.startsWith(`${suffix}/`) || (prefixParts[index]?.toLowerCase() === content && prefixParts[index + 1] === prefixParts[index])) {
      parts.length = index;
    }
  }
  return [...parts, ...fileNameParts].flatMap(splitByCase).map((p) => (p[0]?.toUpperCase() ?? '') + p.slice(1)).join('');
}

// Words of a name split at case changes and separators, as scule's splitByCase.
function splitByCase(text: string): string[] {
  return text
    .split(/[-_./\s]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter(Boolean);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
