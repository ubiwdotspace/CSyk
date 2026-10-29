import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractMarkdown } from '../index/extract/markdown.ts';
import { Session } from '../token/session.ts';
import { Workspace } from '../workspace/workspace.ts';
import { runTool } from './dispatch.ts';

const spec = [
  '# Product spec',
  '',
  '## Greeting screen',
  'The screen calls greet with the user name.',
  '',
  '```sh',
  '# a comment, not a heading',
  '```',
  '',
  '## Wallet modal',
  'Opens in place.',
].join('\n');

let ws: Workspace;
const ask = (tool: Parameters<typeof runTool>[1], args: object) => runTool(ws, tool, args, new Session()).then((r) => r.text);

beforeAll(async () => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'csyk-cache-'));
  const root = mkdtempSync(join(tmpdir(), 'csyk-other-'));
  const files: Record<string, string | Buffer> = {
    '.gitignore': 'gen/\n',
    'src/app.ts': [
      "import { generatedThing } from '../gen/messages';",
      'export function greet(name: string) { return `hi ${name}`; }',
      "export const logo = 'assets/brand/logo.png';",
      'export function show() { return generatedThing(); }',
    ].join('\n'),
    'gen/messages.ts': "export function generatedThing() { return 'x'; }",
    'gen/strings.ts': 'export abstract class Strings {\n  abstract get title(): string;\n}\nexport class StringsEn extends Strings {\n  get title() { return "Hi"; }\n}',
    'docs/spec.md': spec,
    'config.json': '{ "greeting": "greet" }',
    'assets.yaml': 'assets:\n  - assets/brand/\n',
    'assets/brand/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  ws = await Workspace.open(root);
});

afterAll(() => ws.close());

describe('files that are not code', () => {
  it('finds a doc section by its title and reads that section alone', async () => {
    expect(await ask('find', { query: 'wallet modal' })).toContain('docs/spec.md#Wallet modal  section 10');
    const section = await ask('read', { target: 'docs/spec.md#Greeting screen' });
    expect(section).toContain('The screen calls greet');
    expect(section).not.toContain('Opens in place');
  });

  it('reads a config whole and says what a binary file is', async () => {
    expect(await ask('read', { target: 'config.json' })).toContain('"greeting": "greet"');
    expect(await ask('read', { target: 'assets/brand/logo.png' })).toMatch(/^assets\/brand\/logo\.png · binary, 1 KB/);
    expect(await ask('read', { target: '../outside.txt' })).not.toContain('lines');
  });

  it('lists where a file is named, by its name or its folder', async () => {
    const text = await ask('refs', { target: 'assets/brand/logo.png' });
    expect(text).toContain("src/app.ts:3  logo  export const logo = 'assets/brand/logo.png';");
    expect(text).toContain('assets.yaml:2');
  });

  it('adds the mentions of a symbol outside code to its references', async () => {
    expect(await ask('refs', { target: 'greet' })).toMatch(/outside code: config\.json:1, docs\/spec\.md:4$/);
  }, 30_000);

  it('finds a symbol declared in generated code that git ignores', async () => {
    expect(await ask('find', { query: 'generatedThing' })).toContain('gen/messages.ts#generatedThing  function');
  });

  it('takes the declaration an override overrides, when a name has both', async () => {
    expect(await ask('read', { target: 'title', mode: 'signature' })).toBe('gen/strings.ts#Strings.title  abstract get title(): string');
  });

  it('lists doc hits after code hits in grep', async () => {
    const lines = (await ask('grep', { pattern: 'greet' })).split('\n');
    expect(lines.findIndex((l) => l.startsWith('src/app.ts'))).toBeLessThan(lines.findIndex((l) => l.startsWith('docs/spec.md')));
  });
});

describe('extractMarkdown', () => {
  it('spans each section to the next heading of its level, ignoring # in fenced code', () => {
    expect(extractMarkdown('spec.md', spec).map((s) => `${s.name} ${s.range.join('-')}`)).toEqual([
      'Product spec 1-11',
      'Greeting screen 3-8',
      'Wallet modal 10-11',
    ]);
  });
});
