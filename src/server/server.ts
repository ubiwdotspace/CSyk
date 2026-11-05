import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { estimateTokens } from '../token/budget.ts';
import { resetMarker, seenLog, Session } from '../token/session.ts';
import { listedSchema, listedTools, runTool } from '../tools/dispatch.ts';
import type { ToolResult } from '../tools/tools.ts';
import { Workspace } from '../workspace/workspace.ts';

// The package's version, from src/ and from dist/ alike (both two folders down).
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

/**
 * The CSyk MCP server for the workspace at [root]. The index is built as
 * the server starts; the first tool call waits for it. One server is one
 * agent session: it remembers which bodies it showed and which hints it
 * gave until a hook touches the reset marker.
 */
export function createServer(root: string): { server: McpServer; close: () => Promise<void> } {
  const workspace = Workspace.start(root, { watch: true, persist: true });
  // A failed build surfaces on a tool call that waits for it, not as an unhandled rejection.
  workspace.ready.catch(() => {});
  const session = new Session({ marker: resetMarker(root), seen: seenLog(root) });
  const server = new McpServer({ name: 'csyk', version });

  const answer = async (run: (ws: Workspace) => Promise<ToolResult>) => {
    session.nextCall();
    try {
      const { text } = await run(workspace);
      session.spend(estimateTokens(text));
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `csyk: ${message}` }], isError: true };
    }
  };

  for (const name of Object.keys(listedTools) as (keyof typeof listedTools)[]) {
    const { description, input } = listedSchema(name);
    // Loose: arguments a tool reads without listing them (read's offset and limit) reach it.
    server.registerTool(name, { description, inputSchema: z.object(input).loose() }, (args: unknown) =>
      answer((ws) => runTool(ws, name, args, session)),
    );
  }

  return {
    server,
    close: async () => {
      await server.close();
      await workspace.close();
    },
  };
}
