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
  | 'hook';

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
];

/** A declaration found in the index. Lines are 1-based and inclusive. */
export type CodeSymbol = {
  /** `<file>#<Qualified.name>`, with `~n` for a repeat in the same file. */
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  /** The line of the declared name. */
  line: number;
  range: [number, number];
  /** The declaration's first line, trimmed and cut to 120 characters. */
  signature: string;
  /** The containing class, for a method. */
  parent?: string;
  exported: boolean;
  isTest: boolean;
};

const testFile = /(^|\/)(__tests__|__mocks__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Whether [file] holds tests rather than the code under test. */
export function isTestFile(file: string): boolean {
  return testFile.test(file);
}
