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
    // The path is given once, above its hits.
    expect(answer.text.split('\n')[1]).toBe('one.ts');
    expect(answer.text.match(/^ {2}\d+ {2}one/gm)).toHaveLength(12);
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
    expect((await runTool(ws, 'grep', { pattern: 'needle' }, long)).text).toBe('1 hit in 1 place · text · complete\nbig.ts:101  big  const needle = 1;');
    await ws.close();
  });

  it('greps the lines around the first hits, and the text of the hits past them', async () => {
    const body = Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? `  const needle${i} = ${i};` : `  const x${i} = ${i};`));
    const ws = await Workspace.open(folder({ 'big.ts': ['export function big() {', ...body, '}'].join('\n') }));
    const answer = (await runTool(ws, 'grep', { pattern: 'needle' }, new Session())).text;
    expect(answer).toContain('big.ts · lines 1-12\nexport function big() {');
    expect(answer).toMatch(/^ {2}2 {2}big$/m);
    expect(answer).toContain('  382  big  const needle380 = 380;');
    await ws.close();
  });

  it('greps every hit with its text, else every line per symbol, else every file with its count', async () => {
    const grepIn = async (files: Record<string, string>) => {
      const ws = await Workspace.open(folder(files));
      const answer = (await runTool(ws, 'grep', { pattern: 'needle' }, new Session())).text;
      await ws.close();
      return answer;
    };
    const long = `'needle ${'x'.repeat(100)}'`;
    const listed = await grepIn(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.ts`, `export const n${i} = 'needle';`])));
    expect(listed).toMatch(/^40 hits in 40 places · text · complete\n/);
    expect(listed).toContain("f39.ts:1  n39  export const n39 = 'needle';");
    const body = Array.from({ length: 150 }, (_, i) => `  const v${i} = ${long};`);
    const lines = await grepIn({ 'big.ts': ['export function big() {', ...body, '}'].join('\n') });
    expect(lines).toMatch(/^150 hits in 1 place · text · lines per symbol · complete\nbig\.ts {2}big 2, 3, 4, /);
    const summed = await grepIn(Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`feature${i}_module.ts`, `export const n${i} = ${long};`])));
    expect(summed).toMatch(/^600 hits in 600 files · text · files with the most hits first/);
  });

  it('answers a miss in the given file with a brief list of the hits elsewhere, without source', async () => {
    const callers = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`c${i}.ts`, `export function c${i}() {\n  return 'needle ${i}';\n}`]),
    );
    const lone = "export function one() {\n  return 'lonely';\n}";
    const ws = await Workspace.open(folder({ ...callers, 'one.ts': lone, 'other.ts': 'export const other = 1;' }));
    const answer = (await runTool(ws, 'grep', { pattern: 'needle', path: 'other.ts' }, new Session())).text;
    expect(answer).toMatch(/^no match in other\.ts; everywhere: 20 hits in 20 places · text · complete\n/);
    expect(estimateTokens(answer)).toBeLessThanOrEqual(400);
    // A hit in one small function, which a grep there would bring the source of.
    expect((await runTool(ws, 'grep', { pattern: 'lonely', path: 'other.ts' }, new Session())).text).toBe(
      "no match in other.ts; everywhere: 1 hit in 1 place · text · complete\none.ts:2  one  return 'lonely';",
    );
    await ws.close();
  });

  it('reads several targets, comma-separated, in one answer', async () => {
    const ws = await Workspace.open(folder({ 'a.ts': 'export function one() {\n  return 1;\n}\nexport function two() {\n  return 2;\n}', 'b.json': '{ "x": 1 }' }));
    const answer = await runTool(ws, 'read', { target: 'a.ts#one, two , b.json' }, new Session());
    expect(answer.text).toContain('a.ts#one · lines 1-3\nexport function one() {');
    expect(answer.text).toContain('a.ts#two · lines 4-6\nexport function two() {');
    expect(answer.text).toContain('b.json · lines 1-1\n{ "x": 1 }');
    expect(answer.locations).toHaveLength(3);
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
