import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '../../src/token/session.ts';
import { runTool } from '../../src/tools/dispatch.ts';
import { Workspace } from '../../src/workspace/workspace.ts';
import type { Adapter, Corpus } from '../harness/types.ts';

/**
 * CSyk itself, called in-process the way its MCP server calls the tools:
 * `find` for a definition, `refs` for references, `calls` for callers and
 * callees, `grep` for a string and `impact` for a change, with the default
 * token budget and one session per corpus (so a hint is paid once, as in a
 * real session). Its tokens are the text those tools return.
 */
export function csyk(): Adapter {
  const workspaces = new Map<string, { ws: Promise<Workspace>; session: Session }>();
  const open = (corpus: Corpus) => {
    let entry = workspaces.get(corpus.root);
    if (!entry) {
      entry = { ws: Workspace.open(corpus.root), session: new Session() };
      workspaces.set(corpus.root, entry);
    }
    return entry;
  };

  return {
    name: 'csyk',
    supports: (c) => ['A', 'B', 'C', 'D', 'E', 'G'].includes(c.category),
    async run(c, corpus) {
      const { ws: opening, session } = open(corpus);
      const ws = await opening;
      session.nextCall();
      if (c.category === 'G') {
        const result = await withEdits(corpus.root, c.query, () => runTool(ws, 'impact', {}, session));
        return { hits: result.locations, output: result.text, calls: 1 };
      }
      const [tool, args] =
        c.category === 'C'
          ? (['refs', { target: c.query, limit: 1000 }] as const)
          : c.category === 'D'
            ? (['calls', { target: c.query, direction: c.direction ?? 'in', limit: 200 }] as const)
            : c.category === 'E'
              ? (['grep', { pattern: c.query }] as const)
              : (['find', { query: c.query }] as const);
      const result = await runTool(ws, tool, args, session);
      return { hits: result.locations, output: result.text, calls: 1 };
    },
    async close() {
      for (const { ws } of workspaces.values()) await (await ws).close();
      workspaces.clear();
    },
  };
}

/**
 * Runs [ask] with a G case's edits made: a space at the end of each
 * `file:line` in [edits]. The files are put back afterwards, whatever happens.
 */
export async function withEdits<T>(root: string, edits: string, ask: () => Promise<T>): Promise<T> {
  const byFile = new Map<string, number[]>();
  for (const edit of edits.split(/\s+/)) {
    const match = /^(.+):(\d+)$/.exec(edit);
    if (!match?.[1] || !match[2]) throw new Error(`edit ${edit} is not file:line`);
    byFile.set(match[1], [...(byFile.get(match[1]) ?? []), Number(match[2])]);
  }
  const originals = new Map<string, string>();
  try {
    for (const [file, lines] of byFile) {
      const text = await readFile(join(root, file), 'utf8');
      originals.set(file, text);
      const edited = text.split('\n').map((line, i) => (lines.includes(i + 1) ? `${line} ` : line));
      await writeFile(join(root, file), edited.join('\n'));
    }
    return await ask();
  } finally {
    for (const [file, text] of originals) await writeFile(join(root, file), text);
  }
}

