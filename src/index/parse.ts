import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';
import { extractDart } from './extract/dart.ts';
import { extractGo } from './extract/go.ts';
import { leftOutOfBuild } from './go-build.ts';
import { extractMarkdown } from './extract/markdown.ts';
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

/** File extensions of code CSyk parses. */
export const codeExtensions: ReadonlySet<string> = new Set(Object.keys(dialects));

/** File extensions CSyk indexes: code, and Markdown for its sections. */
export const sourceExtensions: ReadonlySet<string> = new Set([...codeExtensions, '.md']);

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
  const tree = (await parserFor(dialect)).parse(text) ?? undefined;
  // JavaScript with type annotations (Flow's, or TypeScript's, which Babel
  // takes: `_uri: string;`, `export type`): the JavaScript grammar fails on
  // them and its declarations go missing; the TSX grammar reads them.
  if (dialect !== javascript || !tree?.rootNode.hasError) return tree;
  const typed = (await parserFor(tsx)).parse(text);
  const errors = (t: Tree) => t.rootNode.descendantsOfType('ERROR').length;
  if (!typed || errors(typed) >= errors(tree)) {
    typed?.delete();
    return tree;
  }
  tree.delete();
  return typed;
}

/** The declarations of [file]; see each language's extractor for which. */
export async function extractSymbols(file: string, text: string): Promise<CodeSymbol[]> {
  if (extname(file) === '.md') return extractMarkdown(file, text);
  const dialect = dialects[extname(file)];
  const tree = dialect ? await parseFile(file, text) : undefined;
  if (!dialect || !tree) return [];
  try {
    const sink = new SymbolSink(file, dialect.lang, dialect.lang === 'go' && leftOutOfBuild(file, text));
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

/**
 * Whether the 0-based [line] and [column] of [tree] fall in code, not a
 * comment or string. A string that keys an element access, `obj['name']`,
 * names a member as code would.
 */
export function isCodeAt(tree: Tree, line: number, column: number): boolean {
  let node: Node | null = tree.rootNode.descendantForPosition({ row: line, column });
  while (node) {
    if (codeInStrings.has(node.type)) return true;
    if (inertTypes.has(node.type)) {
      const string = node.type === 'string' ? node : node.parent?.type === 'string' ? node.parent : null;
      return string?.parent?.type === 'subscript_expression';
    }
    node = node.parent;
  }
  return true;
}

/**
 * Whether [column] of a source [line] sits in a documentation link the
 * compiler resolves like code: a JSDoc `{@link Name}`, a JSDoc tag's type
 * (`@param {?Styles} style`, `@returns {Name}`) or the class an
 * `@augments` names, or a Dart or Go doc comment's `[Name]`.
 */
export function inDocLink(line: string, column: number): boolean {
  const before = line.slice(0, column);
  if (/\{@link(?:code|plain)?\s+[\w$.]*$/.test(before)) return true;
  const jsdoc = /^\s*(?:\/\*\*|\*)/.test(before);
  if (jsdoc && /@(?:param|arg|argument|returns?|type|typedef|throws|exception|property|prop|this|enum|satisfies)\b[^{}]*\{[^}]*$/.test(before)) return true;
  if (jsdoc && /@(?:augments|extends|implements|mixes|see)\s+\{?[\w$.]*$/.test(before)) return true;
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

// Node types of a function, across the grammars: `function_declaration`,
// `arrow_function`, `function_definition`, `lambda`, `func_literal`, …
const functionType = /function|arrow|lambda|method|func_literal|closure/;

/**
 * Whether the name at the 0-based [line] and [column] of [tree] declares a
 * function: `function f`, `def f`, a method, or a variable holding one
 * (`const f = () => …`, `f = lambda: …`, `f := func() {…}`). A parameter,
 * a destructured name or a variable holding anything else does not.
 */
export function declaresFunctionAt(tree: Tree, line: number, column: number): boolean {
  const node = tree.rootNode.descendantForPosition({ row: line, column });
  const parent = node?.parent;
  if (!node || !parent) return false;
  if (functionType.test(parent.type) && parent.childForFieldName('name')?.id === node.id) return true;
  // A constructor's name, in Dart's many forms: `C._()`, `factory C.of() = D`.
  for (let at: Node | null = parent, up = 0; at && up < 3 && !at.type.includes('parameter'); at = at.parent, up++) {
    if (at.type.includes('constructor')) return true;
  }
  // Go names its variables in a list: `f, g := …`.
  const declaration = parent.type.endsWith('list') ? parent.parent : parent;
  const value = declaration?.childForFieldName('value') ?? declaration?.childForFieldName('right');
  if (!value || value.id === parent.id) return false;
  return functionType.test(value.type) || (value.type.endsWith('list') && value.namedChildren.some((c) => c !== null && functionType.test(c.type)));
}

// Parents through which a callee's own name is reached: `a.b`, `pkg.F`,
// Dart's `.b` selector.
const memberTypes = new Set(['member_expression', 'attribute', 'selector_expression', 'unconditional_assignable_selector']);

/**
 * Whether the name at the 0-based [line] and [column] of [tree] is called
 * there: `f()`, `a.f()`, `new F()`, `@f`, `<F />`, Dart's `F()`.
 */
export function isCallAt(tree: Tree, line: number, column: number): boolean {
  let node: Node | null = tree.rootNode.descendantForPosition({ row: line, column });
  if (!node?.isNamed) return false;
  // Climb from a property name to the member access it ends.
  while (node.parent && memberTypes.has(node.parent.type) && node.parent.lastNamedChild?.id === node.id) node = node.parent;
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case 'call_expression':
    case 'call':
      return parent.childForFieldName('function')?.id === node.id;
    case 'new_expression':
      // Dart's `new F()` names the type without a field.
      return parent.childForFieldName('constructor')?.id === node.id || node.type === 'type_identifier';
    case 'decorator':
    case 'const_object_expression':
      return true;
    case 'jsx_opening_element':
    case 'jsx_self_closing_element':
      return parent.childForFieldName('name')?.id === node.id;
    case 'selector':
      // Dart: `a.f(…)` is `a`, then the selector `.f`, then one holding the arguments.
      return isDartArguments(parent.nextNamedSibling);
    default:
      return parent.type !== 'selector' && node.type === 'identifier' && isDartArguments(node.nextNamedSibling);
  }
}

/**
 * Whether the name at the 0-based [line] and [column] of [tree] is reached
 * through a member access (`this.f`, `self.f`, `pkg.F`), as a method handed
 * over as a callback is.
 */
export function isMemberAt(tree: Tree, line: number, column: number): boolean {
  const node = tree.rootNode.descendantForPosition({ row: line, column });
  const parent = node?.parent;
  return !!node && !!parent && memberTypes.has(parent.type) && parent.lastNamedChild?.id === node.id;
}

// Where a name stands for a type, not a value that can be called.
const typeContexts = new Set(['type_annotation', 'type_arguments', 'type', 'generic_type', 'type_parameters']);

/**
 * Whether the name at the 0-based [line] and [column] of [tree] is used as
 * a value: called, or handed over (`map(f)`, `wrap(F)`), as the servers'
 * call hierarchies count it. Imports, exports and types are not uses.
 */
export function isValueUseAt(tree: Tree, line: number, column: number): boolean {
  const node = tree.rootNode.descendantForPosition({ row: line, column });
  if (!node) return false;
  if (isCallAt(tree, line, column)) return true;
  if (node.type === 'type_identifier' || node.parent?.type === 'export_statement') return false;
  // A function's own name where it is declared: an object literal's
  // `catch(exception, host) {…}` resolves to the interface it implements.
  if (declaresFunctionAt(tree, line, column)) return false;
  for (let n = node.parent; n; n = n.parent) {
    if (importTypes.has(n.type) || n.type === 'export_specifier' || typeContexts.has(n.type)) return false;
  }
  return true;
}

function isDartArguments(node: Node | null): boolean {
  return node?.type === 'selector' && node.firstNamedChild?.type === 'argument_part';
}

