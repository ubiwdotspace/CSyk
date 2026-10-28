import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { Workspace } from './workspace.ts';

const folder = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'csyk-ws-'));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  return root;
};

describe('Workspace', () => {
  it('starts from the saved index, parsing only files that changed', async () => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'csyk-cache-'));
    const root = folder({ 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 2;' });
    await (await Workspace.open(root, { persist: true })).close();
    writeFileSync(join(root, 'b.ts'), 'export const b = 3;\nexport const c = 4;');
    const ws = await Workspace.open(root, { persist: true });
    expect(ws.index.reused).toBe(1);
    expect(ws.index.named('c')).toHaveLength(1);
    await ws.close();
  });

  // File system events can lag on a busy machine; the test retries rather than wait longer.
  it('indexes a file written while it watches', { retry: 2, timeout: 15_000 }, async () => {
    const root = folder({ 'a.ts': 'export const a = 1;' });
    const ws = await Workspace.open(root, { watch: true });
    try {
      writeFileSync(join(root, 'b.ts'), 'export function fresh() {}');
      // The change arrives as a file system event; a tool call flushes it.
      for (let i = 0; i < 200 && ws.index.named('fresh').length === 0; i++) {
        await sleep(50);
        await ws.fresh();
      }
      expect(ws.index.named('fresh')).toHaveLength(1);
    } finally {
      await ws.close();
    }
  });
});
