import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCaseFiles } from '../harness/cases.ts';
import { LspOracle } from './lsp-oracle.ts';

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let oracle: LspOracle;

beforeAll(async () => {
  oracle = await LspOracle.start(join(evalDir, 'fixtures/mini-ts'));
}, 60_000);
afterAll(() => oracle.stop());

// The mini-ts cases were written by hand; the oracle must agree with them.
describe('LspOracle on mini-ts', () => {
  it('finds the declarations the A cases expect', async () => {
    const [file] = (await loadCaseFiles(join(evalDir, 'cases'))).filter(
      (f) => f.corpus === 'mini-ts' && f.category === 'A',
    );
    for (const c of file?.cases ?? []) {
      const found = (await oracle.declarations(c.query)).map((d) => ({
        file: d.file,
        lines: [d.startLine + 1, d.endLine + 1],
      }));
      expect(found, c.id).toEqual(c.expect);
    }
  });

  it('finds the references the C cases expect, imports included', async () => {
    const [file] = (await loadCaseFiles(join(evalDir, 'cases'))).filter(
      (f) => f.corpus === 'mini-ts' && f.category === 'C',
    );
    for (const c of file?.cases ?? []) {
      const [declaration] = await oracle.declarations(c.query);
      const refs = await oracle.references(c.query, declaration!);
      expect(
        refs.map((r) => ({ file: r.file, lines: [r.line + 1, r.line + 1] })),
        c.id,
      ).toEqual(c.expect);
    }
  });

  it('names the symbol a message is written in', async () => {
    const home = await oracle.containing('src/auth/token-store.ts', 31);
    expect(home?.name).toBe('refreshAccessToken');
  });
});

describe('LspOracle with pyright', () => {
  it('finds callers in every file, decorators, tests and renamed imports included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'csyk-oracle-py-'));
    const files = {
      'shop.py': 'def checkout(f=None):\n    return f\n',
      'views.py': 'from shop import checkout\n\n\n@checkout(1)\ndef index():\n    pass\n\n\ndef page():\n    return checkout()\n',
      'tests/test_shop.py': 'from shop import checkout\n\n\ndef test_checkout():\n    assert checkout() is None\n',
      'cart.py': 'from shop import checkout as pay\n\n\ndef buy():\n    return pay()\n',
    };
    mkdirSync(join(root, 'tests'));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    // The oracle reads the files git tracks.
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    const py = await LspOracle.start(root, 'py');
    try {
      const callers = await py.calls({ file: 'shop.py', line: 0, character: 4 }, 'in');
      // The decorator's call is the module's to pyright's call hierarchy (line 1) and index's to its references.
      expect(callers.map((s) => `${s.file}:${s.startLine + 1}`).sort()).toEqual(['cart.py:4', 'tests/test_shop.py:4', 'views.py:1', 'views.py:4', 'views.py:9']);
    } finally {
      await py.stop();
    }
  }, 60_000);
});
