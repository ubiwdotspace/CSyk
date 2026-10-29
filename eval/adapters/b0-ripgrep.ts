import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import type { Adapter, Case, Hit } from '../harness/types.ts';

const run = promisify(execFile);

// Words a concept question carries that say nothing about the code.
const stopWords = new Set(['where', 'what', 'which', 'when', 'does', 'that', 'this', 'with', 'from']);

/**
 * B0: an agent with its built-in tools only. It greps the way an agent
 * would; for a definition, a string or a concept it then reads the first
 * matching file whole (Grep → Read), while for references and callers the
 * grep lines are the answer. Grep does not rank, so the hits come in path
 * order.
 */
export const b0Ripgrep: Adapter = {
  name: 'b0-ripgrep',
  // Grep finds the lines that call a name, not what a body calls.
  supports: (c) => ['A', 'B', 'C', 'E', 'F'].includes(c.category) || (c.category === 'D' && c.direction === 'in'),
  async run(c, corpus) {
    const grep = await ripgrep(searchArgs(c), corpus.root);
    const hits = parseHits(grep);
    const first = hits[0];
    if (c.category === 'C' || c.category === 'D' || !first) return { hits, output: grep, calls: 1 };
    const file = await readFile(join(corpus.root, first.file), 'utf8');
    return { hits, output: grep + readLikeAgent(file), calls: 2 };
  },
};

function searchArgs(c: Case): string[] {
  switch (c.category) {
    case 'B':
      return ['--fixed-strings', '--ignore-case', '-e', c.query];
    case 'C':
      return ['--fixed-strings', '--word-regexp', '-e', c.query];
    case 'D': {
      // A call: `name(`, `new Name`, `<Name` (JSX) or `@name` (a decorator).
      const name = c.query.replace(/[$]/g, '\\$&');
      return ['-e', `\\b${name}\\s*\\(|new\\s+${name}\\b|<${name}\\b|@${name}\\b`];
    }
    case 'F': {
      const words = c.query
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length >= 4 && !stopWords.has(word));
      return ['--ignore-case', '-e', words.join('|') || c.query];
    }
    default:
      return ['--fixed-strings', '-e', c.query];
  }
}

async function ripgrep(args: string[], cwd: string): Promise<string> {
  const base = ['--line-number', '--no-heading', '--color', 'never', '--sort', 'path'];
  try {
    // An explicit "." keeps ripgrep off stdin, which it would otherwise
    // wait on when not run from a terminal.
    const { stdout } = await run(rgPath, [...base, ...args, '.'], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // Exit code 1 is ripgrep's "no match", not a failure.
    if ((error as { code?: unknown }).code === 1) return '';
    throw error;
  }
}

/** `./path:line:text` lines, as ripgrep prints them, to repo-relative hits. */
export function parseHits(grep: string): Hit[] {
  return grep.split('\n').flatMap((line) => {
    const match = /^(?:\.\/)?(.+?):(\d+):/.exec(line);
    return match?.[1] && match[2] ? [{ file: match[1], line: Number(match[2]) }] : [];
  });
}

/** A whole file as the agent's Read tool shows it: numbered, 2,000 lines at most. */
function readLikeAgent(file: string): string {
  return file
    .split('\n')
    .slice(0, 2000)
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join('\n');
}
