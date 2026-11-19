import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../token/session.ts';
import { Workspace } from '../workspace/workspace.ts';
import { runTool } from './dispatch.ts';

const miniTs = join(dirname(fileURLToPath(import.meta.url)), '../../eval/fixtures/mini-ts');
let ws: Workspace;

beforeAll(async () => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'csyk-cache-'));
  ws = await Workspace.open(miniTs);
}, 30_000);

afterAll(() => ws.close());

describe('read of a folder: its map', () => {
  it('ranks files by how much the rest imports them, with the names they are imported for', async () => {
    const text = (await runTool(ws, 'read', { target: '.' }, new Session())).text;
    const lines = text.split('\n');
    expect(lines[0]).toBe('./ · 8 files, most imported first (← files that import it) · names others import · 1 test files left out');
    expect(lines.slice(1, 3)).toEqual(['src/cart/types.ts  ← 3  CartItem', 'src/cart/total.ts  ← 3  calculateTotal, calculateTax']);
    expect((await runTool(ws, 'read', { target: 'src/cart/' }, new Session())).text).toMatch(/^src\/cart\/ · \d+ files/);
  });
});
