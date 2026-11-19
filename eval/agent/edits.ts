import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Edit tasks: the agent changes code (a rename, a new parameter) in a git worktree of the corpus,
 * so the corpus stays as pinned, and the task passes when the compiler finds no more errors than
 * before the edit and the diff has what the task asks for. What it measures besides tokens: how
 * often the agent ran a compiler or the tests itself, which `impact` is meant to spare it.
 */
export type Check = 'tsc' | 'go' | 'pyright' | 'dart';

const csyk = join(import.meta.dirname, '../..');

/** A fresh worktree of [root] at HEAD for [name], with the corpus's installed dependencies. */
export async function worktree(root: string, name: string): Promise<string> {
  // Named by a hash: the agent sees its own path, which must not say the setup.
  const dir = join(tmpdir(), 'csyk-edits', createHash('sha1').update(name).digest('hex').slice(0, 12));
  await remove(root, dir);
  await mkdir(join(tmpdir(), 'csyk-edits'), { recursive: true });
  await run('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, 'HEAD']);
  // What an install made and git leaves out: node_modules linked, Dart's package config copied
  // (its paths are relative to it).
  for (const base of ['.', ...(await subdirs(root, 'packages')), ...(await subdirs(root, 'backend'))]) {
    if (existsSync(join(root, base, 'node_modules')) && !existsSync(join(dir, base, 'node_modules'))) await run('ln', ['-s', join(root, base, 'node_modules'), join(dir, base, 'node_modules')]);
    if (existsSync(join(root, base, '.dart_tool'))) await cp(join(root, base, '.dart_tool'), join(dir, base, '.dart_tool'), { recursive: true });
  }
  return dir;
}

export async function remove(root: string, dir: string): Promise<void> {
  await run('git', ['-C', root, 'worktree', 'remove', '--force', dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await run('git', ['-C', root, 'worktree', 'prune']).catch(() => {});
}

async function subdirs(root: string, folder: string): Promise<string[]> {
  return (await readdir(join(root, folder), { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .map((d) => `${folder}/${d.name}`);
}

/** The compiler errors in [dir] (under [inside]), as [check] counts them. */
export async function errorCount(check: Check, dir: string, inside = '.'): Promise<number> {
  const cwd = join(dir, inside);
  const out = async (command: string, args: string[]) =>
    run(command, args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 600_000 }).then(
      (r) => r.stdout + r.stderr,
      (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`,
    );
  if (check === 'tsc') {
    // The project's own config, without the type packages a corpus has not installed.
    const config = join(tmpdir(), 'csyk-edits', `tsconfig-${Buffer.from(cwd).toString('hex').slice(-24)}.json`);
    await writeFile(config, JSON.stringify({ extends: join(cwd, 'tsconfig.json'), compilerOptions: { types: [], noEmit: true } }));
    const text = await out(process.execPath, [join(csyk, 'node_modules/typescript/bin/tsc'), '-p', config]);
    return (text.match(/error TS\d+/g) ?? []).length;
  }
  if (check === 'go') return (await out('go', ['vet', './...'])).split('\n').filter((l) => /^(vet: )?\.?\/?[\w./-]+\.go:\d+:\d+: /.test(l)).length;
  if (check === 'dart') return (await out('dart', ['analyze', '--no-fatal-warnings', '.'])).split('\n').filter((l) => /^\s*error - /.test(l)).length;
  const json = await out(process.execPath, [join(csyk, 'node_modules/pyright/index.js'), '--outputjson', '.']);
  try {
    const start = json.indexOf('{');
    const d = JSON.parse(json.slice(start)) as { generalDiagnostics: { severity: string }[] };
    return d.generalDiagnostics.filter((x) => x.severity === 'error').length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The working tree's changes in [dir], as `git diff` prints them. */
export async function diffOf(dir: string): Promise<string> {
  return (await run('git', ['-C', dir, 'diff', '--no-color'], { maxBuffer: 256 * 1024 * 1024 })).stdout;
}

/** The commands among [commands] that run a compiler, a type checker or tests. */
export const compilerRuns = (commands: readonly string[]) =>
  commands.filter((c) => /\b(tsc|go (build|vet|test)|dart (analyze|test)|flutter (analyze|test)|pyright|mypy|pytest|vitest|jest|npm (run |)(test|build|typecheck|lint)|pnpm (run |)(test|build|typecheck))\b/.test(c));
