import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Adapter, Category, Corpus, Hit } from '../harness/types.ts';

// The server Claude Code runs for CodeSift; override with CODESIFT_MCP.
const command = process.env.CODESIFT_MCP ?? 'codesift-mcp';

/**
 * B1: an agent using CodeSift (BSL-1.1, evaluated here, never shipped) over
 * MCP, the way CodeSift's own rules tell it to: `search_symbols` with source
 * for a definition, `find_references` for references, `search_text` for a
 * string. Its tokens are the text those tools return.
 *
 * The harness never indexes for CodeSift: a corpus names its CodeSift repo
 * in `codesift`, indexed beforehand with `codesift index <path> --no-watch`.
 */
export function b1CodeSift(): Adapter {
  let client: Client | undefined;

  const connect = async (corpus: Corpus): Promise<Client> => {
    if (client) return client;
    const transport = new StdioClientTransport({ command, args: [], cwd: corpus.root, stderr: 'ignore' });
    const fresh = new Client({ name: 'csyk-eval', version: '0.0.0' });
    await fresh.connect(transport);
    client = fresh;
    return fresh;
  };

  return {
    name: 'b1-codesift',
    supports: (category: Category) => ['A', 'B', 'C', 'E'].includes(category),
    async run(c, corpus) {
      const repo = corpus.codesift;
      if (!repo) {
        throw new Error(
          `Corpus ${corpus.name} names no CodeSift repo: index it with ` +
            '`codesift index <path> --no-watch` and add `codesift: <repo>` to its entry',
        );
      }
      const [name, args] =
        c.category === 'C'
          ? ['find_references', { repo, symbol_name: c.query }]
          : c.category === 'E'
            ? ['search_text', { repo, query: c.query }]
            : ['search_symbols', { repo, query: c.query, include_source: true }];
      const result = await (await connect(corpus)).callTool({ name, arguments: args });
      const output = (result.content as { type: string; text?: string }[])
        .map((part) => part.text ?? '')
        .join('\n');
      return { hits: parseCodeSiftHits(output), output, calls: 1 };
    },
    async close() {
      await client?.close();
      client = undefined;
    },
  };
}

/**
 * Hits from CodeSift's text answers: `path:line …` lines, and `  line: …`
 * lines under a bare `path` heading, in order and without repeats.
 */
export function parseCodeSiftHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const add = (file: string, line: number) => {
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ file, line });
  };
  let heading: string | undefined;
  for (const line of text.split('\n')) {
    const located = /^([^\s:]+\.\w+):(\d+)\b/.exec(line);
    if (located?.[1] && located[2]) {
      add(located[1], Number(located[2]));
      heading = undefined;
      continue;
    }
    const path = /^([^\s:]+\.\w+)$/.exec(line);
    if (path?.[1]) {
      heading = path[1];
      continue;
    }
    const under = /^\s+(\d+):/.exec(line);
    if (under?.[1] && heading) add(heading, Number(under[1]));
  }
  return hits;
}
