import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LspClient } from './lsp-client.ts';

const pyright = join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/pyright-langserver');

describe('LspClient', () => {
  // pyright answers nothing for a file asked about before its didOpen arrives.
  it('opens a file once before any of the requests made on it at once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'csyk-lsp-'));
    writeFileSync(join(root, 'greet.py'), 'def greet():\n    return 1\n');
    writeFileSync(join(root, 'use.py'), 'from greet import greet\n\ngreet()\ngreet()\ngreet()\n');
    const lsp = await LspClient.start(pyright, ['--stdio'], root);
    try {
      const spans = await Promise.all(
        [2, 3, 4].map((line) => lsp.definition({ file: 'use.py', line, character: 1 })),
      );
      expect(spans.map((s) => `${s[0]?.file}:${s[0]?.nameLine}`)).toEqual(['greet.py:0', 'greet.py:0', 'greet.py:0']);
    } finally {
      await lsp.stop();
    }
  }, 30_000);
});
