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
  it('offers ten tools whose list stays small', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'batch',
      'calls',
      'def',
      'find',
      'grep',
      'impact',
      'outline',
      'read',
      'refs',
      'status',
    ]);
    expect(countTokens(JSON.stringify(tools))).toBeLessThan(1000);
  });

  it('finds, reads and outlines symbols', async () => {
    expect(await call('find', { query: 'calc total' })).toContain('src/cart/total.ts#calculateTotal');
    const body = await call('read', { target: 'calculateTotal' });
    expect(body.split('\n').slice(1)).toEqual([
      'export function calculateTotal(items: CartItem[]): number {',
      '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
      '}',
    ]);
    expect(await call('outline', { path: 'src/auth/token-store.ts' })).toContain('method save');
  });

  it('answers references and definitions from the compiler', async () => {
    const answer = await call('refs', { target: 'calculateTotal' });
    expect(answer).toBe(
      ['src/cart/total.ts#calculateTotal · 4 refs in 2 files · lsp', 'src/cart/checkout.ts  1, 10·checkout', 'test/cart.test.ts  1, 5'].join('\n'),
    );
    expect(await call('def', { file: 'src/cart/checkout.ts', line: 10, column: 20 })).toContain(
      'src/cart/total.ts#calculateTotal  function 4',
    );
  }, 30_000);

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

  it('runs several calls in one batch', async () => {
    const answer = await call('batch', {
      calls: [
        { tool: 'find', args: { query: 'TokenStore' } },
        { tool: 'read', args: { target: 'calculateTax', mode: 'signature' } },
        { tool: 'read', args: {} },
      ],
    });
    expect(answer).toContain('## 1. find\n');
    expect(answer).toContain('## 2. read\nsrc/cart/total.ts#calculateTax  function calculateTax');
    expect(answer).toContain('## 3. read\ncsyk:');
  });

  it('says what is wrong instead of failing', async () => {
    expect(await call('read', { target: 'noSuchThing' })).toContain('no symbol named noSuchThing');
    expect(await call('def', {})).toContain('pass a target');
  });
});
