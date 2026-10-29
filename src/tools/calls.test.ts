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
});

describe('impact', () => {
  it('names the changed symbol, its callers and the tests among them', async () => {
    writeFileSync(join(root, 'total.ts'), 'export function total(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 1);\n}\n');
    const result = await impact(ws);
    expect(result.text.split('\n')).toEqual([
      'impact · since HEAD · 1 symbol changed in 1 file · 1 test file · lsp',
      'changed  total.ts#total  1',
      'caller 1  checkout.ts#checkout  4  ← total',
      'caller 2  checkout.test.ts (top level)  3  ← checkout',
      'test  checkout.test.ts',
    ]);
  }, 30_000);
});
