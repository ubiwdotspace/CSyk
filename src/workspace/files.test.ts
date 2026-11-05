import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../token/session.ts';
import { runTool } from '../tools/dispatch.ts';
import { listFiles } from './files.ts';
import { Workspace } from './workspace.ts';

// One project laid out twice, outside git and in it: its code, a dependency, a build, and
// files that say nothing about the code, each naming `needle`.
const layout: Record<string, string> = {
  'src/app.ts': 'export function needle() { return 1; }',
  'build/tool.ts': 'export const needleTool = 1;',
  'node_modules/dep/index.js': 'exports.needle = 1;',
  'package-lock.json': '{ "needle": "1.0.0" }',
  'src/vendor.min.js': 'var needle=1;',
  'src/__snapshots__/app.snap': 'exports[`needle`] = 1;',
  'config/server.pem': '-----BEGIN PRIVATE KEY----- needle',
  'deploy/credentials.json': '{ "needle": "secret" }',
  'infra/prod.tfvars': 'needle = "secret"',
};

const project = (git: boolean) => {
  const root = mkdtempSync(join(tmpdir(), `csyk-skips-${git ? 'git' : 'plain'}-`));
  for (const [file, text] of Object.entries(layout)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  if (git) {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
  }
  return root;
};

const opened: Workspace[] = [];
const grepIn = async (root: string, args: object = {}) => {
  const ws = Workspace.start(root, {});
  opened.push(ws);
  await ws.ready;
  const text = (await runTool(ws, 'grep', { pattern: 'needle', ...args }, new Session())).text;
  return ['src/app.ts', 'build/tool.ts', 'node_modules/dep/index.js', 'package-lock.json', 'src/vendor.min.js', 'app.snap', 'server.pem', 'credentials.json', 'prod.tfvars'].filter((f) =>
    text.includes(f),
  );
};

beforeAll(() => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'csyk-cache-'));
});
afterAll(async () => {
  for (const ws of opened) await ws.close();
});

describe('what is not the project code', () => {
  it('outside git, grep leaves out dependency and build folders, generated files and secrets', async () => {
    expect(await grepIn(project(false))).toEqual(['src/app.ts']);
  });

  it('in git, .gitignore decides on folders: a tracked build/ is code', async () => {
    expect(await grepIn(project(true))).toEqual(['src/app.ts', 'build/tool.ts']);
  });

  it("a repository inside another is searched by its own .gitignore, not the outer one's", async () => {
    // As provider checked out under CSyk's eval/corpora/: CSyk's `packages/` (its standalone
    // builds) matched provider's packages/, where all its code is, and grep found nothing.
    const parent = mkdtempSync(join(tmpdir(), 'csyk-parent-'));
    writeFileSync(join(parent, '.gitignore'), 'packages/\n');
    execFileSync('git', ['init', '-q'], { cwd: parent });
    const root = join(parent, 'corpora', 'project');
    mkdirSync(join(root, 'packages/app/src'), { recursive: true });
    writeFileSync(join(root, 'packages/app/src/app.ts'), 'export function needle() { return 1; }');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const ws = Workspace.start(root, {});
    opened.push(ws);
    await ws.ready;
    expect((await runTool(ws, 'grep', { pattern: 'needle' }, new Session())).text).toContain('packages/app/src/app.ts');
  });

  it('a search aimed at a dependency, a generated file or a secrets file by name still finds it', async () => {
    const root = project(false);
    expect(await grepIn(root, { path: 'node_modules/dep' })).toEqual(['node_modules/dep/index.js']);
    expect(await grepIn(root, { path: 'package-lock.json' })).toEqual(['package-lock.json']);
    expect(await grepIn(root, { path: 'infra/prod.tfvars' })).toEqual(['prod.tfvars']);
  });

  it('the index leaves out minified sources and, outside git, dependency folders', async () => {
    const files = await listFiles(project(false), new Set(['.ts', '.js']));
    expect(files).toEqual(['src/app.ts']);
  });
});
