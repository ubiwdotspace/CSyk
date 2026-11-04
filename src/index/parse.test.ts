import { describe, expect, it } from 'vitest';
import { extractSymbols, inDocLink, isCallAt, isCodeAt, parseFile } from './parse.ts';

const names = async (file: string, text: string) =>
  (await extractSymbols(file, text)).map((s) => `${s.kind} ${s.name}${s.exported ? '' : ' (local)'}`);

describe('extractSymbols for TypeScript', () => {
  it('finds top-level declarations and class methods, not function locals', async () => {
    const text = [
      'export function calculateTotal(items: number[]) {',
      '  const subtotal = 1;',
      '  return subtotal;',
      '}',
      'export class TokenStore { save() {} private clear() {} reset = () => 1; count = 0 }',
      'export interface Item { id: string; load(): void }',
      'type Id = string;',
      "export enum Mode { A, B = 'b' }",
      'export const MAX_ITEMS = 10;',
      'const helper = () => 1;',
      'const [base, { file: coverageFile, min = 90 }, ...rest] = args;',
      'export namespace Range { export function from(x: number) { return x; } }',
    ].join('\n');
    expect(await names('src/a.ts', text)).toEqual([
      'function calculateTotal',
      'class TokenStore',
      'method save',
      'method clear',
      'method reset',
      'field count',
      'interface Item',
      'field id',
      'method load',
      'type Id (local)',
      'enum Mode',
      'field A',
      'field B',
      'const MAX_ITEMS',
      'function helper (local)',
      'const base (local)',
      'const coverageFile (local)',
      'const min (local)',
      'const rest (local)',
      'namespace Range',
      'function from',
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

describe('extractSymbols for JavaScript', () => {
  it('finds functions inside functions, under the one around them, marked nested', async () => {
    const source = [
      'export function jobStatusHandler(config) {',
      '  const setMessage = function (message) {',
      '    return message;',
      '  };',
      '  function complete() {',
      '    return setMessage("done");',
      '  }',
      '  const total = 3;',
      '  return { complete, total };',
      '}',
    ].join('\n');
    const found = (await extractSymbols('status.js', source)).map((s) => `${s.id.split('#')[1]}${s.nested ? ' nested' : ''}`);
    expect(found).toEqual(['jobStatusHandler', 'jobStatusHandler.setMessage nested', 'jobStatusHandler.complete nested']);
  });

  it('finds functions written as assignments, as CommonJS and prototype code do', async () => {
    const source = [
      'var Cloud = {};',
      'Cloud.beforeSave = function (name, handler) {',
      '  return register(name, handler);',
      '};',
      'exports.handler = async (req) => req;',
      'function Store() {}',
      'Store.prototype.get = function (key) {',
      '  return key;',
      '};',
      'module.exports.version = "1";',
    ].join('\n');
    const found = (await extractSymbols('cloud.js', source)).map((s) => `${s.kind} ${s.id.split('#')[1]} ${s.range.join('-')}`);
    expect(found).toEqual(expect.arrayContaining(['function Cloud.beforeSave 2-4', 'function handler 5-5', 'function Store.get 7-9']));
    expect(found.some((f) => f.includes('version'))).toBe(false);
  });

  it('finds the functions an object literal holds, not its other values', async () => {
    const source = [
      'module.exports = {',
      '  compileMethods() {',
      '    return 1;',
      '  },',
      '  validate: function () {},',
      '  limit: 3,',
      '};',
      'const api = { get: (id) => id, [dynamic]: () => 0 };',
      'function Store() {}',
      'Store.prototype = { save() {} };',
      'export default { methods: { onClick() {} } };',
    ].join('\n');
    const found = (await extractSymbols('lib.js', source)).map((s) => `${s.kind} ${s.id.split('#')[1]} ${s.range.join('-')}`);
    expect(found).toEqual([
      'function compileMethods 2-4',
      'function validate 5-5',
      'const api 8-8',
      'method api.get 8-8',
      'function Store 9-9',
      'method Store.save 10-10',
      'function onClick 11-11',
    ]);
  });

  it('finds the functions of an object literal a top-level call is given or returned', async () => {
    const source = [
      "export const todos = createSlice({ name: 'todos', reducers: { addTodo(state) {}, clear: () => [] } });",
      'expect.extend({ toBeNear(received) {} });',
      'export const useStore = create()(immer((set) => ({ count: 0, increment: () => set({}) })));',
      'export default defineComponent({ methods: { submit() {} } });',
      "describe('todos', () => { const helper = { make() {} }; });",
    ].join('\n');
    const found = (await extractSymbols('store.ts', source)).map((s) => `${s.kind} ${s.id.split('#')[1]} ${s.range.join('-')}`);
    expect(found).toEqual([
      'const todos 1-1',
      'method todos.addTodo 1-1',
      'method todos.clear 1-1',
      'function toBeNear 2-2',
      'const useStore 3-3',
      'method useStore.increment 3-3',
      'function submit 4-4',
    ]);
  });

  it('finds the methods Object.assign copies onto a constructor or its prototype', async () => {
    const source = [
      'function Line() {}',
      'Line.prototype = Object.assign(Object.create(Object3D.prototype), {',
      '  constructor: Line,',
      '  raycast: function (raycaster) {},',
      '});',
      'Object.assign(Line.prototype, { copy(source) {} });',
      'Object.assign(Line, { create() {} });',
    ].join('\n');
    const found = (await extractSymbols('Line.js', source)).map((s) => `${s.kind} ${s.id.split('#')[1]} ${s.range.join('-')}`);
    expect(found).toEqual(['function Line 1-1', 'method Line.raycast 4-4', 'method Line.copy 6-6', 'method Line.create 7-7']);
  });

  it('names an unnamed default export function default, as TypeScript does', async () => {
    const source = ['function log() {}', 'export default function ({ start }) {', '  log();', '  const inner = () => 1;', '}'].join('\n');
    const found = (await extractSymbols('runner.js', source)).map((s) => `${s.kind} ${s.id.split('#')[1]} ${s.range.join('-')}${s.nested ? ' nested' : ''}`);
    expect(found).toEqual(['function log 1-1', 'function default 2-5', 'function default.inner 4-4 nested']);
  });

  it("indexes a hook's handlers kept by useCallback and the like, not other calls given a function", async () => {
    const source = [
      'export function useAutocomplete(props) {',
      '  const resetInputValue = useEventCallback((event) => {',
      '    const inner = () => event;',
      '  });',
      '  const onBlur = React.useCallback(function () {}, []);',
      '  const save = debounce(() => {}, 100);',
      '  const names = props.users.map((u) => u.name);',
      '  const value = compute(() => 1);',
      '}',
    ].join('\n');
    const found = (await extractSymbols('useAutocomplete.js', source)).map((s) => `${s.kind} ${s.id.split('#')[1]} ${s.range.join('-')}`);
    expect(found).toEqual([
      'hook useAutocomplete 1-9',
      'function useAutocomplete.resetInputValue 2-4',
      'function resetInputValue.inner 3-3',
      'function useAutocomplete.onBlur 5-5',
      'function useAutocomplete.save 6-6',
    ]);
  });

  it('reads JavaScript with type annotations, as Babel takes it', async () => {
    const source = [
      '// @flow',
      'export type Options = { uri: string };',
      'export class Adapter {',
      '  _uri: string;',
      '  constructor(options: Options) {',
      '    this._uri = options.uri;',
      '  }',
      '  _connect(): Promise<void> {',
      '    return Promise.resolve();',
      '  }',
      '}',
    ].join('\n');
    const names = (await extractSymbols('src/adapter.js', source)).map((s) => `${s.kind} ${s.name}`);
    expect(names).toEqual(expect.arrayContaining(['type Options', 'class Adapter', 'method _connect']));
  });
});

describe('isCodeAt and inDocLink', () => {
  it('tells code from comments and strings, and keeps JSDoc links and element keys', async () => {
    const lines = ['run(total); // total', 'log("total", `${total}`);', '/** See {@link total}. */', "client['total'](1);"];
    const tree = (await parseFile('a.ts', lines.join('\n')))!;
    expect(isCodeAt(tree, 0, 4)).toBe(true);
    expect(isCodeAt(tree, 0, 15)).toBe(false);
    expect(isCodeAt(tree, 1, 5)).toBe(false);
    expect(isCodeAt(tree, 1, 16)).toBe(true);
    expect(inDocLink(lines[2]!, 17)).toBe(true);
    expect(inDocLink(lines[0]!, 15)).toBe(false);
    // A JSDoc tag's type and what @augments names, not a tag's description.
    expect(inDocLink(' * @returns {?Styles} the styles', 14)).toBe(true);
    expect(inDocLink(' * @param {Array<Styles>} list', 17)).toBe(true);
    expect(inDocLink(' * @augments BaseButton', 13)).toBe(true);
    expect(inDocLink(' * @param {Object} styles - the Styles to use', 34)).toBe(false);
    expect(inDocLink('const s = 1; // @returns {Styles}', 26)).toBe(false);
    // A string keying an element access names a member.
    expect(isCodeAt(tree, 3, 8)).toBe(true);
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
      '    name: str',
      '    price: float = 0',
      '    def __init__(self):',
      '        self.name = "x"',
      '        self._cache = {}',
      '    @property',
      '    def total(self):',
      '        return 1',
      '    def _check(self): pass',
      'MAX_ITEMS = 10',
      'def _helper(): pass',
      'for path in paths:',
      '    lf_data = path.read()',
    ].join('\n');
    expect(await kinds('app/api.py', text)).toEqual([
      'route read_items',
      'class Item',
      'field Item.name',
      'field Item.price',
      'method Item.__init__',
      'method Item.total',
      'method Item._check (private)',
      'field Item._cache (private)',
      'const MAX_ITEMS',
      'function _helper (private)',
      'const lf_data',
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
      'var (',
      '\tLogger func()',
      ')',
    ].join('\n');
    expect(await kinds('store/store.go', text)).toEqual([
      'function New',
      'class Store',
      'interface Saver',
      'method Saver.Save',
      'type ID',
      'const Max',
      'const min (private)',
      'const Default',
      'const Logger',
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
      'abstract class Store { void save() {} String get label; }',
      'int add(int a) => a;',
      'final maxItems = 3;',
      'mixin HasPaint on Component { void paint() {} }',
      'sealed class Shape {}',
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
      'method Store.label',
      'function add',
      'const maxItems',
      'class HasPaint',
      'method HasPaint.paint',
      'class Shape',
      'enum Mode',
      'field Mode.a',
      'field Mode.b',
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

describe('isCallAt', () => {
  // Every `target` in [text] that is called, by its 0-based line.
  const calledLines = async (file: string, text: string) => {
    const tree = (await parseFile(file, text))!;
    try {
      return text.split('\n').flatMap((line, i) => {
        const at = line.indexOf('target');
        return at >= 0 && isCallAt(tree, i, at) ? [i] : [];
      });
    } finally {
      tree.delete();
    }
  };

  it('finds calls, constructions, decorators and JSX in TypeScript, not mentions', async () => {
    const text = ['target();', 'a.target(1);', 'new target();', '@target class A {}', 'const x = <target />;', 'const f = target;', 'a.target;'].join('\n');
    expect(await calledLines('a.tsx', text)).toEqual([0, 1, 2, 3, 4]);
  });

  it('finds calls in Python, Go and Dart', async () => {
    expect(await calledLines('a.py', ['target()', 'self.target(1)', '@target', 'def f(): pass', 'x = target'].join('\n'))).toEqual([0, 1, 2]);
    expect(await calledLines('a.go', ['package a', 'func f() {', '\ttarget()', '\tpkg.target(1)', '\tx := target', '}'].join('\n'))).toEqual([2, 3]);
    expect(await calledLines('a.dart', ['void f() {', '  target(1);', '  a.target(2);', '  final x = target;', '}'].join('\n'))).toEqual([1, 2]);
  });
});
