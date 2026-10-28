import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LspClient } from './lsp-client.ts';
import { servers } from './lsp-service.ts';

const pyright = servers.find((s) => s.name === 'pyright')?.command();

describe('LspClient', () => {
  // pyright answers nothing for a file asked about before its didOpen arrives.
  it('opens a file once before any of the requests made on it at once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'csyk-lsp-'));
    writeFileSync(join(root, 'greet.py'), 'def greet():\n    return 1\n');
    writeFileSync(join(root, 'use.py'), 'from greet import greet\n\ngreet()\ngreet()\ngreet()\n');
    if (!pyright) throw new Error('pyright is a dependency and always installed');
    const lsp = await LspClient.start(pyright.command, pyright.args, root);
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
