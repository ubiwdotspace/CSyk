import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCaseFiles } from '../harness/cases.ts';
import { TsOracle } from './ts-oracle.ts';

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let oracle: TsOracle;

beforeAll(async () => {
  oracle = await TsOracle.start(join(evalDir, 'fixtures/mini-ts'));
}, 60_000);
afterAll(() => oracle.stop());

// The mini-ts cases were written by hand; the oracle must agree with them.
describe('TsOracle on mini-ts', () => {
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
