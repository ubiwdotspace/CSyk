import type { Node } from 'web-tree-sitter';
import type { SymbolSink } from '../sink.ts';
import type { CodeSymbol } from '../symbols.ts';

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
    const exported = !name.text.startsWith('_');
    if (node.type === 'function_definition') {
      const route = decorators.some((d) => routeDecorator.test(d));
      sink.add(name, route ? 'route' : parent ? 'method' : 'function', outer, exported, parent);
      return;
    }
    if (node.type === 'class_definition' && !parent) {
      const owner = sink.add(name, 'class', outer, exported);
      for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
        if (member) visit(member, owner);
      }
    }
  };

  const visit = (node: Node, parent?: CodeSymbol) => {
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
      sink.add(left, parent ? 'field' : 'const', node, !left.text.startsWith('_'), parent);
    }
  };

  for (const node of root.namedChildren) if (node) visit(node);
}
