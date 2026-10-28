import { find, grep, refs } from '../../src/tools/tools.ts';
import { Workspace } from '../../src/workspace/workspace.ts';
import type { Adapter, Category, Corpus } from '../harness/types.ts';

/**
 * CSyk itself, called in-process: `find` for a definition, `refs` for
 * references, `grep` for a string. Its tokens are the text those tools
 * return.
 */
export function csyk(): Adapter {
  const workspaces = new Map<string, Promise<Workspace>>();
  const open = (corpus: Corpus) => {
    let ws = workspaces.get(corpus.root);
    if (!ws) {
      ws = Workspace.open(corpus.root);
      workspaces.set(corpus.root, ws);
    }
    return ws;
  };

  return {
    name: 'csyk',
    supports: (category: Category) => ['A', 'B', 'C', 'E'].includes(category),
    async run(c, corpus) {
      const ws = await open(corpus);
      const result =
        c.category === 'C'
          ? await refs(ws, c.query, 1000)
          : c.category === 'E'
            ? await grep(ws, c.query)
            : find(ws, c.query);
      return { hits: result.locations, output: result.text, calls: 1 };
    },
    async close() {
      for (const ws of workspaces.values()) await (await ws).close();
      workspaces.clear();
    },
  };
}
