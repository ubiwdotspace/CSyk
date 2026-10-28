import { describe, expect, it } from 'vitest';
import { extractTsSymbols, inJsDocLink, isCodeAt, parseTs } from './ts-parser.ts';

const names = async (file: string, text: string) =>
  (await extractTsSymbols(file, text)).map((s) => `${s.kind} ${s.name}${s.exported ? '' : ' (local)'}`);

describe('extractTsSymbols', () => {
  it('finds top-level declarations and class methods, not function locals', async () => {
    const text = [
      'export function calculateTotal(items: number[]) {',
      '  const subtotal = 1;',
      '  return subtotal;',
      '}',
      'export class TokenStore { save() {} private clear() {} }',
      'export interface Item { id: string }',
      'type Id = string;',
      'export enum Mode { A }',
      'export const MAX_ITEMS = 10;',
      'const helper = () => 1;',
    ].join('\n');
    expect(await names('src/a.ts', text)).toEqual([
      'function calculateTotal',
      'class TokenStore',
      'method save',
      'method clear',
      'interface Item',
      'type Id (local)',
      'enum Mode',
      'const MAX_ITEMS',
      'function helper (local)',
    ]);
  });

  it('labels components and hooks, wrapped ones included', async () => {
    const text = [
      'export const Button = () => <button />;',
      'export const Card = memo(() => <div />);',
      'export function useToggle() { return true; }',
      'export default memo(function Dashboard() { return null; });',
    ].join('\n');
    expect(await names('src/ui.tsx', text)).toEqual([
      'component Button',
      'component Card',
      'hook useToggle',
      'component Dashboard',
    ]);
  });

  it('gives each symbol its name line and range, 1-based', async () => {
    const [fn] = await extractTsSymbols('a.ts', '\n/** Doc. */\nexport function f() {\n  return 1;\n}\n');
    expect(fn).toMatchObject({ id: 'a.ts#f', line: 3, range: [3, 5], signature: 'function f() {' });
  });
});

describe('isCodeAt and inJsDocLink', () => {
  it('tells code from comments and strings, and keeps JSDoc links', async () => {
    const lines = ['run(total); // total', 'log("total", `${total}`);', '/** See {@link total}. */'];
    const tree = (await parseTs('a.ts', lines.join('\n')))!;
    expect(isCodeAt(tree, 0, 4)).toBe(true);
    expect(isCodeAt(tree, 0, 15)).toBe(false);
    expect(isCodeAt(tree, 1, 5)).toBe(false);
    expect(isCodeAt(tree, 1, 16)).toBe(true);
    expect(inJsDocLink(lines[2]!, 17)).toBe(true);
    expect(inJsDocLink(lines[0]!, 15)).toBe(false);
    tree.delete();
  });
});
