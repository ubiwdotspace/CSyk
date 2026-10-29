import type { CodeSymbol } from '../symbols.ts';

/**
 * A Markdown file's headings as sections, so specs and docs are found by
 * their titles and read one section at a time. A section runs to the next
 * heading of its level or above; `#` lines in fenced code are not headings.
 */
export function extractMarkdown(file: string, text: string): CodeSymbol[] {
  const lines = text.split('\n');
  const headings: { level: number; title: string; line: number }[] = [];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const marker = /^\s{0,3}(```|~~~)/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = undefined;
      return;
    }
    const heading = fence ? undefined : /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) headings.push({ level: heading[1].length, title: plain(heading[2]), line: i + 1 });
  });
  const ids = new Set<string>();
  return headings.map((heading, i) => {
    const next = headings.slice(i + 1).find((h) => h.level <= heading.level);
    let end = next ? next.line - 1 : lines.length;
    while (end > heading.line && !lines[end - 1]?.trim()) end--;
    let id = `${file}#${heading.title}`;
    for (let n = 2; ids.has(id); n++) id = `${file}#${heading.title}~${n}`;
    ids.add(id);
    const signature = (lines[heading.line - 1] ?? '').trim();
    return {
      id,
      name: heading.title,
      kind: 'section',
      lang: 'md',
      file,
      line: heading.line,
      range: [heading.line, end],
      signature: signature.length > 120 ? `${signature.slice(0, 119)}…` : signature,
      exported: true,
      isTest: false,
    };
  });
}

// A heading's text without Markdown: `code`, [links](url), **bold** and _italic_ marks.
function plain(title: string): string {
  return title
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}
