import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resetMarker, Session } from '../token/session.ts';
import { batch, batchSchema, runTool, toolNames, toolSchemas } from '../tools/dispatch.ts';
import type { ToolResult } from '../tools/tools.ts';
import { Workspace } from '../workspace/workspace.ts';

/**
 * The CSyk MCP server for the workspace at [root]. The index is built as
 * the server starts; the first tool call waits for it. One server is one
 * agent session: it remembers which bodies it showed and which hints it
 * gave until a hook touches the reset marker.
 */
export function createServer(root: string): { server: McpServer; close: () => Promise<void> } {
  const workspace = Workspace.open(root, { watch: true, persist: true });
  // A failed build surfaces on the first tool call, not as an unhandled rejection.
  workspace.catch(() => {});
  const session = new Session({ marker: resetMarker(root) });
  const server = new McpServer({ name: 'csyk', version: '0.0.0' });

  const answer = async (run: (ws: Workspace) => Promise<ToolResult>) => {
    session.nextCall();
    try {
      const { text } = await run(await workspace);
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `csyk: ${message}` }], isError: true };
    }
  };

  for (const name of toolNames) {
    const { description, input } = toolSchemas[name];
    server.registerTool(name, { description, inputSchema: input }, (args: unknown) =>
      answer((ws) => runTool(ws, name, args, session)),
    );
  }
  server.registerTool('batch', { description: batchSchema.description, inputSchema: batchSchema.input }, (args) =>
    answer((ws) => batch(ws, args.calls, session)),
  );

  return {
    server,
    close: async () => {
      await server.close();
      await (await workspace.catch(() => undefined))?.close();
    },
  };
}
