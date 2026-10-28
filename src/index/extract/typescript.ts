import type { Node } from 'web-tree-sitter';
import type { SymbolSink } from '../sink.ts';
import type { SymbolKind } from '../symbols.ts';

const functionValues = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const httpDecorator = /^@(Get|Post|Put|Patch|Delete|Options|Head|All|Sse)\b/;

/**
 * TS/JS declarations: top-level functions, classes, interfaces, types,
 * enums and bindings, and class methods. React components and hooks, and
 * NestJS controllers' routes and injectable providers, get their own kinds.
 * Function locals are left out; nobody searches for them by name.
 */
export function extractTypeScript(root: Node, sink: SymbolSink): void {
  const jsx = /\.[jt]sx$/.test(sink.file);

  const declare = (node: Node, exported: boolean, outer: string[] = []): void => {
    const name = node.childForFieldName('name');
    switch (node.type) {
      case 'export_statement': {
        // Decorators written before `export class` belong to the export.
        const decorators = node.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c?.text ?? '');
        // `export default memo(function Name() {…})` names its function inside the call.
        const value = node.childForFieldName('value');
        const named = value ? namedFunctionIn(value) : undefined;
        const namedName = named?.childForFieldName('name');
        if (named && namedName) {
          sink.add(namedName, named.type.includes('class') ? 'class' : functionKind(namedName.text, jsx), named, true);
          return;
        }
        for (const child of node.namedChildren) if (child) declare(child, true, decorators);
        return;
      }
      case 'ambient_declaration':
        for (const child of node.namedChildren) if (child) declare(child, exported);
        return;
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature':
        if (name) sink.add(name, functionKind(name.text, jsx), node, exported);
        return;
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class':
        if (name) declareClass(node, name, exported, outer);
        return;
      case 'interface_declaration':
        if (name) sink.add(name, 'interface', node, exported);
        return;
      case 'type_alias_declaration':
        if (name) sink.add(name, 'type', node, exported);
        return;
      case 'enum_declaration':
        if (name) sink.add(name, 'enum', node, exported);
        return;
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const declarator of node.namedChildren) {
          const binding = declarator?.childForFieldName('name');
          if (declarator?.type !== 'variable_declarator' || binding?.type !== 'identifier') continue;
          sink.add(binding, bindingKind(binding.text, declarator.childForFieldName('value'), jsx), declarator, exported);
        }
        return;
    }
  };

  const declareClass = (node: Node, name: Node, exported: boolean, outer: string[]) => {
    const decorators = [...outer, ...node.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c?.text ?? '')];
    const owner = sink.add(name, decorators.some((d) => d.startsWith('@Injectable')) ? 'provider' : 'class', node, exported);
    const controller = decorators.some((d) => d.startsWith('@Controller'));
    let pending: string[] = [];
    for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
      if (!member) continue;
      if (member.type === 'decorator') {
        pending.push(member.text);
        continue;
      }
      const memberName = member.childForFieldName('name');
      const isMethod = ['method_definition', 'method_signature', 'abstract_method_signature'].includes(member.type);
      if (memberName && isMethod) {
        const own = [...pending, ...member.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c?.text ?? '')];
        const route = controller && own.some((d) => httpDecorator.test(d));
        sink.add(memberName, route ? 'route' : 'method', member, exported, owner);
      }
      pending = [];
    }
  };

  for (const node of root.namedChildren) if (node) declare(node, false);
}

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
  const isNamed = (functionValues.has(node.type) || node.type === 'class') && node.childForFieldName('name') !== null;
  if (isNamed) return node;
  if (node.type !== 'call_expression' || depth > 2) return undefined;
  for (const arg of node.childForFieldName('arguments')?.namedChildren ?? []) {
    const found = arg ? namedFunctionIn(arg, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}
