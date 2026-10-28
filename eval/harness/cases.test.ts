import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCaseFiles, parseCaseFile } from './cases.ts';
import { loadCorpora } from './corpora.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('parseCaseFile', () => {
  const parse = (text: string, name = 'demo.A.yaml') => parseCaseFile(name, name, text);

  it('takes the corpus and category from the file name', () => {
    const file = parse('cases:\n  - id: A1\n    query: foo\n    expect: [{ file: src/a.ts, lines: [1, 2] }]\n');
    expect(file.corpus).toBe('demo');
    expect(file.cases[0]).toEqual({
      id: 'A1',
      category: 'A',
      query: 'foo',
      expect: [{ file: 'src/a.ts', lines: [1, 2] }],
    });
  });

  it('rejects bad names, repeated ids, paths outside the repo and inverted ranges', () => {
    const one = (expectYaml: string, id = 'A1') =>
      `  - id: ${id}\n    query: foo\n    expect: [${expectYaml}]\n`;
    expect(() => parse('cases: []', 'demo.yaml')).toThrow(/<corpus>\.<category>/);
    expect(() => parse(`cases:\n${one('{ file: a.ts }')}${one('{ file: a.ts }')}`)).toThrow(/repeats id/);
    expect(() => parse(`cases:\n${one('{ file: ../secret.ts }')}`)).toThrow(/repo-relative/);
    expect(() => parse(`cases:\n${one('{ file: a.ts, lines: [5, 2] }')}`)).toThrow(/\[first, last\]/);
    expect(() => parse('cases:\n  - id: A1\n    query: foo\n    expect: []\n')).toThrow(/expected location/);
  });
});

describe('the committed cases', () => {
  it('point at files and lines that exist in their corpus', async () => {
    const corpora = await loadCorpora(root);
    const files = await loadCaseFiles(join(root, 'eval/cases'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const corpus = corpora.get(file.corpus);
      expect(corpus, `corpus ${file.corpus}`).toBeDefined();
      // A fetched corpus is checked once `npm run corpora` has brought it in.
      if (!existsSync(corpus!.root)) continue;
      for (const c of file.cases) {
        for (const loc of c.expect) {
          const text = await readFile(join(corpus!.root, loc.file), 'utf8');
          const lineCount = text.split('\n').length;
          expect(loc.lines?.[1] ?? 1, `${c.id} ${loc.file}`).toBeLessThanOrEqual(lineCount);
        }
      }
    }
  });
});
