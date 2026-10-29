import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { codeExtensions } from '../index/parse.ts';
import { defaultBudget, estimateTokens, fit } from '../token/budget.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { ToolResult } from './tools.ts';

const run = promisify(execFile);

/**
 * Files that are not code (docs, specs, configs, translations, images):
 * reading them, finding where one is named, and finding where a symbol's
 * name appears in them.
 */

/** [path] as a repo-relative file of the workspace, or undefined: nothing outside it is read. */
export function projectFile(ws: Workspace, path: string): string | undefined {
  const file = relative(ws.root, join(ws.root, path));
  if (!file || file.startsWith('..') || isAbsolute(file)) return undefined;
  const full = join(ws.root, file);
  return existsSync(full) && statSync(full).isFile() ? file : undefined;
}

/** `read` of a file CSyk does not index: a text file from its first line, a binary one by what it is. */
export async function readOther(ws: Workspace, file: string, budget = defaultBudget): Promise<ToolResult> {
  const bytes = await readFile(join(ws.root, file));
  if (bytes.subarray(0, 8000).includes(0)) {
    return { text: `${file} · binary, ${Math.ceil(bytes.length / 1024)} KB; refs ${file} lists where it is named`, locations: [] };
  }
  const lines = bytes.toString('utf8').split('\n');
  let kept = Math.min(lines.length, 200);
  while (kept > 1 && estimateTokens(lines.slice(0, kept).join('\n')) > budget) kept = Math.floor(kept * 0.8);
  const rest = kept < lines.length ? [`… ${lines.length - kept} more lines; read ${file}:${kept + 1}-${Math.min(lines.length, kept + 200)} for them`] : [];
  return { text: [`${file} · lines 1-${kept}`, ...lines.slice(0, kept), ...rest].join('\n'), locations: [{ file, line: 1 }] };
}

/**
 * `refs` of a file, such as an image, a doc or a config: the lines that
 * name it, and those that name its folder, which is how assets are often
 * declared (pubspec.yaml, a bundler config) or built into paths.
 */
export async function refsToFile(ws: Workspace, file: string, budget = defaultBudget): Promise<ToolResult> {
  const folder = dirname(file);
  const hits = await search(ws.root, ['-F', '-e', basename(file), ...(folder === '.' ? [] : ['-e', `${folder}/`])]);
  const named = hits.filter((h) => h.file !== file);
  const where = (h: Hit) => {
    const home = ws.index.containing(h.file, h.line);
    return `${h.file}:${h.line}${home ? `  ${home.name}` : ''}  ${h.text.trim().slice(0, 100)}`;
  };
  const files = new Set(named.map((h) => h.file)).size;
  const fitted = fit(`${file} · named in ${named.length} line${named.length === 1 ? '' : 's'} of ${files} file${files === 1 ? '' : 's'} · text`, named.map(where), {
    budget,
    narrow: 'grep the name with a path to see them',
  });
  return { text: fitted.text, locations: named.slice(0, fitted.shown).map((h) => ({ file: h.file, line: h.line })) };
}

/** Where [name] appears as a whole word outside code (docs, specs, configs, translations): `file:line`, at most [limit]. */
export async function mentionsOutsideCode(root: string, name: string, limit = 6): Promise<{ shown: string[]; total: number }> {
  if (name.length < 3) return { shown: [], total: 0 };
  // Lock files name every dependency and say nothing about the code.
  const skip = [...[...codeExtensions].map((ext) => `!*${ext}`), '!*.lock', '!*-lock.json', '!*-lock.yaml'];
  const hits = await search(root, ['-w', '-F', ...skip.flatMap((glob) => ['-g', glob]), '-e', name]);
  return { shown: hits.slice(0, limit).map((h) => `${h.file}:${h.line}`), total: hits.length };
}

type Hit = { file: string; line: number; text: string };

// ripgrep over the workspace with [args], as file, line and text, sorted by file.
async function search(root: string, args: string[]): Promise<Hit[]> {
  let stdout = '';
  try {
    ({ stdout } = await run(rgPath, ['--line-number', '--with-filename', '--no-heading', '--color', 'never', '--max-columns', '300', ...args, '.'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    // Exit code 1 is ripgrep's "no match".
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  return stdout
    .split('\n')
    .flatMap((entry) => {
      const match = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(entry);
      return match?.[1] && match[2] ? [{ file: match[1], line: Number(match[2]), text: match[3] ?? '' }] : [];
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
