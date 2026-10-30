import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Workspace } from '../workspace/workspace.ts';
import { calls, impact } from './calls.ts';

// A small TS repo: `total` is called by `checkout`, which a test calls.
let root: string;
let ws: Workspace;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'csyk-calls-'));
  writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "strict": true }, "include": ["*.ts"] }');
  writeFileSync(join(root, 'total.ts'), 'export function total(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n');
  writeFileSync(
    join(root, 'checkout.ts'),
    "import { total } from './total';\n\nexport function checkout(xs: number[]) {\n  const sum = total(xs);\n  return sum * 2;\n}\n",
  );
  writeFileSync(join(root, 'checkout.test.ts'), "import { checkout } from './checkout';\n\ncheckout([1, 2]);\n");
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  ws = await Workspace.open(root);
}, 30_000);

afterAll(() => ws.close());

describe('calls', () => {
  it('lists callers, two levels up', async () => {
    const result = await calls(ws, 'total', { depth: 2 });
    expect(result.text.split('\n').slice(1)).toEqual(['checkout.ts#checkout  4', '  checkout.test.ts (top level)  3']);
  }, 30_000);

  it('finds a name even when a closer-ranked name looks the same squashed', async () => {
    writeFileSync(join(root, 'signal.ts'), 'export function update_signal() { return _update_signal(); }\nfunction _update_signal() {}\n');
    await ws.index.update('signal.ts');
    expect((await calls(ws, '_update_signal')).text.split('\n').slice(1)).toEqual(['signal.ts#update_signal  1']);
  }, 30_000);

  it('lists callees', async () => {
    const result = await calls(ws, 'checkout', { direction: 'out' });
    expect(result.text.split('\n').slice(1)).toEqual(['total.ts#total  1']);
  }, 30_000);

  it("counts a call through the base type as a caller of an override, not a sibling's super call", async () => {
    const shapes = [
      'export class Shape { area() { return 0; } }',
      'export class Square extends Shape { area() { return 1; } }',
      'export class Circle extends Shape { area() { return super.area() + 3; } }',
      'export class Tile extends Square { area() { return super.area() * 2; } }',
      'export function total(s: Shape) { return s.area(); }',
    ];
    writeFileSync(join(root, 'shapes.ts'), `${shapes.join('\n')}\n`);
    await ws.index.update('shapes.ts');
    expect((await calls(ws, 'shapes.ts#Square.area')).text.split('\n').slice(1)).toEqual(['shapes.ts#Tile.area  4', 'shapes.ts#total  5']);
  }, 30_000);

  it("counts this.m() above an override or below it, not in a sibling class", async () => {
    const buttons = [
      'export class Button {',
      '  isOn() { return false; }',
      '  click() { return this.isOn(); }',
      '}',
      'export class MuteButton extends Button {',
      '  isOn() { return true; }',
      '}',
      'export class PipButton extends Button {',
      '  toggle() { return !this.isOn(); }',
      '}',
      'export function press(b: Button) { return b.isOn(); }',
    ];
    writeFileSync(join(root, 'buttons.ts'), `${buttons.join('\n')}\n`);
    await ws.index.update('buttons.ts');
    expect((await calls(ws, 'buttons.ts#MuteButton.isOn')).text.split('\n').slice(1)).toEqual(['buttons.ts#Button.click  3', 'buttons.ts#press  11']);
  }, 30_000);

  it("does not take a type parameter's bound for what a class extends", async () => {
    const items = [
      'export interface Props { label?: string }',
      'export class Base<P extends Props> { get label() { return "x"; } }',
      'export class Item extends Base<Props> { render() { return this.label; } }',
      'export function caption(props: Props) { return props.label; }',
    ];
    writeFileSync(join(root, 'items.ts'), `${items.join('\n')}\n`);
    await ws.index.update('items.ts');
    expect((await calls(ws, 'items.ts#Base.label')).text.split('\n').slice(1)).toEqual(['items.ts#Item.render  3']);
  }, 30_000);

  it("counts new on a subclass without a constructor, and super() in one with, as calls of the base's", async () => {
    const routers = [
      'export class Router {',
      '  constructor() { this.mount(); }',
      '  mount() {}',
      '}',
      'export class Logs extends Router { mount() {} }',
      'export class Pages extends Router {',
      '  constructor() { super(); }',
      '}',
      'export class Deep extends Logs {}',
      'export function build() { return [new Logs(), new Deep()]; }',
      'export function pages() { return new Pages(); }',
      'export function plain() { return new Router(); }',
    ];
    writeFileSync(join(root, 'routers.ts'), `${routers.join('\n')}\n`);
    await ws.index.update('routers.ts');
    expect((await calls(ws, 'routers.ts#Router.constructor')).text.split('\n').slice(1)).toEqual([
      'routers.ts#Pages.constructor  7',
      'routers.ts#build  10',
      'routers.ts#plain  12',
    ]);
  }, 30_000);

  it('lists a local function as a callee, not a parameter or a destructured name', async () => {
    const run = [
      'export function run(cb: () => void, { done }: { done: () => void }) {',
      '  const [, set] = [0, (n: number) => n];',
      '  const helper = () => 1;',
      '  cb();',
      '  done();',
      '  set(1);',
      '  return helper();',
      '}',
    ];
    writeFileSync(join(root, 'local.ts'), `${run.join('\n')}\n`);
    await ws.index.update('local.ts');
    expect((await calls(ws, 'run', { direction: 'out' })).text.split('\n').slice(1)).toEqual(['local.ts#run.helper  3']);
  }, 30_000);
});

describe('calls across a project that cannot read JavaScript', () => {
  it('counts a TS caller whose import of the JS function the server stops at', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-nojs-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "allowJs": false }, "include": ["*.ts"] }');
    writeFileSync(join(dir, 'router.js'), 'export function build() {\n  return [];\n}\n');
    writeFileSync(join(dir, 'main.ts'), "import { build } from './router';\n\nexport function start() {\n  return build();\n}\n");
    // The default import is the module's default, not the function of the same name.
    writeFileSync(join(dir, 'log.js'), 'function log() {\n  return {};\n}\nexport default { error() {} };\n');
    writeFileSync(join(dir, 'fail.ts'), "import log from './log';\n\nexport function fail() {\n  log.error();\n}\n");
    const repo = await Workspace.open(dir);
    try {
      expect((await calls(repo, 'router.js#build')).text.split('\n').slice(1)).toEqual(['main.ts#start  4']);
      expect((await calls(repo, 'log.js#log')).text.split('\n').slice(1)).toEqual([]);
    } finally {
      await repo.close();
    }
  }, 30_000);
});

describe('calls of a default export', () => {
  it('counts uses under another name and through a wrapper as calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-default-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "jsx": "preserve" }, "include": ["*.ts", "*.tsx"] }');
    writeFileSync(join(dir, 'sum.ts'), 'export default function total(xs: number[]) {\n  return xs.length;\n}\n');
    writeFileSync(join(dir, 'main.ts'), "import add from './sum';\n\nexport function run() {\n  return add([1]);\n}\n");
    writeFileSync(join(dir, 'cli.ts'), 'export default function (name: string) {\n  return name;\n}\n');
    writeFileSync(join(dir, 'start.ts'), "import runner from './cli';\n\nrunner('server');\n");
    writeFileSync(join(dir, 'wrap.ts'), 'export const memo = <T>(c: T): T => c;\nexport const connect = (m: unknown) => <T>(c: T): T => c;\n');
    writeFileSync(
      join(dir, 'button.tsx'),
      "import { connect, memo } from './wrap';\n\nfunction Button() {\n  return null;\n}\nfunction mapState() {\n  return {};\n}\nexport default connect(mapState)(memo(Button));\n",
    );
    writeFileSync(join(dir, 'page.tsx'), "import Button from './button';\n\nexport function Page() {\n  return <Button />;\n}\n");
    const repo = await Workspace.open(dir);
    try {
      expect((await calls(repo, 'sum.ts#total')).text.split('\n').slice(1)).toEqual(['main.ts#run  4']);
      expect((await calls(repo, 'cli.ts#default')).text.split('\n').slice(1)).toEqual(['start.ts (top level)  3']);
      expect((await calls(repo, 'button.tsx#Button')).text.split('\n').slice(1)).toEqual(['button.tsx (top level)  9', 'page.tsx#Page  4']);
      // The wrappers' other arguments are not what renders.
      expect((await calls(repo, 'button.tsx#mapState')).text.split('\n').slice(1)).toEqual(['button.tsx (top level)  9']);
    } finally {
      await repo.close();
    }
  }, 30_000);
});

describe('calls of an override whose base is imported under another name', () => {
  it("counts the base class's this.m() as a caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-base-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "allowJs": true, "checkJs": false }, "include": ["*.js"] }');
    writeFileSync(join(dir, 'base.js'), 'export default class BaseAuth {\n  find() {\n    return this.user();\n  }\n  user() {}\n}\n');
    writeFileSync(join(dir, 'line.js'), "import Base from './base';\n\nclass Line extends Base {\n  user() {\n    return 1;\n  }\n}\nexport default new Line();\n");
    const repo = await Workspace.open(dir);
    try {
      expect((await calls(repo, 'line.js#Line.user')).text.split('\n').slice(1)).toEqual(['base.js#BaseAuth.find  3']);
    } finally {
      await repo.close();
    }
  }, 30_000);
});

describe('impact', () => {
  it('lists a caller reached through two changed callees once, with the lines of both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-impact-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "include": ["*.ts"] }');
    writeFileSync(join(dir, 'jobs.ts'), 'export function one() {\n  return 1;\n}\nexport function two() {\n  return 2;\n}\n');
    writeFileSync(join(dir, 'main.ts'), "import { one, two } from './jobs';\n\none();\ntwo();\n");
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'jobs.ts'), 'export function one() {\n  return 3;\n}\nexport function two() {\n  return 4;\n}\n');
    const jobs = await Workspace.open(dir);
    try {
      expect((await impact(jobs)).text.split('\n')).toContain('caller 1  main.ts (top level)  3, 4  ← one, two');
    } finally {
      await jobs.close();
    }
  }, 30_000);

  it("follows a base constructor's this.m() only to new on the subclass whose override changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-impact-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "include": ["*.ts"] }');
    const routers = (log: string) => [
      'export class Router {',
      '  constructor() { this.mount(); }',
      '  mount() {}',
      '}',
      'export class Logs extends Router {',
      `  mount() { ${log} }`,
      '}',
      'export class Pages extends Router {}',
      'export class Deep extends Logs {}',
      'export function build() { return [new Logs(), new Deep()]; }',
      'export function pages() { return [new Pages(), new Router()]; }',
    ];
    writeFileSync(join(dir, 'routers.ts'), `${routers('').join('\n')}\n`);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'routers.ts'), `${routers('return 1;').join('\n')}\n`);
    const repo = await Workspace.open(dir);
    try {
      expect((await impact(repo)).text.split('\n').slice(1)).toEqual([
        'changed  routers.ts#Logs.mount  6',
        'caller 1  routers.ts#Router.constructor  2  ← mount',
        'caller 2  routers.ts#build  10  ← constructor',
      ]);
    } finally {
      await repo.close();
    }
  }, 30_000);

  it("counts a change in a nested function as one in the function around it, whose callers it reaches", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-impact-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "include": ["*.ts"] }');
    const app = (body: string) => `export function app() {\n  const save = () => {\n    return ${body};\n  };\n  return save();\n}\n`;
    writeFileSync(join(dir, 'app.ts'), app('1'));
    writeFileSync(join(dir, 'main.ts'), "import { app } from './app';\n\napp();\n");
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'app.ts'), app('2'));
    const repo = await Workspace.open(dir);
    try {
      expect((await impact(repo)).text.split('\n')).toEqual(
        expect.arrayContaining(['changed  app.ts#app.save  2', 'changed  app.ts#app  1', 'caller 1  main.ts (top level)  3  ← app']),
      );
    } finally {
      await repo.close();
    }
  }, 30_000);

  it('names the changed symbol, its callers and the tests among them', async () => {
    writeFileSync(join(root, 'total.ts'), 'export function total(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 1);\n}\n');
    const result = await impact(ws);
    expect(result.text.split('\n')).toEqual([
      'impact · since HEAD · 1 symbol changed in 1 file · 1 test file · lsp · complete',
      'changed  total.ts#total  1',
      'caller 1  checkout.ts#checkout  4  ← total',
      'caller 2  checkout.test.ts (top level)  3  ← checkout',
      'test  checkout.test.ts',
    ]);
  }, 30_000);
});
