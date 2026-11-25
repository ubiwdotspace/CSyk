import { describe, expect, it } from 'vitest';
import { ConceptIndex, terms } from './concepts.ts';
import type { CodeSymbol } from './symbols.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const symbol = (file: string, name: string, line: number, kind: CodeSymbol['kind'] = 'function'): CodeSymbol => ({
  id: `${file}#${name}`, name, kind, lang: 'ts', file, line, range: [line, line + 2], signature: `function ${name}()`, exported: true, isTest: false,
});

describe('terms', () => {
  it('splits names and words, stems them and leaves stop words out', () => {
    expect(terms('where are refreshAccessToken tokens refreshed')).toEqual(['refresh', 'access', 'token', 'token', 'refresh']);
  });
});

describe('ConceptIndex', () => {
  it('finds code by what its name, comment and body say, a synonym at half weight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'csyk-concepts-'));
    writeFileSync(join(root, 'gzip.ts'), '// Compress gzips the response body.\nexport function Compress() {\n  return 1;\n}\n');
    writeFileSync(join(root, 'store.ts'), 'export function createStore() {\n  return {};\n}\nexport type StoreOptions = {};\n');
    const index = await ConceptIndex.build(root, [symbol('gzip.ts', 'Compress', 2), symbol('store.ts', 'createStore', 1), symbol('store.ts', 'StoreOptions', 4, 'type')]);
    expect(index.search('gzip the responses')[0]?.symbol.name).toBe('Compress');
    // "make" finds create; the function ranks before the type.
    expect(index.search('make a store').map((r) => r.symbol.name)).toEqual(['createStore', 'StoreOptions']);
  });
});
