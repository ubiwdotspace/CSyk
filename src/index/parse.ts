import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';
import { extractDart } from './extract/dart.ts';
import { extractGo } from './extract/go.ts';
import { extractPython } from './extract/python.ts';
import { extractTypeScript } from './extract/typescript.ts';
import { SymbolSink } from './sink.ts';
import type { CodeSymbol, Lang } from './symbols.ts';

const require = createRequire(import.meta.url);
const grammarDir = join(dirname(fileURLToPath(import.meta.url)), '../../grammars');

type Dialect = { lang: Lang; grammar: () => string; extract: (root: Node, sink: SymbolSink) => void };

const typescript: Dialect = {
  lang: 'ts',
  grammar: () => require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
  extract: extractTypeScript,
};
const tsx: Dialect = { ...typescript, grammar: () => require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm') };
const javascript: Dialect = {
  lang: 'js',
  grammar: () => require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'),
  extract: extractTypeScript,
};
const python: Dialect = {
  lang: 'py',
  grammar: () => require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
  extract: extractPython,
};
const go: Dialect = { lang: 'go', grammar: () => require.resolve('tree-sitter-go/tree-sitter-go.wasm'), extract: extractGo };
// Built from tree-sitter-dart (MIT, UserNobody14); see grammars/README.md.
const dart: Dialect = { lang: 'dart', grammar: () => join(grammarDir, 'tree-sitter-dart.wasm'), extract: extractDart };

const dialects: Record<string, Dialect> = {
  '.ts': typescript,
  '.mts': typescript,
  '.cts': typescript,
  '.tsx': tsx,
  '.js': javascript,
  '.jsx': javascript,
  '.mjs': javascript,
  '.cjs': javascript,
  '.py': python,
  '.go': go,
  '.dart': dart,
};

/** File extensions CSyk indexes. */
export const sourceExtensions: ReadonlySet<string> = new Set(Object.keys(dialects));

/** The language of [file], when CSyk reads it. */
export function langOf(file: string): Lang | undefined {
  return dialects[extname(file)]?.lang;
}

let ready: Promise<void> | undefined;
const parsers = new Map<string, Parser>();

async function parserFor(dialect: Dialect): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  const path = dialect.grammar();
  let parser = parsers.get(path);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(await Language.load(path));
    parsers.set(path, parser);
  }
  return parser;
}

/** The syntax tree of [text]; the caller deletes it when done. */
export async function parseFile(file: string, text: string): Promise<Tree | undefined> {
  const dialect = dialects[extname(file)];
  if (!dialect) return undefined;
  return (await parserFor(dialect)).parse(text) ?? undefined;
}

/** The declarations of [file]; see each language's extractor for which. */
export async function extractSymbols(file: string, text: string): Promise<CodeSymbol[]> {
  const dialect = dialects[extname(file)];
  const tree = dialect ? await parseFile(file, text) : undefined;
  if (!dialect || !tree) return [];
  try {
    const sink = new SymbolSink(file, dialect.lang);
    dialect.extract(tree.rootNode, sink);
    return sink.symbols;
  } finally {
    tree.delete();
  }
}

// Node types, across the grammars, whose text is data rather than code: a
// name written there refers to nothing.
const inertTypes = new Set([
  'comment',
  'documentation_comment',
  'string',
  'string_fragment',
  'string_content',
  'string_literal',
  'template_string',
  'interpreted_string_literal',
  'raw_string_literal',
  'rune_literal',
  'jsx_text',
  'regex',
]);

// Nodes that make code again inside a string: `${…}` and f-string braces.
const codeInStrings = new Set(['template_substitution', 'interpolation', 'template_string_substitution']);

/** Whether the 0-based [line] and [column] of [tree] fall in code, not a comment or string. */
export function isCodeAt(tree: Tree, line: number, column: number): boolean {
  let node: Node | null = tree.rootNode.descendantForPosition({ row: line, column });
  while (node) {
    if (codeInStrings.has(node.type)) return true;
    if (inertTypes.has(node.type)) return false;
    node = node.parent;
  }
  return true;
}

/**
 * Whether [column] of a source [line] sits in a documentation link the
 * compiler resolves like code: a JSDoc `{@link Name}`, or a Dart or Go doc
 * comment's `[Name]`.
 */
export function inDocLink(line: string, column: number): boolean {
  const before = line.slice(0, column);
  if (/\{@link(?:code|plain)?\s+[\w$.]*$/.test(before)) return true;
  return /^\s*\/\/\/?.*\[[\w$.]*$/.test(before);
}

// Node types that bind a name by importing it, across the grammars.
const importTypes = new Set(['import_statement', 'import_from_statement', 'import_declaration', 'import_or_export']);

/** Whether the 0-based [line] and [column] of [tree] sit in an import. */
export function isImportAt(tree: Tree, line: number, column: number): boolean {
  for (let node: Node | null = tree.rootNode.descendantForPosition({ row: line, column }); node; node = node.parent) {
    if (importTypes.has(node.type)) return true;
  }
  return false;
}
