import type { Node } from 'web-tree-sitter';
import type { SymbolSink } from '../sink.ts';
import type { CodeSymbol, SymbolKind } from '../symbols.ts';

const functionValues = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const fieldTypes = new Set(['public_field_definition', 'field_definition']);
const httpDecorator = /^@(Get|Post|Put|Patch|Delete|Options|Head|All|Sse)\b/;

/**
 * TS/JS declarations: top-level functions, classes, interfaces, types,
 * enums, bindings and namespaces (with what they declare), class methods,
 * and the functions in an object literal (`module.exports = { … }`,
 * `const api = { … }`, `export default { … }`). React components and hooks, and
 * NestJS controllers' routes and injectable providers, get their own kinds.
 * Functions declared inside functions (a factory's helpers, a hook's
 * handlers, a test's) are kept, marked nested, under the function around
 * them; other locals are left out.
 */
export function extractTypeScript(root: Node, sink: SymbolSink): void {
  const jsx = /\.[jt]sx$/.test(sink.file);

  const declare = (node: Node, exported: boolean, outer: string[] = [], parent?: CodeSymbol): void => {
    const name = node.childForFieldName('name');
    switch (node.type) {
      case 'expression_statement':
        for (const child of node.namedChildren) {
          // `namespace A { … }` at the top level is an expression statement.
          if (child?.type === 'internal_module') declare(child, exported, [], parent);
          else if (child?.type === 'assignment_expression') assigned(node, child);
          // `describe('…', () => { const run = … })`: helpers in a callback.
          else if (child) inside(child, parent);
        }
        return;
      case 'internal_module': {
        // `namespace A.B` is named by its last part.
        const named = name?.type === 'nested_identifier' ? name.lastNamedChild : name;
        if (!named) return;
        const owner = sink.add(named, 'namespace', node, exported, parent);
        for (const child of node.childForFieldName('body')?.namedChildren ?? []) if (child) declare(child, false, [], owner);
        return;
      }
      case 'export_statement': {
        // Decorators written before `export class` belong to the export.
        const decorators = node.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c?.text ?? '');
        // `export default memo(function Name() {…})` names its function inside the call.
        const value = node.childForFieldName('value');
        const named = value ? namedFunctionIn(value) : undefined;
        const namedName = named?.childForFieldName('name');
        if (value?.type === 'object') return members(value, true, parent);
        if (named && namedName) {
          const owner = sink.add(namedName, named.type.includes('class') ? 'class' : functionKind(namedName.text, jsx), named, true, parent);
          if (!named.type.includes('class')) inside(named, owner);
          return;
        }
        for (const child of node.namedChildren) if (child) declare(child, true, decorators, parent);
        return;
      }
      case 'ambient_declaration':
        for (const child of node.namedChildren) if (child) declare(child, exported, [], parent);
        return;
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature':
        if (name) inside(node, sink.add(name, functionKind(name.text, jsx), node, exported, parent));
        return;
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class':
        if (name) declareClass(node, name, exported, outer, parent);
        return;
      case 'interface_declaration': {
        if (!name) return;
        const owner = sink.add(name, 'interface', node, exported, parent);
        for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
          const memberName = member?.childForFieldName('name');
          if (!member || memberName?.type !== 'property_identifier') continue;
          const kind = member.type === 'method_signature' ? 'method' : member.type === 'property_signature' ? 'field' : undefined;
          if (kind) sink.add(memberName, kind, member, exported, owner);
        }
        return;
      }
      case 'type_alias_declaration':
        if (name) sink.add(name, 'type', node, exported, parent);
        return;
      case 'enum_declaration': {
        if (!name) return;
        const owner = sink.add(name, 'enum', node, exported, parent);
        for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
          const value = member?.type === 'enum_assignment' ? member.childForFieldName('name') : member;
          if (member && value?.type === 'property_identifier') sink.add(value, 'field', member, exported, owner);
        }
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const declarator of node.namedChildren) {
          const binding = declarator?.childForFieldName('name');
          if (declarator?.type !== 'variable_declarator' || !binding) continue;
          if (binding.type === 'identifier') {
            const value = declarator.childForFieldName('value');
            const bound = sink.add(binding, bindingKind(binding.text, value, jsx), declarator, exported, parent);
            if (value?.type === 'object') members(value, exported, bound);
            else if (value) inside(value, bound);
            continue;
          }
          for (const bound of boundNames(binding)) sink.add(bound, 'const', declarator, exported, parent);
        }
        return;
    }
  };

  // A function written as an assignment, as CommonJS and prototype code do:
  // `Cloud.beforeSave = function () {…}`, `exports.handler = () => {…}`,
  // `Store.prototype.get = function () {…}`. It belongs to the object's
  // symbol when the file declares it.
  const assigned = (statement: Node, assignment: Node) => {
    const left = assignment.childForFieldName('left');
    const value = assignment.childForFieldName('right');
    // `module.exports = { … }` exports its functions; `Store.prototype = { … }` holds Store's methods.
    if (value?.type === 'object') {
      const prototype = /^(\w+)\.prototype$/.exec(left?.text ?? '')?.[1];
      const owner = prototype ? sink.symbols.find((s) => s.name === prototype && !s.parent) : undefined;
      if (owner || /^(module\.)?exports$/.test(left?.text ?? '')) members(value, true, owner);
      return;
    }
    const property = left?.type === 'member_expression' ? left.childForFieldName('property') : null;
    if (!value || !functionValues.has(value.type) || property?.type !== 'property_identifier') return;
    const object = left?.childForFieldName('object')?.text.replace(/\.prototype$/, '') ?? '';
    const owner = sink.symbols.find((s) => s.name === object && !s.parent);
    const exported = /^(module\.)?exports$/.test(object) || owner?.exported === true;
    inside(value, sink.add(property, functionKind(property.text, jsx), statement, exported, owner));
  };

  // The functions an object literal holds, `m() {…}`, `m: function () {…}` or
  // `m: () => …`, under [owner] as its methods, or as functions without one;
  // those of an object it holds too, as Vue's `methods: { … }`.
  const members = (object: Node, exported: boolean, owner?: CodeSymbol): void => {
    for (const member of object.namedChildren) {
      if (!member) continue;
      const key = member.childForFieldName(member.type === 'pair' ? 'key' : 'name');
      const value = member.type === 'pair' ? member.childForFieldName('value') : member;
      if (key?.type !== 'property_identifier' || !value) {
        inside(member, owner);
        continue;
      }
      if (member.type === 'method_definition' || functionValues.has(value.type)) {
        inside(value, sink.add(key, owner ? 'method' : functionKind(key.text, jsx), member, exported, owner));
      } else if (value.type === 'object') members(value, exported, owner);
      else inside(value, owner);
    }
  };

  // The named functions declared anywhere in [node], under [owner]: a
  // function, or a binding holding one. Classes declared in a function
  // are left out, as are other locals.
  const inside = (node: Node, owner?: CodeSymbol): void => {
    for (const child of node.namedChildren) {
      if (!child || child.type.includes('class')) continue;
      const name = child.childForFieldName('name');
      if ((child.type === 'function_declaration' || child.type === 'generator_function_declaration') && name) {
        inside(child, sink.add(name, functionKind(name.text, jsx), child, false, owner, true));
        continue;
      }
      const value = child.type === 'variable_declarator' ? child.childForFieldName('value') : null;
      if (name?.type === 'identifier' && value && functionValues.has(value.type)) {
        inside(value, sink.add(name, functionKind(name.text, jsx), child, false, owner, true));
        continue;
      }
      inside(child, owner);
    }
  };

  const declareClass = (node: Node, name: Node, exported: boolean, outer: string[], parent?: CodeSymbol) => {
    const decorators = [...outer, ...node.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c?.text ?? '')];
    const owner = sink.add(name, decorators.some((d) => d.startsWith('@Injectable')) ? 'provider' : 'class', node, exported, parent);
    const controller = decorators.some((d) => d.startsWith('@Controller'));
    let pending: string[] = [];
    for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
      if (!member) continue;
      if (member.type === 'decorator') {
        pending.push(member.text);
        continue;
      }
      const memberName = member.childForFieldName('name') ?? member.childForFieldName('property');
      const isMethod = ['method_definition', 'method_signature', 'abstract_method_signature'].includes(member.type);
      if (memberName && isMethod) {
        const own = [...pending, ...member.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c?.text ?? '')];
        const route = controller && own.some((d) => httpDecorator.test(d));
        inside(member, sink.add(memberName, route ? 'route' : 'method', member, exported, owner));
      }
      // `handle = () => {…}` is a method written as a field.
      if (memberName?.type === 'property_identifier' && fieldTypes.has(member.type)) {
        const value = member.childForFieldName('value');
        const field = sink.add(memberName, value && functionValues.has(value.type) ? 'method' : 'field', member, exported, owner);
        if (value && functionValues.has(value.type)) inside(value, field);
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

// The names a destructuring pattern binds, nested ones included; not its
// property keys or default values.
function boundNames(pattern: Node): Node[] {
  switch (pattern.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      return [pattern];
    case 'pair_pattern':
    case 'assignment_pattern':
    case 'object_assignment_pattern': {
      const bound = pattern.childForFieldName(pattern.type === 'pair_pattern' ? 'value' : 'left');
      return bound ? boundNames(bound) : [];
    }
    case 'array_pattern':
    case 'object_pattern':
    case 'rest_pattern':
      return pattern.namedChildren.flatMap((c) => (c ? boundNames(c) : []));
    default:
      return [];
  }
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
