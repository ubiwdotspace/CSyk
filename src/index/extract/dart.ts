import type { Node } from 'web-tree-sitter';
import type { SymbolSink } from '../sink.ts';
import type { CodeSymbol } from '../symbols.ts';

// A class built on one of these is a Flutter widget (or a widget's state).
const widgetBase = /^(Stateless|Stateful|Consumer|ConsumerStateful|Hook|HookConsumer)Widget\b|^(Consumer)?State</;

const signatureTypes = new Set(['function_signature', 'getter_signature', 'setter_signature']);

/**
 * Dart declarations: classes (widgets labelled), mixins, extensions and
 * extension types, enums, type aliases, top-level functions and variables,
 * and class methods, getters and setters. A name starting with an
 * underscore is library private; everything else is exported.
 */
export function extractDart(root: Node, sink: SymbolSink): void {
  const exported = (name: string) => !name.startsWith('_');
  const children = root.namedChildren.filter((c): c is Node => c !== null);

  // A signature's body is its next sibling.
  const withBody = (signature: Node, siblings: Node[], at: number): Node | [Node, Node] => {
    const next = siblings[at + 1];
    return next?.type === 'function_body' ? [signature, next] : signature;
  };

  const declareMembers = (body: Node | null, owner: CodeSymbol) => {
    const members = body?.namedChildren.filter((c): c is Node => c !== null) ?? [];
    members.forEach((member, at) => {
      // A `declaration` holds an abstract method or getter, without a body.
      if (member.type !== 'method_signature' && member.type !== 'declaration') return;
      const signature = member.namedChildren.find((c) => c !== null && signatureTypes.has(c.type));
      const name = signature?.childForFieldName('name');
      if (name) sink.add(name, 'method', withBody(member, members, at), exported(name.text), owner);
    });
  };

  children.forEach((node, at) => {
    // A mixin's name is a plain child, not a field.
    const name =
      node.childForFieldName('name') ?? (node.type === 'mixin_declaration' ? (node.namedChildren.find((c) => c?.type === 'identifier') ?? null) : null);
    switch (node.type) {
      case 'class_definition': {
        if (!name) return;
        const base = node.childForFieldName('superclass')?.text.replace(/^extends\s+/, '') ?? '';
        const owner = sink.add(name, widgetBase.test(base) ? 'widget' : 'class', node, exported(name.text));
        declareMembers(node.childForFieldName('body'), owner);
        return;
      }
      case 'mixin_declaration':
      case 'extension_declaration':
      case 'extension_type_declaration': {
        if (!name) return;
        const owner = sink.add(name, 'class', node, exported(name.text));
        declareMembers(node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type.endsWith('body')) ?? null, owner);
        return;
      }
      case 'enum_declaration': {
        if (!name) return;
        const owner = sink.add(name, 'enum', node, exported(name.text));
        for (const value of node.childForFieldName('body')?.namedChildren ?? []) {
          const valueName = value?.type === 'enum_constant' ? value.childForFieldName('name') : null;
          if (value && valueName) sink.add(valueName, 'field', value, exported(name.text), owner);
        }
        return;
      }
      case 'type_alias': {
        const alias = name ?? node.namedChildren.find((c) => c?.type === 'type_identifier');
        if (alias) sink.add(alias, 'type', node, exported(alias.text));
        return;
      }
      case 'function_signature':
      case 'getter_signature':
      case 'setter_signature':
        if (name) sink.add(name, 'function', withBody(node, children, at), exported(name.text));
        return;
      case 'static_final_declaration_list':
      case 'initialized_identifier_list':
        for (const declaration of node.namedChildren) {
          const id = declaration?.namedChildren.find((c) => c?.type === 'identifier');
          if (declaration && id) sink.add(id, 'const', declaration, exported(id.text));
        }
        return;
    }
  });
}
