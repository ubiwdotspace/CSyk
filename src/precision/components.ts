import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { componentExtensions, isComponentFile, kebabCase, maskComponent } from '../index/embedded.ts';
import { codeExtensions } from '../index/parse.ts';
import type { CodeSymbol } from '../index/symbols.ts';
import { ambientModules, declaredGlobals, resolvePackageSpec } from '../workspace/packages.ts';
import { isNuxtAutoImport, nuxtComponents } from '../workspace/nuxt.ts';
import { byPaths, pathsFor } from '../workspace/tsconfig.ts';
import type { Position } from './lsp-client.ts';
import { inCode, isDefaultExport, textMentions, type Mention, type ReferenceOptions } from './lsp-service.ts';

/**
 * Uses found through imports, in the files no compiler reads for CSyk: Astro, Svelte and Vue
 * components (see index/embedded.ts). A name a file imports from the declaration's own file,
 * by a relative path or a common alias (`$lib/`, `@/`, `~/`), is a use wherever that file
 * writes it in code; a mention imported from somewhere that cannot be followed (a package, an
 * unknown alias) or not imported at all is unconfirmed, so no answer that leaves one out says
 * `complete`.
 */
export type Uses = { found: Position[]; unconfirmed: Position[] };

type Import = { spec: string; clause: string; line: number; reexport: boolean };
type Clause = { default?: string; named: [string, string][]; namespace?: string; all: boolean };

// `import X, { a, b as c } from 'm'`, `import * as m from 'm'`, `export { default as X } from
// 'm'`, `export * from 'm'`: only names, braces, commas and `as` between the keyword and `from`.
const statement = /\b(import|export)\s+(?:type\s+)?([\w$\s,{}*]*?)\s*from\s*(['"])([^'"\n]+)\3/g;

/** The imports and re-exports in the code of [file]. */
export function importsIn(file: string, text: string): Import[] {
  const code = isComponentFile(file) ? maskComponent(file, text) : text;
  const found: Import[] = [];
  for (const m of code.matchAll(statement)) {
    const at = (m.index ?? 0) + m[0].lastIndexOf(m[4] ?? '');
    found.push({ spec: m[4] ?? '', clause: m[2] ?? '', line: lineOf(code, at), reexport: m[1] === 'export' });
  }
  return found;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length - 1;

export function parseClause(clause: string): Clause {
  const named = [...(/\{([^}]*)\}/.exec(clause)?.[1] ?? '').split(',')]
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => {
      const [imported = '', local] = part.split(/\s+as\s+/);
      return [imported.trim(), (local ?? imported).trim()] as [string, string];
    });
  const outside = clause.replace(/\{[^}]*\}/, '').trim();
  const namespace = /\*\s*as\s+([\w$]+)/.exec(outside)?.[1];
  const first = /^([\w$]+)/.exec(outside)?.[1];
  return { named, all: outside.startsWith('*') && !namespace, ...(namespace ? { namespace } : {}), ...(first ? { default: first } : {}) };
}

// A file without its extension, so `./form-attrs` and `./form-attrs.ts` name the same module.
const stem = (path: string) => path.replace(/\.(?:d\.ts|[cm]?[jt]sx?)$/, '');

/**
 * The repo path [spec] names when written in [from]: relative, by the `paths` of the nearest
 * tsconfig.json or jsconfig.json (workspace/tsconfig.ts), an alias of the `src` folder of
 * [from]'s package, as SvelteKit (`$lib/`), Vite and Nuxt (`@/`, `~/`) set them up, a module a
 * `.d.ts` declares by name (a framework's virtual module), or a workspace package's name
 * (workspace/packages.ts); else undefined.
 */
export function resolveSpec(root: string, from: string, spec: string): string | undefined {
  if (spec.startsWith('./') || spec.startsWith('../')) return posix.normalize(posix.join(posix.dirname(from), spec));
  // The project's own aliases first, as the compiler reads them: the first target that is there.
  const paths = pathsFor(root, from);
  const targets = paths ? byPaths(paths, spec) : [];
  if (targets.length > 0) return targets.find((t) => moduleFile(root, t)) ?? targets[0];
  const alias = /^(\$lib|@|~)\/(.*)$/.exec(spec);
  if (!alias) return ambientModules(root).get(spec) ?? resolvePackageSpec(root, spec);
  let dir = posix.dirname(from);
  while (dir !== '.' && dir !== '/' && !existsSync(join(root, dir, 'package.json'))) dir = posix.dirname(dir);
  const base = dir === '.' || dir === '/' ? '' : `${dir}/`;
  return `${base}src/${alias[1] === '$lib' ? 'lib/' : ''}${alias[2]}`;
}

const sameModule = (resolved: string, target: string) => stem(resolved) === stem(target) || `${stem(resolved)}/index` === stem(target);

const moduleExtensions = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

// The file a resolved module path names, extensions as a bundler tries them; undefined when none is there.
function moduleFile(root: string, resolved: string): string | undefined {
  return moduleExtensions.map((ext) => `${resolved}${ext}`).find((file) => existsSync(join(root, file)) && !file.endsWith('.d.ts'));
}

/**
 * Where an import of [spec] in [from] leads for [name] declared in [target]: `ours` when it
 * names [target], or a module that re-exports [name] from it (a barrel, two levels at most);
 * `other` for any other module in the repo; `unknown` when it cannot be followed.
 */
async function leadsTo(root: string, from: string, spec: string, name: string, target: string, depth = 0): Promise<'ours' | 'other' | 'unknown'> {
  const resolved = resolveSpec(root, from, spec);
  if (resolved === undefined) return 'unknown';
  if (sameModule(resolved, target)) return 'ours';
  const file = moduleFile(root, resolved);
  if (!file) return 'unknown';
  if (depth >= 2) return 'other';
  const text = await readFile(join(root, file), 'utf8').catch(() => '');
  for (const i of importsIn(file, text)) {
    if (!i.reexport) continue;
    const clause = parseClause(i.clause);
    const local = clause.named.find(([, as]) => as === name)?.[0];
    if (!clause.all && local === undefined) continue;
    if ((await leadsTo(root, file, i.spec, local ?? name, target, depth + 1)) === 'ours') return 'ours';
  }
  return 'other';
}

// Whole-word mentions of [name] in [file], as textMentions gives them.
function mentionsIn(file: string, text: string, name: string): Mention[] {
  const escaped = name.replace(/[$]/g, '\\$');
  const word = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
  return text.split('\n').flatMap((line, n) => [...line.matchAll(word)].map((m) => ({ file, line: n, character: m.index ?? 0, text: line })));
}

const key = (p: Position) => `${p.file}:${p.line}:${p.character}`;

function unique(positions: Position[]): Position[] {
  return [...new Map(positions.map((p) => [key(p), { file: p.file, line: p.line, character: p.character }])).values()];
}

/**
 * Uses of [symbol], a TS or JS declaration, in component files: the compiler's answer leaves
 * them out, as it never reads them.
 */
export async function componentUses(root: string, symbol: CodeSymbol, where?: ReferenceOptions['where'], declares?: (file: string, name: string) => boolean): Promise<Uses> {
  if (symbol.parent && !isComponentFile(symbol.file)) return { found: [], unconfirmed: [] };
  const source = await readFile(join(root, symbol.file), 'utf8').catch(() => '');
  const asDefault = isDefaultExport(source, symbol.name);
  const module = basename(stem(symbol.file));
  const files = new Set([
    ...(await textMentions(root, symbol.name, componentExtensions)).map((m) => m.file),
    ...(asDefault ? (await textMentions(root, module, componentExtensions)).map((m) => m.file) : []),
  ]);
  files.delete(symbol.file);
  const found: Position[] = [];
  const unconfirmed: Position[] = [];
  // Made global by a .d.ts (auto-imports.d.ts): a use needs no import.
  const global =
    declaredGlobals(root).some((g) => g.name === symbol.name && g.exported === symbol.name && sameModule(g.target, symbol.file)) ||
    (symbol.exported && isNuxtAutoImport(root, symbol.file));
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    const locals = new Set<string>();
    const namespaces = new Set<string>();
    let imported: false | 'unknown' | 'elsewhere' = false;
    for (const i of importsIn(file, text)) {
      const clause = parseClause(i.clause);
      const names = clause.named.filter(([from]) => from === symbol.name).map(([, local]) => local);
      const binds = names.length > 0 || (asDefault && clause.default !== undefined && !i.reexport) || clause.namespace !== undefined;
      if (!binds) continue;
      const lead = await leadsTo(root, file, i.spec, symbol.name, symbol.file);
      if (lead === 'other') {
        // The name comes from another module: another declaration, not a use.
        if (names.includes(symbol.name)) imported = 'elsewhere';
        continue;
      }
      if (lead === 'unknown') {
        if (names.length > 0 && imported !== 'elsewhere') imported = 'unknown';
        continue;
      }
      for (const local of names) locals.add(local);
      if (asDefault && clause.default && !i.reexport) locals.add(clause.default);
      if (clause.namespace) namespaces.add(clause.namespace);
    }
    const uses = [...locals].flatMap((local) => mentionsIn(file, text, local));
    for (const ns of namespaces) {
      uses.push(...mentionsIn(file, text, symbol.name).filter((m) => m.text.slice(0, m.character).trimEnd().endsWith(`${ns}.`)));
    }
    found.push(...(await inCode(root, uses, where)));
    // Imported from a package or an alias this cannot follow, or not imported but named in code:
    // perhaps a use, perhaps another declaration of the name.
    if (locals.has(symbol.name) || imported === 'elsewhere' || declares?.(file, symbol.name)) continue;
    if (global && imported === false && locals.size === 0) {
      found.push(...(await inCode(root, mentionsIn(file, text, symbol.name), where)));
      continue;
    }
    if (imported === 'unknown' || !locals.size) {
      const others = mentionsIn(file, text, symbol.name).filter((m) => !uses.some((u) => key(u) === key(m)));
      unconfirmed.push(...(await inCode(root, others, where)));
    }
  }
  return { found: unique(found), unconfirmed: unique(unconfirmed) };
}

/**
 * Uses of a component file's own component: each file that imports it by its path (default
 * import, `{ default as X }`) and then writes that name, as a tag (`<Badge`) or a value; a
 * re-export (`export { default as Badge } from './Badge.astro'`) and, one level on, the files
 * that import it from there. Imports by a package name are unconfirmed.
 */
export async function componentRefs(root: string, symbol: CodeSymbol, where?: ReferenceOptions['where']): Promise<Uses> {
  const extensions = new Set([...codeExtensions, ...componentExtensions]);
  const file = symbol.file;
  const found: Position[] = [];
  const unconfirmed: Position[] = [];
  const barrels: { file: string; name: string }[] = [];
  const importers = new Set((await textMentions(root, basename(file), extensions).catch(() => [])).map((m) => m.file));
  // `-w` misses `./Badge.astro'` after a slash: search the name itself too.
  for (const m of await textMentions(root, basename(file).replace(/\.[^.]+$/, ''), extensions)) importers.add(m.file);
  importers.delete(file);
  for (const importer of importers) {
    const text = await readFile(join(root, importer), 'utf8');
    for (const i of importsIn(importer, text)) {
      const named = posix.basename(i.spec);
      if (named !== basename(file) && named !== basename(file).replace(/\.[^.]+$/, '')) continue;
      const clause = parseClause(i.clause);
      const lead = await leadsTo(root, importer, i.spec, 'default', file);
      if (lead === 'other') continue;
      const ours = lead === 'ours';
      const viaDefault = clause.named.filter(([from]) => from === 'default').map(([, local]) => local);
      if (i.reexport) {
        const at = { file: importer, line: i.line, character: 0 };
        (ours ? found : unconfirmed).push(at);
        for (const name of viaDefault) barrels.push({ file: importer, name });
        continue;
      }
      const locals = [...(clause.default ? [clause.default] : []), ...viaDefault];
      // A Vue template may write the tag in kebab case: `<my-button>` for MyButton.
      const tags = (local: string) =>
        importer.endsWith('.vue') && kebabCase(local) !== local.toLowerCase()
          ? mentionsIn(importer, text, kebabCase(local)).filter(
              (m) => /<\/?$/.test(m.text.slice(0, m.character)) && !m.text.slice(m.character + kebabCase(local).length).startsWith('-'),
            )
          : [];
      const uses = await inCode(root, locals.flatMap((local) => [...mentionsIn(importer, text, local), ...tags(local)]), where);
      (ours ? found : unconfirmed).push(...uses);
    }
  }
  // One level on: a barrel's re-export imported by name, from the barrel by its path or by a package.
  for (const barrel of barrels) {
    const byFile = new Map<string, Mention[]>();
    for (const m of await textMentions(root, barrel.name, extensions)) {
      if (m.file !== barrel.file && m.file !== file) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
    }
    for (const [user, mentions] of byFile) {
      const text = await readFile(join(root, user), 'utf8');
      const named = importsIn(user, text).filter((i) => !i.reexport && parseClause(i.clause).named.some(([from]) => from === barrel.name));
      if (named.length === 0) continue;
      const leads = await Promise.all(named.map((i) => leadsTo(root, user, i.spec, barrel.name, barrel.file)));
      if (leads.every((lead) => lead === 'other')) continue;
      (leads.includes('ours') ? found : unconfirmed).push(...(await inCode(root, mentions, where)));
    }
  }
  // Global components (unplugin-vue-components', Nuxt's components.d.ts): used with no import.
  // Its line in the .d.ts is no use, as no mention in a .d.ts is (textMentions). Nuxt's are by
  // its conventions, as its .d.ts files are not in git.
  const globalNames = [
    ...declaredGlobals(root).filter((g) => g.exported === 'default' && sameModule(g.target, file)).map((g) => g.name),
    ...nuxtComponents(root).filter((c) => c.file === file).flatMap((c) => c.names),
  ];
  for (const g of [...new Set(globalNames)].map((name) => ({ name }))) {
    const tags = kebabCase(g.name) === g.name.toLowerCase() ? [] : (await textMentions(root, kebabCase(g.name), new Set(['.vue']))).filter(
      (m) => /<\/?$/.test(m.text.slice(0, m.character)) && !m.text.slice(m.character + kebabCase(g.name).length).startsWith('-'),
    );
    const byFile = new Map<string, Mention[]>();
    for (const m of [...(await textMentions(root, g.name, componentExtensions)), ...tags]) {
      if (m.file !== file) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
    }
    for (const [user, mentions] of byFile) {
      const text = await readFile(join(root, user), 'utf8');
      // A file that imports a name of its own so is not using the global one.
      const own = importsIn(user, text).some((i) => {
        const c = parseClause(i.clause);
        return c.default === g.name || c.named.some(([, local]) => local === g.name);
      });
      if (!own) found.push(...(await inCode(root, mentions, where)));
    }
  }
  const have = new Set(found.map(key));
  return { found: unique(found), unconfirmed: unique(unconfirmed).filter((p) => !have.has(key(p))) };
}
