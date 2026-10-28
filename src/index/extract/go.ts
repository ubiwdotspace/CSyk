import type { Node } from 'web-tree-sitter';
import type { SymbolSink } from '../sink.ts';
import type { CodeSymbol, SymbolKind } from '../symbols.ts';

/**
 * Go declarations: functions, methods (under their receiver type when it
 * is declared in the same file), types with their interface methods,
 * constants and package variables. A capitalised name is exported.
 */
export function extractGo(root: Node, sink: SymbolSink): void {
  const exported = (name: string) => /^[A-Z]/.test(name);
  const types = new Map<string, CodeSymbol>();
  const methods: Node[] = [];

  for (const node of root.namedChildren) {
    if (!node) continue;
    switch (node.type) {
      case 'function_declaration': {
        const name = node.childForFieldName('name');
        if (name) sink.add(name, 'function', node, exported(name.text));
        break;
      }
      case 'method_declaration':
        // Receivers may be declared further down the file.
        methods.push(node);
        break;
      case 'type_declaration':
        for (const spec of node.namedChildren) {
          const name = spec?.childForFieldName('name');
          if (!spec || !name || (spec.type !== 'type_spec' && spec.type !== 'type_alias')) continue;
          const shape = spec.childForFieldName('type');
          const kind: SymbolKind =
            shape?.type === 'struct_type' ? 'class' : shape?.type === 'interface_type' ? 'interface' : 'type';
          const owner = sink.add(name, kind, spec, exported(name.text));
          types.set(name.text, owner);
          if (shape?.type !== 'interface_type') continue;
          for (const element of shape.namedChildren) {
            const method = element?.type === 'method_elem' ? element.childForFieldName('name') : null;
            if (element && method) sink.add(method, 'method', element, exported(method.text), owner);
          }
        }
        break;
      case 'const_declaration':
      case 'var_declaration':
        for (const spec of node.namedChildren) {
          if (spec?.type !== 'const_spec' && spec?.type !== 'var_spec') continue;
          for (const name of spec.childrenForFieldName('name')) {
            if (name?.type === 'identifier') sink.add(name, 'const', spec, exported(name.text));
          }
        }
        break;
    }
  }

  for (const method of methods) {
    const name = method.childForFieldName('name');
    if (!name) continue;
    // `func (s *Store) Save()` belongs to Store.
    const receiver = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\)\s*$/.exec(method.childForFieldName('receiver')?.text ?? '');
    const owner = receiver?.[1] ? types.get(receiver[1]) : undefined;
    sink.add(name, 'method', method, exported(name.text), owner);
  }
}
