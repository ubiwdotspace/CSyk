import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Adapter, Corpus, Hit } from '../harness/types.ts';
import { startMcp, uvToolBin, type McpServer } from './mcp.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
// The Graphify release measured; GRAPHIFY_FROM points uvx at another.
export const graphifyFrom = process.env.GRAPHIFY_FROM ?? 'graphifyy[mcp]==0.9.97';

/**
 * Builds, or brings up to date, the code graph of the folder [code] in
 * [dir] with `graphify extract --code-only`. It runs off the event loop, so
 * a resource watcher in this process sees it.
 */
export async function buildGraphifyGraph(code: string, dir: string): Promise<void> {
  await promisify(execFile)('uvx', ['-q', '--from', graphifyFrom, 'graphify', 'extract', code, '--code-only', '--out', dir], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Where the code graph of [corpus] lives, built when missing. */
async function graphifyGraph(corpus: Corpus): Promise<string> {
  const dir = join(root, 'eval/corpora/.graphify', corpus.name);
  const graph = join(dir, 'graphify-out/graph.json');
  if (!existsSync(graph)) await buildGraphifyGraph(corpus.root, dir);
  return graph;
}

/** The command that serves [graph] over MCP. */
const graphifyServer = (graph: string) => ({ command: 'uvx', args: ['-q', '--from', graphifyFrom, 'python', '-m', 'graphify.serve', graph] });

/** The rules `graphify claude install` writes into CLAUDE.md, read from the installed release. */
export function graphifyRules(): string {
  const script = 'from graphify.install import _always_on; print(_always_on("claude-md"))';
  return execFileSync(join(uvToolBin(graphifyFrom), 'python'), ['-c', script], { encoding: 'utf8' }).trim();
}

/**
 * Graphify (Apache-2.0) over its MCP server, on the corpus's code graph
 * (local tree-sitter parse, no LLM; built on the first question if missing):
 * `get_node` for a definition, retried with `path::name` on each candidate
 * when the name is ambiguous, as the answer says to; `query_graph` for part
 * of a name or a message; `get_neighbors` for uses (incoming edges other than
 * `contains`) and for callers (incoming `calls`) or callees (outgoing
 * `calls`, each then looked up with `get_node`). Its MCP server has no tool
 * for an edit's impact, so G is not asked.
 */
export function graphify(): Adapter {
  let server: { root: string; mcp: McpServer } | undefined;
  const connect = async (corpus: Corpus): Promise<McpServer> => {
    if (server?.root === corpus.root) return server.mcp;
    await server?.mcp.close();
    const { command, args } = graphifyServer(await graphifyGraph(corpus));
    server = { root: corpus.root, mcp: await startMcp(command, args, corpus.root) };
    return server.mcp;
  };

  return {
    name: 'graphify',
    supports: (c) => ['A', 'B', 'C', 'D', 'E'].includes(c.category),
    async run(c, corpus) {
      const mcp = await connect(corpus);
      const outputs: string[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const text = await mcp.call(name, args);
        outputs.push(text);
        return text;
      };
      let hits: Hit[];
      if (c.category === 'B' || c.category === 'E') {
        hits = parseGraphifyLocations(await call('query_graph', { question: c.query }));
      } else if (c.category === 'A') {
        const node = await call('get_node', { label: c.query });
        hits = parseGraphifyLocations(node);
        for (const path of ambiguousPaths(node).slice(0, 5)) {
          hits.push(...parseGraphifyLocations(await call('get_node', { label: `${path}::${c.query}` })));
        }
      } else if (c.category === 'C') {
        hits = parseGraphifyNeighbors(await call('get_neighbors', { label: c.query })).flatMap((n) =>
          n.incoming && n.relation !== 'contains' ? [n.at] : [],
        );
      } else if (c.direction === 'out') {
        const callees = parseGraphifyNeighbors(await call('get_neighbors', { label: c.query, relation_filter: 'calls' }));
        hits = [];
        for (const n of callees.filter((n) => !n.incoming).slice(0, 20)) {
          hits.push(...parseGraphifyLocations(await call('get_node', { label: n.label })));
        }
      } else {
        hits = parseGraphifyNeighbors(await call('get_neighbors', { label: c.query, relation_filter: 'calls' })).flatMap((n) =>
          n.incoming ? [n.at] : [],
        );
      }
      return { hits, output: outputs.join('\n'), calls: outputs.length };
    },
    async close() {
      await server?.mcp.close();
      server = undefined;
    },
  };
}

/** Node locations in rank order: `Source: path L12` (get_node) and `[src=path loc=L12` (query_graph). */
export function parseGraphifyLocations(text: string): Hit[] {
  return [...text.matchAll(/(?:Source: (\S+) L|\[src=(\S+) loc=L)(\d+)/g)].map((m) => ({
    file: (m[1] ?? m[2]) as string,
    line: Number(m[3]),
  }));
}

/** The edges in a `get_neighbors` answer: `<-- label [relation] … at=path:L12`, `-->` for outgoing. */
export function parseGraphifyNeighbors(text: string): { incoming: boolean; label: string; relation: string; at: Hit }[] {
  return [...text.matchAll(/^\s*(<--|-->) (.+?) \[(\w+)\].*?\bat=(\S+):L(\d+)/gm)].map((m) => ({
    incoming: m[1] === '<--',
    label: m[2] as string,
    relation: m[3] as string,
    at: { file: m[4] as string, line: Number(m[5]) },
  }));
}

// The candidate files listed when a name matches nodes in several files.
function ambiguousPaths(text: string): string[] {
  if (!text.startsWith('Ambiguous')) return [];
  return [...text.matchAll(/^ {2}(\S+)$/gm)].map((m) => m[1] as string);
}
