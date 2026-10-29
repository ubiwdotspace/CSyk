import type { Adapter, Corpus, Hit } from '../harness/types.ts';
import { startMcp, type McpServer } from './mcp.ts';

// The Serena commit measured; SERENA_FROM points uvx at another.
export const serenaFrom = process.env.SERENA_FROM ?? 'git+https://github.com/oraios/serena@ede329aaf0c824bea75455a2926f01420d7aa620';

/** The context `serena setup claude-code` registers, without the dashboard. */
export const serenaOptions = ['--context=claude-code', '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false'];

/** The command that starts Serena's MCP server with [serenaOptions] plus [options]. */
export const serenaCommand = (options: string[]) => ({
  command: 'uvx',
  args: ['-q', '--from', serenaFrom, 'serena', 'start-mcp-server', ...serenaOptions, ...options],
});

/**
 * Serena (GPL-3.0, evaluated here, never shipped) over MCP, in the
 * claude-code context and with one tool per operation: `find_symbol` for a
 * definition (with substring matching for part of a name), and for uses and
 * callers `find_symbol` then `find_referencing_symbols`, which needs the
 * symbol's file. In that context text search is left to the agent's own
 * Grep, and Serena has no tool for callees or for an edit's impact, so E,
 * D out and G are not asked.
 */
export function serena(): Adapter {
  let server: { root: string; mcp: McpServer } | undefined;
  const connect = async (corpus: Corpus): Promise<McpServer> => {
    if (server?.root === corpus.root) return server.mcp;
    await server?.mcp.close();
    const { command, args } = serenaCommand(['--agent-interface', 'tools', '--project', corpus.root]);
    server = { root: corpus.root, mcp: await startMcp(command, args, corpus.root) };
    return server.mcp;
  };

  return {
    name: 'serena',
    supports: (c) => ['A', 'B', 'C'].includes(c.category) || (c.category === 'D' && c.direction !== 'out'),
    async run(c, corpus) {
      const mcp = await connect(corpus);
      const found = await mcp.call('find_symbol', { name_path_pattern: c.query, substring_matching: c.category === 'B' });
      const symbols = parseSerenaSymbols(found);
      if (c.category === 'A' || c.category === 'B') return { hits: symbols, output: found, calls: 1 };
      const first = symbols[0];
      if (!first) return { hits: [], output: found, calls: 1 };
      const refs = await mcp.call('find_referencing_symbols', { name_path: first.namePath, relative_path: first.file });
      return { hits: parseSerenaReferences(refs), output: `${found}\n${refs}`, calls: 2 };
    },
    async close() {
      await server?.mcp.close();
      server = undefined;
    },
  };
}

/** The symbols in a `find_symbol` answer, in order; Serena counts lines from 0. */
export function parseSerenaSymbols(text: string): (Hit & { namePath: string })[] {
  const list = parseJson(text);
  if (!Array.isArray(list)) return [];
  return list.flatMap((s: { name_path?: string; relative_path?: string; body_location?: { start_line?: number } }) =>
    s.relative_path && s.name_path && s.body_location?.start_line !== undefined
      ? [{ file: s.relative_path, line: s.body_location.start_line + 1, namePath: s.name_path }]
      : [],
  );
}

/** Each reference in a `find_referencing_symbols` answer: its file and the line marked `>`. */
export function parseSerenaReferences(text: string): Hit[] {
  const byFile = parseJson(text);
  if (!byFile || typeof byFile !== 'object' || Array.isArray(byFile)) return [];
  const hits: Hit[] = [];
  for (const [file, byKind] of Object.entries(byFile as Record<string, Record<string, { content_around_reference?: string }[]>>)) {
    for (const refs of Object.values(byKind)) {
      for (const ref of refs) {
        const line = /^\s*>\s*(\d+):/m.exec(ref.content_around_reference ?? '')?.[1];
        if (line) hits.push({ file, line: Number(line) + 1 });
      }
    }
  }
  return hits;
}

// Serena answers JSON, or a sentence when the answer is too long or fails.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
