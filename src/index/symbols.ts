/** The languages CSyk reads. */
export type Lang = 'ts' | 'js' | 'py' | 'go' | 'dart' | 'md';

/** What a symbol is, framework roles included so they rank and filter. */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'component'
  | 'hook'
  | 'widget'
  | 'route'
  | 'provider'
  | 'field'
  | 'namespace'
  // A heading of a Markdown doc or spec.
  | 'section';

export const symbolKinds: readonly SymbolKind[] = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'const',
  'component',
  'hook',
  'widget',
  'route',
  'provider',
  'field',
  'namespace',
  'section',
];

/** A declaration found in the index. Lines are 1-based and inclusive. */
export type CodeSymbol = {
  /** `<file>#<Qualified.name>`, with `~n` for a repeat in the same file. */
  id: string;
  name: string;
  kind: SymbolKind;
  lang: Lang;
  file: string;
  /** The line of the declared name. */
  line: number;
  range: [number, number];
  /** The declaration's first line, trimmed and cut to 120 characters. */
  signature: string;
  /** The containing type, for a method. */
  parent?: string;
  exported: boolean;
  isTest: boolean;
};

const testFile =
  /(^|\/)(__tests__|__mocks__|e2e|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|dart)$|(^|\/)conftest\.py$/;

/** Whether [file] holds tests rather than the code under test. */
export function isTestFile(file: string): boolean {
  return testFile.test(file);
}
