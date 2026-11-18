import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * The import aliases a project's tsconfig.json or jsconfig.json declares (`compilerOptions.paths`,
 * through its `extends`), so an import the compiler would resolve by them (`~components/Card.astro`,
 * `@lib/format`) is followed in the files no compiler reads for CSyk. SvelteKit's `$lib` comes
 * this way from the `.svelte-kit/tsconfig.json` it generates.
 */
type Paths = { base: string; paths: Record<string, string[]> };

const cache = new Map<string, { at: number; paths: Paths | undefined }>();

/** The paths of the config nearest [file] (repo-relative) in [root], undefined without one. */
export function pathsFor(root: string, file: string): Paths | undefined {
  let dir = posix.dirname(file);
  for (;;) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const config = dir === '.' ? name : `${dir}/${name}`;
      if (existsSync(join(root, config))) return cached(root, config);
    }
    if (dir === '.' || dir === '/' || dir === '') return undefined;
    dir = posix.dirname(dir);
  }
}

function cached(root: string, config: string): Paths | undefined {
  const kept = cache.get(`${root}\0${config}`);
  if (kept && Date.now() - kept.at < 30_000) return kept.paths;
  const paths = read(root, config, 0);
  cache.set(`${root}\0${config}`, { at: Date.now(), paths });
  return paths;
}

// [config]'s paths, its own over those it extends; relative to its baseUrl, else to the file that declares them.
function read(root: string, config: string, depth: number): Paths | undefined {
  let json: { extends?: unknown; compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
  try {
    json = JSON.parse(withoutComments(readFileSync(join(root, config), 'utf8'))) as typeof json;
  } catch {
    return undefined;
  }
  const dir = posix.dirname(config);
  const options = json.compilerOptions ?? {};
  if (options.paths) {
    const base = posix.normalize(posix.join(dir, options.baseUrl ?? '.'));
    return { base, paths: options.paths };
  }
  if (depth >= 5) return undefined;
  for (const parent of [json.extends].flat()) {
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
    const file = posix.normalize(posix.join(dir, parent.endsWith('.json') ? parent : `${parent}.json`));
    const found = read(root, file, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** The repo paths [spec] may name by [paths]'s patterns, the first pattern that matches it first. */
export function byPaths(paths: Paths, spec: string): string[] {
  for (const [pattern, targets] of Object.entries(paths.paths)) {
    const star = pattern.indexOf('*');
    const rest = star < 0 ? (spec === pattern ? '' : undefined) : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) ? spec.slice(star, spec.length - (pattern.length - star - 1)) : undefined;
    if (rest === undefined) continue;
    return targets.map((target) => posix.normalize(posix.join(paths.base, target.replace('*', rest))));
  }
  return [];
}

// JSON with comments and trailing commas, as TypeScript reads its configs.
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) if (text[j] === '\\') j++;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
