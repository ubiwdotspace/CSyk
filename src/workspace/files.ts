import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Folders that never hold the project's own sources.
const skipped = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next']);

/**
 * The workspace's files with one of [extensions], repo-relative and sorted.
 * In a git repo these are tracked and untracked files minus ignored ones;
 * elsewhere, a walk that skips dependency and build folders.
 */
export async function listFiles(root: string, extensions: ReadonlySet<string>): Promise<string[]> {
  const files = await gitFiles(root).catch(() => walk(root, root));
  return files.filter((file) => extensions.has(extname(file)) && !file.endsWith('.d.ts')).sort();
}

async function gitFiles(root: string): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}

async function walk(root: string, dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}
