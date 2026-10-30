import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countTokens } from '../../eval/harness/tokens.ts';
import { createServer } from './server.ts';

const miniTs = join(dirname(fileURLToPath(import.meta.url)), '../../eval/fixtures/mini-ts');
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  // The server saves its index; keep that out of the user's cache.
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'csyk-cache-'));
  const created = createServer(miniTs);
  close = created.close;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverSide);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
}, 30_000);

afterAll(async () => {
  await client.close();
  await close();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { text: string }[])[0]?.text ?? '';
};

describe('the MCP server', () => {
  it('offers six tools whose list stays small', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['calls', 'find', 'grep', 'impact', 'read', 'refs']);
    expect(countTokens(JSON.stringify(tools))).toBeLessThan(600);
  });

  it('finds, reads and outlines symbols', async () => {
    expect(await call('find', { query: 'calc total' })).toContain('src/cart/total.ts#calculateTotal');
    const body = await call('read', { target: 'calculateTotal' });
    expect(body.split('\n').slice(1)).toEqual([
      'export function calculateTotal(items: CartItem[]): number {',
      '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
      '}',
    ]);
    const file = await call('read', { target: 'src/auth/token-store.ts' });
    expect(file).toContain('src/auth/token-store.ts · lines 1-');
    expect(file).toContain("throw new Error('Session expired");
    expect(await call('read', { target: 'src/cart/total.ts:calculateTotal' })).toContain('src/cart/total.ts#calculateTotal');
    expect(await call('read', { target: 'src/auth/token-store.ts#save' })).toContain('save(');
    expect(await call('read', { target: 'src/cart/' })).toContain('src/cart/total.ts  calculateTotal');
  });

  it('answers references from the compiler', async () => {
    const answer = await call('refs', { target: 'calculateTotal' });
    expect(answer).toBe(
      ['src/cart/total.ts#calculateTotal · 4 refs in 2 files · lsp · complete', 'src/cart/checkout.ts  1, 10·checkout', 'test/cart.test.ts  1, 5'].join('\n'),
    );
  }, 30_000);

  it('reads what agents write for a place: file:line, Class.method, a wrong path', async () => {
    expect(await call('read', { target: 'src/auth/token-store.ts:30' })).toContain('src/auth/token-store.ts#refreshAccessToken · lines 25-37');
    expect(await call('read', { target: 'src/auth/token-store.ts:2-4' })).toBe(
      ['src/auth/token-store.ts · lines 2-4', 'export class TokenStore {', '  private access?: string;', '  private refresh?: string;'].join('\n'),
    );
    expect(await call('read', { target: 'TokenStore.clear' })).toContain('this.access = undefined;');
    expect(await call('read', { target: 'src/nope/token-store.ts' })).toContain('similar paths: src/auth/token-store.ts');
  });

  it('searches everywhere when grep misses in the folder it was given', async () => {
    for (const path of ['src/cart', 'src/missing']) {
      const answer = await call('grep', { pattern: 'Session expired', path });
      expect(answer).toContain(`no match in ${path}; everywhere: `);
      expect(answer).toContain('src/auth/token-store.ts:32');
    }
  });

  it('greps text and names the symbol around each hit', async () => {
    const answer = await call('grep', { pattern: 'Session expired' });
    expect(answer).toContain('src/auth/token-store.ts:32  refreshAccessToken');
    expect(await call('grep', { pattern: 'nothing like this' })).toContain('no match');
  });

  it('suggests near names when find has no hit', async () => {
    expect(await call('find', { query: 'calculateTotl' })).toContain('nearest: calculateTotal');
  });

  it('points to an unchanged body it already showed', async () => {
    const first = await call('read', { target: 'toTitleCase' });
    expect(first).toContain('export function toTitleCase');
    expect(await call('read', { target: 'toTitleCase' })).toMatch(/^\[unchanged: src\/utils\/strings.ts#toTitleCase, shown at call #\d+\]$/);
  });

  it('hints once per session', async () => {
    const hint = 'hint: read <id> for the body';
    const first = await call('find', { query: 'checkout' });
    const second = await call('find', { query: 'TokenStore' });
    expect([first, second].filter((text) => text.includes(hint))).toHaveLength(first.includes(hint) ? 1 : 0);
    expect(second).not.toContain(hint);
  });

  it('says what is wrong instead of failing', async () => {
    expect(await call('read', { target: 'noSuchThing' })).toContain('no symbol named noSuchThing');
  });
});
