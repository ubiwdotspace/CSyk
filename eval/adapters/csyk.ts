import { Session } from '../../src/token/session.ts';
import { runTool } from '../../src/tools/dispatch.ts';
import { Workspace } from '../../src/workspace/workspace.ts';
import type { Adapter, Category, Corpus } from '../harness/types.ts';

/**
 * CSyk itself, called in-process the way its MCP server calls the tools:
 * `find` for a definition, `refs` for references, `grep` for a string, with
 * the default token budget and one session per corpus (so a hint is paid
 * once, as in a real session). Its tokens are the text those tools return.
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
    supports: (category: Category) => ['A', 'B', 'C', 'E'].includes(category),
    async run(c, corpus) {
      const { ws, session } = open(corpus);
      session.nextCall();
      const [tool, args] =
        c.category === 'C'
          ? (['refs', { target: c.query, limit: 1000 }] as const)
          : c.category === 'E'
            ? (['grep', { pattern: c.query }] as const)
            : (['find', { query: c.query }] as const);
      const result = await runTool(await ws, tool, args, session);
      return { hits: result.locations, output: result.text, calls: 1 };
    },
    async close() {
      for (const { ws } of workspaces.values()) await (await ws).close();
      workspaces.clear();
    },
  };
}
