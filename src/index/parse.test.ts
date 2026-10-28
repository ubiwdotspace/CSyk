import { describe, expect, it } from 'vitest';
import { extractSymbols, inDocLink, isCodeAt, parseFile } from './parse.ts';

const names = async (file: string, text: string) =>
  (await extractSymbols(file, text)).map((s) => `${s.kind} ${s.name}${s.exported ? '' : ' (local)'}`);

describe('extractSymbols for TypeScript', () => {
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
    const [fn] = await extractSymbols('a.ts', '\n/** Doc. */\nexport function f() {\n  return 1;\n}\n');
    expect(fn).toMatchObject({ id: 'a.ts#f', line: 3, range: [3, 5], signature: 'function f() {' });
  });
});

describe('isCodeAt and inDocLink', () => {
  it('tells code from comments and strings, and keeps JSDoc links', async () => {
    const lines = ['run(total); // total', 'log("total", `${total}`);', '/** See {@link total}. */'];
    const tree = (await parseFile('a.ts', lines.join('\n')))!;
    expect(isCodeAt(tree, 0, 4)).toBe(true);
    expect(isCodeAt(tree, 0, 15)).toBe(false);
    expect(isCodeAt(tree, 1, 5)).toBe(false);
    expect(isCodeAt(tree, 1, 16)).toBe(true);
    expect(inDocLink(lines[2]!, 17)).toBe(true);
    expect(inDocLink(lines[0]!, 15)).toBe(false);
    tree.delete();
  });
});

const kinds = async (file: string, text: string) =>
  (await extractSymbols(file, text)).map((s) => `${s.kind} ${s.parent ? `${s.parent.split('#')[1]}.` : ''}${s.name}${s.exported ? '' : ' (private)'}`);

describe('extractSymbols for Python', () => {
  it('finds functions, classes, methods and module constants, and labels routes', async () => {
    const text = [
      '@router.get("/items")',
      'async def read_items(q: str):',
      '    local = 1',
      '    return q',
      'class Item(BaseModel):',
      '    @property',
      '    def total(self):',
      '        return 1',
      '    def _check(self): pass',
      'MAX_ITEMS = 10',
      'def _helper(): pass',
    ].join('\n');
    expect(await kinds('app/api.py', text)).toEqual([
      'route read_items',
      'class Item',
      'method Item.total',
      'method Item._check (private)',
      'const MAX_ITEMS',
      'function _helper (private)',
    ]);
  });
});

describe('extractSymbols for Go', () => {
  it('finds functions, types, constants and methods under their receiver', async () => {
    const text = [
      'package store',
      'func (s *Store) Save() error { return nil }',
      'func New() *Store { return &Store{} }',
      'type Store struct{ n int }',
      'type Saver interface{ Save() error }',
      'type ID = string',
      'const Max, min = 3, 1',
      'var Default = New()',
    ].join('\n');
    expect(await kinds('store/store.go', text)).toEqual([
      'function New',
      'class Store',
      'interface Saver',
      'type ID',
      'const Max',
      'const min (private)',
      'const Default',
      'method Store.Save',
    ]);
  });
});

describe('extractSymbols for Dart', () => {
  it('finds widgets, classes, methods, enums and top-level declarations', async () => {
    const text = [
      'class Home extends StatelessWidget {',
      '  const Home({super.key});',
      '  @override',
      '  Widget build(BuildContext context) => Text("hi");',
      '  int get count => 1;',
      '}',
      'class _HomeState extends State<Home> {}',
      'class Store { void save() {} }',
      'int add(int a) => a;',
      'final maxItems = 3;',
      'enum Mode { a, b }',
      'typedef Callback = void Function();',
    ].join('\n');
    expect(await kinds('lib/home.dart', text)).toEqual([
      'widget Home',
      'method Home.build',
      'method Home.count',
      'widget _HomeState (private)',
      'class Store',
      'method Store.save',
      'function add',
      'const maxItems',
      'enum Mode',
      'type Callback',
    ]);
  });
});

describe('extractSymbols for NestJS', () => {
  it('labels controller routes and injectable providers', async () => {
    const text = [
      "@Controller('cats')",
      'export class CatsController {',
      "  @Get(':id')",
      '  findOne() {}',
      '  helper() {}',
      '}',
      '@Injectable()',
      'export class CatsService {}',
    ].join('\n');
    expect(await kinds('src/cats.ts', text)).toEqual([
      'class CatsController',
      'route CatsController.findOne',
      'method CatsController.helper',
      'provider CatsService',
    ]);
  });
});
