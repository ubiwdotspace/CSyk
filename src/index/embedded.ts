import { basename, dirname, extname } from 'node:path';

/**
 * Component files whose code sits among markup: Astro (a TypeScript frontmatter between `---`
 * lines, `<script>` tags, `{…}` expressions), Svelte (`<script>`, `{…}` expressions and blocks)
 * Vue (`<script>`, `{{ … }}` and bound attributes) and MDX (its `import` and `export` lines,
 * `{…}` expressions and component tags). No compiler reads them for CSyk, so
 * their code is read with the TSX grammar, from the text [maskComponent] keeps.
 */
export const componentExtensions: ReadonlySet<string> = new Set(['.astro', '.svelte', '.vue', '.mdx']);

export const isComponentFile = (file: string): boolean => componentExtensions.has(extname(file));

/**
 * [text] with only its code kept, every other character but line breaks made a space, so each
 * line and column stays where it was: frontmatter, scripts, template expressions (each between
 * `;`, so none runs into the next) and the names of components used as tags (`<Badge` keeps
 * `Badge`). Markup, styles, comments and plain text go.
 */
export function maskComponent(file: string, text: string): string {
  const ext = extname(file);
  if (ext === '.mdx') return maskMdx(text);
  const out = text.replace(/[^\n]/g, ' ').split('');
  const keep = (from: number, to: number) => {
    for (let i = from; i < to; i++) out[i] = text[i] ?? ' ';
  };
  const put = (at: number, c: string) => {
    if (at >= 0 && at < out.length && text[at] !== '\n') out[at] = c;
  };
  let i = 0;
  if (ext === '.astro') {
    const fence = /^﻿?\s*---[ \t]*\r?\n/.exec(text);
    if (fence) {
      const close = /\n---[ \t]*(?:\r?\n|$)/g;
      close.lastIndex = fence[0].length - 1;
      const end = close.exec(text);
      const stop = end ? end.index : text.length;
      keep(fence[0].length, stop);
      // The closing `---` ends the frontmatter's last statement.
      put(stop + 1, ';');
      i = end ? end.index + end[0].length : text.length;
    }
  }
  const braces = ext !== '.vue';
  while (i < text.length) {
    const c = text[i];
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      i = end < 0 ? text.length : end + 3;
    } else if (c === '<' && /^<(script|style)\b/i.test(text.slice(i, i + 7))) {
      const tag = /^<(script|style)\b/i.exec(text.slice(i, i + 7))?.[1]?.toLowerCase() ?? 'script';
      const open = tagEnd(text, i);
      // `<script … />` has no content, only attributes (Astro's `set:html={…}`); one never
      // closed has none either, rather than the rest of the file.
      const close = text[open - 2] === '/' ? -1 : text.toLowerCase().indexOf(`</${tag}`, open);
      if (close < 0) {
        i = attributes(text, i + 1, ext, keep, put);
        continue;
      }
      if (tag === 'script' && isCodeScript(text.slice(i, open))) {
        put(open - 1, ';');
        keep(open, close);
        put(close, ';');
      }
      i = tagEnd(text, close);
    } else if (c === '<' && /[A-Za-z/]/.test(text[i + 1] ?? '')) {
      // A component used as a tag: `<Badge`, `</Badge>`, `<Foo.Bar`. Its attributes follow.
      const name = /^<\/?([A-Z][\w$]*(?:\.[\w$]+)*)/.exec(text.slice(i, i + 200));
      // Vue's `<my-button>` is the component MyButton: written so in place, its column kept.
      const kebab = ext === '.vue' ? /^<\/?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s/>])/.exec(text.slice(i, i + 200)) : null;
      if (name?.[1]) {
        const at = i + name[0].length - name[1].length;
        put(i, ';');
        keep(at, at + name[1].length);
        put(at + name[1].length, ';');
      } else if (kebab?.[1]) {
        const at = i + kebab[0].length - kebab[1].length;
        const pascal = pascalCase(kebab[1]);
        put(i, ';');
        for (let j = 0; j < pascal.length; j++) put(at + j, pascal[j] ?? ' ');
        put(at + kebab[1].length, ';');
      }
      i = attributes(text, i + 1, ext, keep, put);
    } else if (braces && c === '{') {
      i = expression(text, i, '{', '}', keep, put);
    } else if (ext === '.vue' && text.startsWith('{{', i)) {
      i = expression(text, i + 1, '{', '}', keep, put) + 1;
    } else i++;
  }
  return out.join('');
}

/**
 * An MDX file's code, as [maskComponent] keeps it: the `import` and `export` statements that
 * start a line (a statement runs on to its end, or to a blank line), `{…}` expressions and the
 * names of component tags. Its YAML frontmatter, fenced code blocks and inline code are
 * examples or data, and go with the prose.
 */
function maskMdx(text: string): string {
  const out = text.replace(/[^\n]/g, ' ').split('');
  const keep = (from: number, to: number) => {
    for (let i = from; i < to; i++) out[i] = text[i] ?? ' ';
  };
  const put = (at: number, c: string) => {
    if (at >= 0 && at < out.length && text[at] !== '\n') out[at] = c;
  };
  // First the lines: frontmatter and fences are skipped, ESM statements kept.
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let n = 0, at = 0; n < lines.length; at += (lines[n] ?? '').length + 1, n++) starts.push(at);
  const prose: boolean[] = lines.map(() => true);
  let n = 0;
  if (/^\uFEFF?---\s*$/.test(lines[0] ?? '')) {
    for (prose[0] = false, n = 1; n < lines.length && !/^---\s*$/.test(lines[n] ?? ''); n++) prose[n] = false;
    prose[n] = false;
    n++;
  }
  let fence: string | undefined;
  let esm = false;
  for (; n < lines.length; n++) {
    const line = lines[n] ?? '';
    if (fence) {
      prose[n] = false;
      if (line.trimStart().startsWith(fence)) fence = undefined;
      continue;
    }
    const opened = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (opened) {
      prose[n] = false;
      fence = opened;
      continue;
    }
    if (esm || /^(?:import|export)\s/.test(line)) {
      prose[n] = false;
      keep(starts[n] ?? 0, (starts[n] ?? 0) + line.length);
      // A statement ends with its module (`from '…'`, `import '…'`), a `;`, or a blank line.
      esm = line.trim() !== '' && !/(?:['"]\s*;?|;)\s*$/.test(line);
    }
  }
  // Then the prose: inline code skipped, `{…}` and component tags kept.
  const proseAt = (i: number) => {
    let line = 0;
    while (line + 1 < starts.length && (starts[line + 1] ?? Infinity) <= i) line++;
    return prose[line] ?? false;
  };
  for (let i = 0; i < text.length; ) {
    if (!proseAt(i)) {
      const next = text.indexOf('\n', i);
      i = next < 0 ? text.length : next + 1;
    } else if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? '`';
      const close = text.indexOf(run, i + run.length);
      i = close < 0 ? i + run.length : close + run.length;
    } else if (text[i] === '<' && /[A-Z/]/.test(text[i + 1] ?? '')) {
      const name = /^<\/?([A-Z][\w$]*(?:\.[\w$]+)*)/.exec(text.slice(i, i + 200));
      if (name?.[1]) {
        const at = i + name[0].length - name[1].length;
        put(i, ';');
        keep(at, at + name[1].length);
        put(at + name[1].length, ';');
      }
      i = attributes(text, i + 1, '.mdx', keep, put);
    } else if (text[i] === '{') {
      i = expression(text, i, '{', '}', keep, put);
    } else i++;
  }
  return out.join('');
}

// Whether a `<script …>` tag holds JavaScript or TypeScript, not data (JSON, a template).
function isCodeScript(tag: string): boolean {
  const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase();
  return !type || /^(module|text\/javascript|application\/javascript|text\/typescript|ts)$/.test(type);
}

// The index past the `>` that ends the tag opened at [from], quotes skipped.
function tagEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return text.length;
      i = end;
    } else if (c === '>') return i + 1;
  }
  return text.length;
}

/**
 * Walks a tag's attributes from [from] to past its `>`, keeping the code in them: `{…}` in
 * Astro and Svelte, and in Vue the value of a bound attribute (`:to`, `v-if`, `@click`, `#slot`).
 */
function attributes(text: string, from: number, ext: string, keep: (a: number, b: number) => void, put: (at: number, c: string) => void): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '>') return i + 1;
    if (c === '{' && ext !== '.vue') {
      i = expression(text, i, '{', '}', keep, put) - 1;
    } else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return text.length;
      const name = /([^\s=]+)\s*=\s*$/.exec(text.slice(Math.max(from, i - 80), i))?.[1] ?? '';
      if (ext === '.vue' && /^(?::|@|#|v-)/.test(name)) {
        put(i, ';');
        keep(i + 1, end);
        put(end, ';');
      }
      i = end;
    }
  }
  return text.length;
}

/**
 * Keeps the expression from the [open] brace at [from] to its matching [close], with a `;` in
 * place of each brace; a Svelte block's keyword (`#each`, `:else if`, `/if`, `@html`) goes.
 * Returns the index past it, or past the brace alone when it never closes.
 */
function expression(text: string, from: number, open: string, close: string, keep: (a: number, b: number) => void, put: (at: number, c: string) => void): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(text, i);
      if (end < 0) return from + 1;
      i = end;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      keep(from + 1, i);
      const block = /^\s*(?:[#:/@][a-z]+(?:\s+if\b)?)/.exec(text.slice(from + 1, i));
      if (block) for (let j = from + 1; j < from + 1 + block[0].length; j++) put(j, ' ');
      put(from, ';');
      put(i, ';');
      return i + 1;
    }
  }
  return from + 1;
}

// The index of the quote that ends the string opened at [from], or -1.
function stringEnd(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
    else if (text[i] === '\n' && quote !== '`') return -1;
  }
  return -1;
}

/**
 * What a component file declares by being there: a component named after the file, as it is
 * imported (`Badge.astro` is `Badge`, `my-button.vue` is `MyButton`), or a route for a page
 * (`src/pages/…` in Astro and Nuxt, `+page.svelte` in SvelteKit), named as the file is.
 */
export function componentOf(file: string): { name: string; kind: 'component' | 'route' } {
  const ext = extname(file);
  const base = basename(file, ext);
  const route = base.startsWith('+') || /(^|\/)pages\//.test(file) || /[[\]]/.test(base);
  if (route) return { name: base === 'index' ? `${basename(dirname(file))}/index` : base, kind: 'route' };
  return { name: pascalCase(base) || base, kind: 'component' };
}

/** `my-button` as `MyButton`, how Vue and file names spell a component. */
export function pascalCase(name: string): string {
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('');
}

/** `MyButton` as `my-button`, how a Vue template may write the tag. */
export function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
}

/** The line that says what a component takes: its Props type, `$props()` or `defineProps`, else undefined. */
export function propsLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .find((l) => /^\s*(?:export\s+)?(?:interface|type)\s+Props\b|\$props\(\)|defineProps\b|^\s*export\s+let\s+\w/.test(l));
  return line?.trim();
}
