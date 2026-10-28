import type { Node } from 'web-tree-sitter';
import type { SymbolSink } from '../sink.ts';
import type { CodeSymbol } from '../symbols.ts';

const compound = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'while_statement',
  'with_statement',
  'try_statement',
  'except_clause',
  'finally_clause',
]);

// `@app.get(…)`, `@router.post(…)` and the like: a FastAPI (or similar) route.
const routeDecorator = /^@[\w.]+\.(get|post|put|patch|delete|options|head|trace|api_route|websocket)\(/;

/**
 * Python declarations: top-level functions, classes and assignments, and
 * class methods and attributes (model fields, enum members). A function
 * decorated as an HTTP route is a route. A name starting with an underscore
 * is private; everything else is exported.
 */
export function extractPython(root: Node, sink: SymbolSink): void {
  // [outer] is the decorated definition, when there is one: its range
  // starts at the decorators.
  const define = (node: Node, decorators: string[], parent?: CodeSymbol, outer = node) => {
    const name = node.childForFieldName('name');
    if (!name) return;
    const exported = isPublic(name.text);
    if (node.type === 'function_definition') {
      const route = decorators.some((d) => routeDecorator.test(d));
      sink.add(name, route ? 'route' : parent ? 'method' : 'function', outer, exported, parent);
      return;
    }
    if (node.type === 'class_definition' && !parent) {
      const owner = sink.add(name, 'class', outer, exported);
      const body = node.childForFieldName('body');
      for (const member of body?.namedChildren ?? []) {
        if (member) visit(member, owner);
      }
      if (body) declareAttributes(body, owner);
    }
  };

  // `self.name = …` in a method declares an instance attribute; the first
  // assignment is its declaration, unless the class body names it already.
  const declareAttributes = (body: Node, owner: CodeSymbol) => {
    const known = new Set(sink.symbols.filter((s) => s.parent === owner.id).map((s) => s.name));
    for (const assignment of body.descendantsOfType('assignment')) {
      if (!assignment) continue;
      const left = assignment.childForFieldName('left');
      if (left?.type !== 'attribute' || left.childForFieldName('object')?.text !== 'self') continue;
      const attribute = left.childForFieldName('attribute');
      if (!attribute || known.has(attribute.text)) continue;
      known.add(attribute.text);
      sink.add(attribute, 'field', assignment.parent ?? assignment, isPublic(attribute.text), owner);
    }
  };

  const visit = (node: Node, parent?: CodeSymbol) => {
    // Names bound under a module-level `if`, `for`, `with` or `try` are module globals too.
    if (!parent && compound.has(node.type)) {
      for (const child of node.namedChildren) {
        if (child?.type === 'block') for (const statement of child.namedChildren) statement && visit(statement);
        else if (child && compound.has(child.type)) visit(child);
      }
      return;
    }
    if (node.type === 'decorated_definition') {
      const definition = node.childForFieldName('definition');
      const decorators = node.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c?.text ?? '');
      if (definition) define(definition, decorators, parent, node);
      return;
    }
    if (node.type === 'function_definition' || node.type === 'class_definition') {
      define(node, [], parent);
      return;
    }
    if (node.type === 'expression_statement') {
      // `NAME = …`, or `name: type = …` and `name: type` in a class body.
      const assignment = node.namedChildren[0];
      const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null;
      if (left?.type !== 'identifier') return;
      sink.add(left, parent ? 'field' : 'const', node, isPublic(left.text), parent);
    }
  };

  for (const node of root.namedChildren) if (node) visit(node);
}

// A leading underscore marks a private name; `__init__` and the other dunders are public.
function isPublic(name: string): boolean {
  return !name.startsWith('_') || /^__\w+__$/.test(name);
}

