import { extname } from 'node:path';
import { z } from 'zod';
import { sourceExtensions } from '../index/parse.ts';
import { symbolKinds, type SymbolKind } from '../index/symbols.ts';
import type { Session } from '../token/session.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { calls, impact } from './calls.ts';
import { status } from './status.ts';
import { def, find, grep, outline, read, readPath, refs, type ToolResult } from './tools.ts';

// Bounds are enforced in runTool rather than listed, to keep the tool list short.
const budget = z.number().optional();
const target = z.string().describe('Symbol id or name');


/** Each tool's one-line description and arguments, as the MCP server lists them. */
export const toolSchemas = {
  find: {
    description: 'Find symbols by name or part of one.',
    input: {
      query: z.string(),
      kind: z.enum(symbolKinds as [SymbolKind, ...SymbolKind[]]).optional(),
      path: z.string().optional().describe('Under this path'),
      limit: z.number().optional(),
      budget,
    },
  },
  outline: {
    description: "A file's symbols with line ranges, or each file's under a folder.",
    input: { path: z.string().describe('File or folder, repo-relative'), budget },
  },
  read: {
    description: "One symbol's exact source, or only its signature.",
    input: {
      target: z.string().describe('Symbol id or name, or a file or folder path'),
      mode: z.enum(['body', 'signature']).optional(),
      context: z.number().optional().describe('Extra lines around it'),
      budget,
    },
  },
  refs: {
    description: 'Every reference to a symbol, resolved by the compiler.',
    input: {
      target,
      limit: z.number().optional(),
      code: z.boolean().optional().describe("Add each line's text"),
      budget,
    },
  },
  calls: {
    description: 'Who calls a symbol (in), or what it calls (out).',
    input: {
      target,
      direction: z.enum(['in', 'out']).optional().describe('Default in'),
      depth: z.number().optional().describe('1-3'),
      limit: z.number().optional(),
      budget,
    },
  },
  impact: {
    description: 'Changed symbols since a revision, their callers, tests.',
    input: {
      since: z.string().optional().describe('Git revision, default HEAD'),
      depth: z.number().optional().describe('Caller levels, 1-3, default 2'),
      budget,
    },
  },
  grep: {
    description: 'Regex search; each hit names its enclosing symbol.',
    input: {
      pattern: z.string(),
      literal: z.boolean().optional().describe('Match as written'),
      path: z.string().optional().describe('Under this path'),
      glob: z.string().optional().describe('File glob, like *.ts'),
      limit: z.number().optional(),
      budget,
    },
  },
  status: {
    description: 'Index and language server status.',
    input: {},
  },
  def: {
    description: 'Where a name, or the name at file:line:column, is declared.',
    input: {
      target: z.string().optional().describe('Symbol name or id'),
      file: z.string().optional(),
      line: z.number().optional(),
      column: z.number().optional(),
    },
  },
} as const;

// Each numeric argument's range; values are rounded and brought into it.
const bounds: Record<string, [number, number]> = {
  budget: [100, 20000],
  limit: [1, 1000],
  depth: [1, 3],
  context: [0, 50],
  line: [1, 1e9],
  column: [1, 1e9],
};

/**
 * The tools an agent sees, with only the arguments it needs: every tool and
 * argument listed costs tokens on every turn of every session, more than a
 * search saves when they go unused, and agents already call tools in
 * parallel. The others (outline, def, status, and arguments such as budget
 * or limit) stay callable for the eval and tests.
 */
export const listedTools = {
  find: { description: 'Find symbols by name or part of one.', args: ['query', 'kind', 'path'] },
  grep: { description: 'Regex search; each hit names its enclosing symbol.', args: ['pattern', 'literal', 'path', 'glob'] },
  read: { description: "A symbol's source by id or name, or the symbols of a file or folder by path.", args: ['target'] },
  refs: { description: 'Every reference to a symbol, resolved by the compiler.', args: ['target'] },
  calls: { description: 'Who calls a symbol (in), or what it calls (out).', args: ['target', 'direction', 'depth'] },
  impact: { description: 'Changed symbols since a revision, their callers, tests.', args: ['since'] },
} as const;

/** A listed tool's description and its listed arguments' schemas. */
export function listedSchema(name: keyof typeof listedTools): { description: string; input: Record<string, z.ZodType> } {
  const { description, args } = listedTools[name];
  const full = toolSchemas[name].input as Record<string, z.ZodType>;
  return { description, input: Object.fromEntries(args.map((arg) => [arg, full[arg] as z.ZodType])) };
}

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
  // Until the index is full, grep and a read of a file index only the files they touch.
  const target = (args as { target?: unknown }).target;
  const file = typeof target === 'string' ? target.replace(/(#|:(?=[\w$]+(-\d+)?$)).*$/, '').replace(/\/$/, '') : '';
  if (name === 'read' && sourceExtensions.has(extname(file))) await ws.indexNow([file]);
  else if (name !== 'grep') await ws.ready;
  await ws.fresh();
  const raw = { ...(args as Record<string, unknown>) };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (typeof raw[key] === 'number') raw[key] = Math.min(Math.max(Math.round(raw[key]), min), max);
  }
  args = raw;
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
      // A path reads as the symbols of that file or folder.
      const path = target.replace(/^\.\//, '').replace(/\/$/, '');
      const isPath = !target.includes('#') && (ws.index.has(path) || ws.index.files.some((f) => f.startsWith(`${path}/`)));
      if (isPath) return readPath(ws, path, options.budget);
      return read(ws, target, given(options), session);
    }
    case 'refs': {
      const { target, ...options } = z.object(toolSchemas.refs.input).parse(args);
      return refs(ws, target, given(options));
    }
    case 'calls': {
      const { target, ...options } = z.object(toolSchemas.calls.input).parse(args);
      return calls(ws, target, given(options));
    }
    case 'impact':
      return impact(ws, given(z.object(toolSchemas.impact.input).parse(args)));
    case 'status':
      return status(ws);
    case 'grep': {
      const { pattern, ...options } = z.object(toolSchemas.grep.input).parse(args);
      return grep(ws, pattern, given(options), session);
    }
    case 'def': {
      const { target, file, line, column } = z.object(toolSchemas.def.input).parse(args);
      if (file && line && column) return def(ws, { file, line, column });
      if (target) return def(ws, target);
      throw new Error('pass a target, or a file with line and column');
    }
  }
}


