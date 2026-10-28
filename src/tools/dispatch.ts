import { z } from 'zod';
import { symbolKinds, type SymbolKind } from '../index/symbols.ts';
import type { Session } from '../token/session.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { def, find, grep, outline, read, refs, type ToolResult } from './tools.ts';

const budget = z.number().int().min(100).max(20000).optional().describe('Token budget, default 2000');
const target = z.string().describe('Symbol id (file#Name) or name');

/** Each tool's one-line description and arguments, as the MCP server lists them. */
export const toolSchemas = {
  find: {
    description: 'Find symbols (functions, classes, components, types…) by name or partial name.',
    input: {
      query: z.string().describe('Name or part of a name'),
      kind: z.enum(symbolKinds as [SymbolKind, ...SymbolKind[]]).optional(),
      path: z.string().optional().describe('Only files under this path'),
      limit: z.number().int().min(1).max(50).optional(),
      budget,
    },
  },
  outline: {
    description: "List a file's symbols with line ranges, or each file's symbols under a folder.",
    input: { path: z.string().describe('File or folder, repo-relative'), budget },
  },
  read: {
    description: "Read one symbol's exact source (or only its signature) by id or name.",
    input: {
      target,
      mode: z.enum(['body', 'signature']).optional(),
      context: z.number().int().min(0).max(50).optional().describe('Extra lines around it'),
      budget,
    },
  },
  refs: {
    description: 'Find every reference to a symbol, resolved by the compiler, grouped by file.',
    input: {
      target,
      limit: z.number().int().min(1).max(1000).optional(),
      code: z.boolean().optional().describe("Add each line's text"),
      budget,
    },
  },
  grep: {
    description: 'Search text or a regex; each hit names the symbol that contains it.',
    input: {
      pattern: z.string(),
      regex: z.boolean().optional(),
      path: z.string().optional().describe('Only under this path'),
      limit: z.number().int().min(1).max(200).optional(),
      budget,
    },
  },
  def: {
    description: 'Find where a name, or the name at file:line:column, is declared.',
    input: {
      target: z.string().optional().describe('Symbol name or id'),
      file: z.string().optional(),
      line: z.number().int().min(1).optional(),
      column: z.number().int().min(1).optional(),
    },
  },
} as const;

export type ToolName = keyof typeof toolSchemas;
export const toolNames = Object.keys(toolSchemas) as ToolName[];

// Drops arguments the caller left out, so tools see their own defaults.
const given = <T extends object>(args: T) =>
  Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) as T;

/** Runs tool [name] with [args], checked against its schema. */
export async function runTool(
  ws: Workspace,
  name: ToolName,
  args: unknown,
  session: Session,
): Promise<ToolResult> {
  switch (name) {
    case 'find': {
      const { query, ...options } = z.object(toolSchemas.find.input).parse(args);
      return find(ws, query, given(options), session);
    }
    case 'outline': {
      const { path, ...options } = z.object(toolSchemas.outline.input).parse(args);
      return outline(ws, path, given(options));
    }
    case 'read': {
      const { target, ...options } = z.object(toolSchemas.read.input).parse(args);
      return read(ws, target, given(options), session);
    }
    case 'refs': {
      const { target, ...options } = z.object(toolSchemas.refs.input).parse(args);
      return refs(ws, target, given(options));
    }
    case 'grep': {
      const { pattern, ...options } = z.object(toolSchemas.grep.input).parse(args);
      return grep(ws, pattern, given(options));
    }
    case 'def': {
      const { target, file, line, column } = z.object(toolSchemas.def.input).parse(args);
      if (file && line && column) return def(ws, { file, line, column });
      if (target) return def(ws, target);
      throw new Error('pass a target, or a file with line and column');
    }
  }
}

export const batchSchema = {
  description: 'Run up to 8 of the other tools in one call; answers come back in order.',
  input: {
    calls: z
      .array(z.object({ tool: z.enum(toolNames as [ToolName, ...ToolName[]]), args: z.record(z.string(), z.unknown()) }))
      .min(1)
      .max(8),
  },
};

/** `batch`: several tool calls in one round trip, each answer under its own heading. */
export async function batch(
  ws: Workspace,
  calls: { tool: ToolName; args: Record<string, unknown> }[],
  session: Session,
): Promise<ToolResult> {
  const parts: string[] = [];
  const locations: ToolResult['locations'] = [];
  for (const [i, call] of calls.entries()) {
    try {
      const result = await runTool(ws, call.tool, call.args, session);
      parts.push(`## ${i + 1}. ${call.tool}\n${result.text}`);
      locations.push(...result.locations);
    } catch (error) {
      parts.push(`## ${i + 1}. ${call.tool}\ncsyk: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { text: parts.join('\n'), locations };
}
