import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';
import { isTestFile, type CodeSymbol, type SymbolKind } from './symbols.ts';

const require = createRequire(import.meta.url);

// One grammar per dialect; TSX also covers JSX inside .tsx files.
const grammars = {
  typescript: () => require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
  tsx: () => require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
  javascript: () => require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'),
};
type Dialect = keyof typeof grammars;

const dialects: Record<string, Dialect> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

/** File extensions the TS/JS parser reads. */
export const tsExtensions: ReadonlySet<string> = new Set(Object.keys(dialects));

let ready: Promise<void> | undefined;
const parsers = new Map<Dialect, Parser>();

async function parserFor(dialect: Dialect): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  let parser = parsers.get(dialect);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(await Language.load(grammars[dialect]()));
    parsers.set(dialect, parser);
  }
  return parser;
}

/** The syntax tree of [text]; the caller deletes it when done. */
export async function parseTs(file: string, text: string): Promise<Tree | undefined> {
  const dialect = dialects[extname(file)];
  if (!dialect) return undefined;
  return (await parserFor(dialect)).parse(text) ?? undefined;
}

/**
 * The declarations of a TS/JS file: top-level functions, classes,
 * interfaces, types, enums and bindings, and the methods of its classes.
 * Function locals are left out; nobody searches for them by name.
 */
export async function extractTsSymbols(file: string, text: string): Promise<CodeSymbol[]> {
  const tree = await parseTs(file, text);
  if (!tree) return [];
  try {
    const symbols: CodeSymbol[] = [];
    const jsx = /\.[jt]sx$/.test(file);
    const test = isTestFile(file);
    const add = (
      name: Node,
      kind: SymbolKind,
      node: Node,
      exported: boolean,
      parent?: CodeSymbol,
    ) => {
      const qualified = parent ? `${parent.name}.${name.text}` : name.text;
      let id = `${file}#${qualified}`;
      for (let n = 2; symbols.some((s) => s.id === id); n++) id = `${file}#${qualified}~${n}`;
      const symbol: CodeSymbol = {
        id,
        name: name.text,
        kind,
        file,
        line: name.startPosition.row + 1,
        range: [node.startPosition.row + 1, node.endPosition.row + 1],
        signature: signatureOf(node),
        ...(parent ? { parent: parent.id } : {}),
        exported,
        isTest: test,
      };
      symbols.push(symbol);
      return symbol;
    };

    const declare = (node: Node, exported: boolean): void => {
      const name = node.childForFieldName('name');
      switch (node.type) {
        case 'export_statement': {
          // `export default memo(function Name() {…})` names its function inside the call.
          const value = node.childForFieldName('value');
          const named = value ? namedFunctionIn(value) : undefined;
          const namedName = named?.childForFieldName('name');
          if (named && namedName) {
            const kind = named.type.includes('class') ? 'class' : functionKind(namedName.text, jsx);
            add(namedName, kind, named, true);
            return;
          }
          for (const child of node.namedChildren) if (child) declare(child, true);
          return;
        }
        case 'ambient_declaration':
          for (const child of node.namedChildren) if (child) declare(child, exported);
          return;
        case 'function_declaration':
        case 'generator_function_declaration':
        case 'function_signature':
          if (name) add(name, functionKind(name.text, jsx), node, exported);
          return;
        case 'class_declaration':
        case 'abstract_class_declaration':
        case 'class': {
          if (!name) return;
          const owner = add(name, 'class', node, exported);
          for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
            const memberName = member?.childForFieldName('name');
            const isMethod =
              member?.type === 'method_definition' ||
              member?.type === 'method_signature' ||
              member?.type === 'abstract_method_signature';
            if (member && memberName && isMethod) add(memberName, 'method', member, exported, owner);
          }
          return;
        }
        case 'interface_declaration':
          if (name) add(name, 'interface', node, exported);
          return;
        case 'type_alias_declaration':
          if (name) add(name, 'type', node, exported);
          return;
        case 'enum_declaration':
          if (name) add(name, 'enum', node, exported);
          return;
        case 'lexical_declaration':
        case 'variable_declaration':
          for (const declarator of node.namedChildren) {
            const binding = declarator?.childForFieldName('name');
            if (declarator?.type !== 'variable_declarator' || binding?.type !== 'identifier') continue;
            add(binding, bindingKind(binding.text, declarator.childForFieldName('value'), jsx), declarator, exported);
          }
          return;
      }
    };

    for (const node of tree.rootNode.namedChildren) if (node) declare(node, false);
    return symbols;
  } finally {
    tree.delete();
  }
}

const functionValues = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

function functionKind(name: string, jsx: boolean): SymbolKind {
  if (/^use[A-Z0-9]/.test(name)) return 'hook';
  if (jsx && /^[A-Z]/.test(name)) return 'component';
  return 'function';
}

// A binding is a function when it holds one; in a JSX file a PascalCase
// binding made by a call (memo, forwardRef, styled) is a component.
function bindingKind(name: string, value: Node | null, jsx: boolean): SymbolKind {
  if (value && functionValues.has(value.type)) return functionKind(name, jsx);
  if (value?.type === 'call_expression' && jsx && /^[A-Z]/.test(name)) return 'component';
  return 'const';
}

// A named function or class expression, as is or inside wrapping calls
// such as memo, forwardRef or observer.
function namedFunctionIn(node: Node, depth = 0): Node | undefined {
  const isNamed =
    (functionValues.has(node.type) || node.type === 'class') && node.childForFieldName('name') !== null;
  if (isNamed) return node;
  if (node.type !== 'call_expression' || depth > 2) return undefined;
  for (const arg of node.childForFieldName('arguments')?.namedChildren ?? []) {
    const found = arg ? namedFunctionIn(arg, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

function signatureOf(node: Node): string {
  const first = node.text.split('\n', 1)[0]?.trim() ?? '';
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

// Node types whose text is data, not code: a name written there refers to
// nothing.
const inertTypes = new Set([
  'comment',
  'string',
  'string_fragment',
  'template_string',
  'jsx_text',
  'regex',
]);

/**
 * Whether [column] of a source [line] sits in a JSDoc `{@link Name}`, which
 * the compiler resolves like code.
 */
export function inJsDocLink(line: string, column: number): boolean {
  return /\{@link(?:code|plain)?\s+[\w$.]*$/.test(line.slice(0, column));
}

/** Whether the 0-based [line] and [column] of [tree] fall in code, not a comment or string. */
export function isCodeAt(tree: Tree, line: number, column: number): boolean {
  let node: Node | null = tree.rootNode.descendantForPosition({ row: line, column });
  while (node) {
    // A template's `${…}` is code again.
    if (node.type === 'template_substitution') return true;
    if (inertTypes.has(node.type)) return false;
    node = node.parent;
  }
  return true;
}
