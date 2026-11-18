import { basename, dirname, extname } from 'node:path';

/**
 * Component files whose code sits among markup: Astro (a TypeScript frontmatter between `---`
 * lines, `<script>` tags, `{…}` expressions), Svelte (`<script>`, `{…}` expressions and blocks)
 * and Vue (`<script>`, `{{ … }}` and bound attributes). No compiler reads them for CSyk, so
 * their code is read with the TSX grammar, from the text [maskComponent] keeps.
 */
export const componentExtensions: ReadonlySet<string> = new Set(['.astro', '.svelte', '.vue']);

export const isComponentFile = (file: string): boolean => componentExtensions.has(extname(file));

/**
 * [text] with only its code kept, every other character but line breaks made a space, so each
 * line and column stays where it was: frontmatter, scripts, template expressions (each between
 * `;`, so none runs into the next) and the names of components used as tags (`<Badge` keeps
 * `Badge`). Markup, styles, comments and plain text go.
 */
export function maskComponent(file: string, text: string): string {
  const ext = extname(file);
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
      const close = text.toLowerCase().indexOf(`</${tag}`, open);
      const end = close < 0 ? text.length : close;
      if (tag === 'script' && isCodeScript(text.slice(i, open))) {
        put(open - 1, ';');
        keep(open, end);
        put(end, ';');
      }
      i = close < 0 ? text.length : tagEnd(text, close);
    } else if (c === '<' && /[A-Za-z/]/.test(text[i + 1] ?? '')) {
      // A component used as a tag: `<Badge`, `</Badge>`, `<Foo.Bar`. Its attributes follow.
      const name = /^<\/?([A-Z][\w$]*(?:\.[\w$]+)*)/.exec(text.slice(i, i + 200));
      if (name?.[1]) {
        const at = i + name[0].length - name[1].length;
        put(i, ';');
        keep(at, at + name[1].length);
        put(at + name[1].length, ';');
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
  const name = base
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('');
  return { name: name || base, kind: 'component' };
}

/** The line that says what a component takes: its Props type, `$props()` or `defineProps`, else undefined. */
export function propsLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .find((l) => /^\s*(?:export\s+)?(?:interface|type)\s+Props\b|\$props\(\)|defineProps\b|^\s*export\s+let\s+\w/.test(l));
  return line?.trim();
}
