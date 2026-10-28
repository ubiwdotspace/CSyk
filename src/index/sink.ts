import type { Node } from 'web-tree-sitter';
import { isTestFile, type CodeSymbol, type Lang, type SymbolKind } from './symbols.ts';

/** Collects one file's symbols, giving each a unique id and its line range. */
export class SymbolSink {
  readonly symbols: CodeSymbol[] = [];
  readonly file: string;
  readonly lang: Lang;
  private readonly test: boolean;
  private readonly ids = new Set<string>();
  private lines: string[] | undefined;

  constructor(file: string, lang: Lang) {
    this.file = file;
    this.lang = lang;
    this.test = isTestFile(file);
  }

  /**
   * Adds the symbol named by [name], declared by [node] (or the span from
   * the first node to the last, for a signature and its separate body).
   */
  add(name: Node, kind: SymbolKind, node: Node | [Node, Node], exported: boolean, parent?: CodeSymbol): CodeSymbol {
    const [first, last] = Array.isArray(node) ? node : [node, node];
    const qualified = parent ? `${parent.name}.${name.text}` : name.text;
    let id = `${this.file}#${qualified}`;
    for (let n = 2; this.ids.has(id); n++) id = `${this.file}#${qualified}~${n}`;
    this.ids.add(id);
    const symbol: CodeSymbol = {
      id,
      name: name.text,
      kind,
      lang: this.lang,
      file: this.file,
      line: name.startPosition.row + 1,
      range: [first.startPosition.row + 1, last.endPosition.row + 1],
      signature: this.signatureOf(name, first),
      ...(parent ? { parent: parent.id } : {}),
      exported,
      isTest: this.test,
    };
    this.symbols.push(symbol);
    return symbol;
  }

  // The declaration's first line, trimmed and cut; when decorators come
  // first, the line that names it instead.
  private signatureOf(name: Node, first: Node): string {
    let line = first.text.split('\n', 1)[0] ?? '';
    if (first.startPosition.row !== name.startPosition.row) {
      const root = name.tree.rootNode;
      this.lines ??= root.text.split('\n');
      line = this.lines[name.startPosition.row - root.startPosition.row] ?? '';
    }
    line = line.trim();
    return line.length > 120 ? `${line.slice(0, 119)}…` : line;
  }
}
