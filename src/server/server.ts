import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { symbolKinds } from '../index/symbols.ts';
import { def, find, grep, outline, read, refs, type ToolResult } from '../tools/tools.ts';
import { Workspace } from '../workspace/workspace.ts';

/**
 * The CSyk MCP server for the workspace at [root]. The index is built as
 * the server starts; the first tool call waits for it.
 */
export function createServer(root: string): { server: McpServer; close: () => Promise<void> } {
  const workspace = Workspace.open(root);
  // A failed build surfaces on the first tool call, not as an unhandled rejection.
  workspace.catch(() => {});
  const server = new McpServer({ name: 'csyk', version: '0.0.0' });

  const answer = (run: (ws: Workspace) => ToolResult | Promise<ToolResult>) => async () => {
    try {
      const { text } = await run(await workspace);
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `csyk: ${message}` }], isError: true };
    }
  };

  server.registerTool(
    'find',
    {
      description: 'Find symbols (functions, classes, components, types…) by name or partial name.',
      inputSchema: {
        query: z.string().describe('Name or part of a name'),
        kind: z.enum(symbolKinds as [string, ...string[]]).optional(),
        path: z.string().optional().describe('Only files under this path'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    (args) =>
      answer((ws) =>
        find(ws, args.query, {
          ...(args.kind ? { kind: args.kind as (typeof symbolKinds)[number] } : {}),
          ...(args.path ? { path: args.path } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      )(),
  );

  server.registerTool(
    'outline',
    {
      description: "List a file's symbols with line ranges, or each file's symbols under a folder.",
      inputSchema: { path: z.string().describe('File or folder, repo-relative') },
    },
    (args) => answer((ws) => outline(ws, args.path))(),
  );

  server.registerTool(
    'read',
    {
      description: "Read one symbol's exact source (or only its signature) by id or name.",
      inputSchema: {
        target: z.string().describe('Symbol id (file#Name) or name'),
        mode: z.enum(['body', 'signature']).optional(),
        context: z.number().int().min(0).max(50).optional().describe('Extra lines around it'),
      },
    },
    (args) => answer((ws) => read(ws, args.target, args.mode, args.context))(),
  );

  server.registerTool(
    'refs',
    {
      description: 'Find every reference to a symbol, resolved by the compiler, grouped by file.',
      inputSchema: {
        target: z.string().describe('Symbol id (file#Name) or name'),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    (args) => answer((ws) => refs(ws, args.target, args.limit))(),
  );

  server.registerTool(
    'grep',
    {
      description: 'Search text or a regex; each hit names the symbol that contains it.',
      inputSchema: {
        pattern: z.string(),
        regex: z.boolean().optional(),
        path: z.string().optional().describe('Only under this path'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (args) =>
      answer((ws) =>
        grep(ws, args.pattern, {
          ...(args.regex ? { regex: true } : {}),
          ...(args.path ? { path: args.path } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      )(),
  );

  server.registerTool(
    'def',
    {
      description: 'Find where a name, or the name at file:line:column, is declared.',
      inputSchema: {
        target: z.string().optional().describe('Symbol name or id'),
        file: z.string().optional(),
        line: z.number().int().min(1).optional(),
        column: z.number().int().min(1).optional(),
      },
    },
    (args) =>
      answer((ws) => {
        if (args.file && args.line && args.column) {
          return def(ws, { file: args.file, line: args.line, column: args.column });
        }
        if (args.target) return def(ws, args.target);
        throw new Error('pass a target, or a file with line and column');
      })(),
  );

  return {
    server,
    close: async () => {
      await server.close();
      await (await workspace.catch(() => undefined))?.close();
    },
  };
}
