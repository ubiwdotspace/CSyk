import { realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import { sourceExtensions } from '../index/parse.ts';
import { symbolKinds, type SymbolKind } from '../index/symbols.ts';
import { defaultBudget } from '../token/budget.ts';
import type { Session } from '../token/session.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { calls, impact } from './calls.ts';
import { status } from './status.ts';
import { projectFile, readOther, refsToFile } from './other-files.ts';
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
  read: { description: "A symbol's source by id or name, or a file or folder by path (a doc section: file.md#Heading); several, comma-separated.", args: ['target'] },
  refs: { description: 'Every reference to a symbol, resolved by the compiler; for a file path (an image, a doc), where it is named.', args: ['target'] },
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

// One target of `read`: a path reads as the symbols of that file or folder, a
// file CSyk does not index (a config, data, an image) as its text or kind,
// anything else as a symbol.
function readOne(
  ws: Workspace,
  target: string,
  options: { mode?: 'body' | 'signature'; context?: number; budget?: number },
  session: Session,
): Promise<ToolResult> {
  const path = target.replace(/^\.\//, '').replace(/\/$/, '');
  const isPath = !target.includes('#') && (ws.index.has(path) || ws.index.files.some((f) => f.startsWith(`${path}/`)));
  if (isPath) return readPath(ws, path, options.budget);
  const other = target.includes('#') ? undefined : projectFile(ws, path);
  if (other) return readOther(ws, other, options.budget);
  return read(ws, target, options, session);
}

/**
 * Absolute paths inside the workspace, as the agent's own tools want them,
 * read as relative: `grep` given the workspace's absolute path searched a
 * path that does not exist and answered "no match".
 */
function relativeArgs(ws: Workspace, args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const roots = new Set([ws.root]);
  try {
    roots.add(realpathSync(ws.root));
  } catch {
    // The root as given is enough.
  }
  for (const root of [...roots]) roots.add(root.replaceAll('\\', '/'));
  const strip = (value: string) => {
    let out = value;
    for (const root of roots) {
      const r = root.replace(/[\\/]$/, '');
      if (out === r) return '.';
      out = out.split(`${r}/`).join('').split(`${r}\\`).join('');
    }
    return out;
  };
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, typeof value === 'string' && pathArgs.has(key) ? strip(value) : value]),
  );
}

const pathArgs = new Set(['path', 'file', 'target']);

/**
 * `read`'s targets, comma-separated. Agents also write a file's symbols the
 * way answers head them, `file · A, B` (or `file · lines 2-4`): A and B in
 * that file.
 */
export function readTargets(target: string): string[] {
  const scoped = /^(\S+?\.\w+) · (.+)$/.exec(target.trim());
  if (!scoped?.[1] || !scoped[2]) return target.split(/\s*,\s*/).filter(Boolean);
  const file = scoped[1];
  return scoped[2]
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((name) => {
      const lines = /^lines (\d+-\d+)$/.exec(name);
      return lines ? `${file}:${lines[1]}` : `${file}#${name}`;
    });
}

/**
 * A file read with `offset` and `limit`, as the agent's own Read takes them:
 * those lines, `file:20-144`. Left out of the schema, they were dropped and
 * the agent got the file's outline again, then read it with its own tool.
 */
function withLines(target: string, args: unknown): string {
  const { offset, limit } = args as { offset?: unknown; limit?: unknown };
  if ((offset === undefined && limit === undefined) || /[#:,]/.test(target)) return target;
  const start = Math.max(1, Number(offset) || 1);
  const count = Number(limit) > 0 ? Number(limit) : 200;
  return `${target}:${start}-${start + count - 1}`;
}

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
  args = relativeArgs(ws, args);
  // Until the index is full, grep and a read of a file index only the files they touch.
  const target = (args as { target?: unknown }).target;
  const files = typeof target === 'string' ? target.split(/\s*,\s*/).map((t) => t.replace(/(#|:(?=[\w$]+(-\d+)?$)).*$/, '').replace(/\/$/, '')) : [];
  if (name === 'read' && files.length > 0 && files.every((f) => sourceExtensions.has(extname(f)))) await ws.indexNow(files);
  else if (name !== 'grep') await ws.ready;
  await ws.fresh();
  // A name no indexed file declares may be in generated code that git ignores.
  const asked = name === 'find' ? (args as { query?: unknown }).query : target;
  if (name !== 'grep' && typeof asked === 'string' && /^[A-Za-z_$][\w$]*$/.test(asked)) await ws.indexIgnored(asked);
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
      // Several targets, comma-separated, come back in one answer: reading a
      // class's methods one call at a time cost a turn each, and every turn
      // re-reads the whole context. They share twice one answer's budget.
      const targets = readTargets(withLines(target, args));
      if (targets.length < 2) return readOne(ws, targets[0] ?? target, given(options), session);
      const each = Math.max(500, Math.floor((options.budget ?? 2 * defaultBudget) / targets.length));
      const parts = [];
      for (const one of targets) parts.push(await readOne(ws, one, { ...given(options), budget: each }, session));
      return { text: parts.map((p) => p.text).join('\n\n'), locations: parts.flatMap((p) => p.locations) };
    }
    case 'refs': {
      const { target, ...options } = z.object(toolSchemas.refs.input).parse(args);
      // A file (an image, a doc, a config): the places that name it.
      const file = target.includes('#') ? undefined : projectFile(ws, target);
      if (file) return refsToFile(ws, file, options.budget);
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


