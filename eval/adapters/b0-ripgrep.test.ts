import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { b0Ripgrep, parseHits } from './b0-ripgrep.ts';

const corpus = {
  name: 'mini-ts',
  root: join(dirname(fileURLToPath(import.meta.url)), '../fixtures/mini-ts'),
};

describe('parseHits', () => {
  it('reads repo-relative file and line from ripgrep lines', () => {
    expect(parseHits('./src/a.ts:12:const a = 1;\nsrc/b.ts:3:x:y\n\n')).toEqual([
      { file: 'src/a.ts', line: 12 },
      { file: 'src/b.ts', line: 3 },
    ]);
  });
});

describe('b0Ripgrep', () => {
  it('greps for a definition, then reads the first matching file', async () => {
    const result = await b0Ripgrep.run(
      { id: 'A1', category: 'A', query: 'refreshAccessToken', expect: [] },
      corpus,
    );
    // Grep has no ranking: the import in api/ comes before the declaration.
    expect(result.hits[0]).toEqual({ file: 'src/api/client.ts', line: 1 });
    expect(result.hits).toContainEqual({ file: 'src/auth/token-store.ts', line: 25 });
    expect(result.calls).toBe(2);
    expect(result.output).toContain('exchangeRefreshToken');
  });

  it('answers references with the grep lines alone', async () => {
    const result = await b0Ripgrep.run(
      { id: 'C1', category: 'C', query: 'calculateTax', expect: [] },
      corpus,
    );
    expect(result.calls).toBe(1);
    expect(result.hits.map((hit) => hit.file)).toEqual([
      'src/cart/checkout.ts',
      'src/cart/checkout.ts',
      'src/cart/total.ts',
    ]);
  });

  it('finds nothing for a name it cannot spell', async () => {
    const result = await b0Ripgrep.run(
      { id: 'B1', category: 'B', query: 'token store', expect: [] },
      corpus,
    );
    expect(result).toEqual({ hits: [], output: '', calls: 1 });
  });
});
