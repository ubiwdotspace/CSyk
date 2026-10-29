import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../token/budget.ts';
import { Session } from '../token/session.ts';
import { runTool } from '../tools/dispatch.ts';
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

  it('greps before the index is full, indexing the files it hits', async () => {
    const files = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`f${i}.ts`, `export function f${i}() {}`]));
    const root = folder({ ...files, 'z.ts': 'export function needle() {\n  return "find me";\n}' });
    const ws = Workspace.start(root);
    const answer = await runTool(ws, 'grep', { pattern: 'find me' }, new Session());
    expect(ws.complete).toBe(false);
    expect(answer.text).toContain('z.ts:2  needle');
    await ws.ready;
    await ws.close();
  });

  it('greps every hit in one function when all of them fit', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `  const v${i} = 'needle ${i}';`);
    const root = folder({ 'one.ts': ['export function one() {', ...lines, '}'].join('\n') });
    const ws = await Workspace.open(root);
    const answer = await runTool(ws, 'grep', { pattern: 'needle' }, new Session());
    expect(answer.text).toMatch(/^12 hits in 1 place · text/);
    expect(answer.text.match(/^one\.ts:\d+ {2}one/gm)).toHaveLength(12);
    expect(answer.text).not.toContain('more;');
    await ws.close();
  });

  it('greps with the lines around hits in a large function, unless the session is long', async () => {
    const body = Array.from({ length: 150 }, (_, i) => (i === 99 ? '  const needle = 1;' : `  const x${i} = ${i};`));
    const root = folder({ 'big.ts': ['export function big() {', ...body, '}'].join('\n') });
    const ws = await Workspace.open(root);
    const answer = await runTool(ws, 'grep', { pattern: 'needle' }, new Session());
    expect(answer.text).toContain('big.ts:101  big');
    expect(answer.text).toContain('big.ts · lines 96-111\n  const x94 = 94;');
    expect(answer.text.split('const needle = 1;')).toHaveLength(2);
    const long = new Session();
    long.spend(4000);
    expect((await runTool(ws, 'grep', { pattern: 'needle' }, long)).text).toBe('1 hit in 1 place · text\nbig.ts:101  big  const needle = 1;');
    await ws.close();
  });

  it('answers a miss in the given file with a brief list of the hits elsewhere, without source', async () => {
    const callers = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`c${i}.ts`, `export function c${i}() {\n  return 'needle ${i}';\n}`]),
    );
    const ws = await Workspace.open(folder({ ...callers, 'other.ts': 'export const other = 1;' }));
    const answer = (await runTool(ws, 'grep', { pattern: 'needle', path: 'other.ts' }, new Session())).text;
    expect(answer).toMatch(/^no match in other\.ts; everywhere: 20 hits in 20 files/);
    expect(answer).not.toContain("return 'needle");
    expect(estimateTokens(answer)).toBeLessThanOrEqual(400);
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
