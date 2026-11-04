import { execFile, execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { repoRelative } from '../paths.ts';

const run = promisify(execFile);

/**
 * Folders of dependencies and builds. Outside git they are left out of the index, the watcher
 * and `grep`; in a git repository `.gitignore` decides, as a tracked `build/` can be the
 * project's own code (vscode's build scripts).
 */
export const dependencyDirs = ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.dart_tool', 'vendor', 'target', '.venv', 'venv', '__pycache__', 'Pods', '.gradle'];

/**
 * Files that say nothing about the code, even when committed: lock files, minified and
 * source-map output, test snapshots. `grep` leaves them out unless asked for one by path.
 */
export const generatedFiles = ['*.lock', '*-lock.json', '*-lock.yaml', 'go.sum', '*.min.js', '*.min.mjs', '*.min.cjs', '*.min.css', '*.map', '*.snap'];

/**
 * Files that hold secrets: env files, keys, certificates, cloud credentials. `grep` leaves them
 * out, so a search for a name like API_KEY does not bring a key's value into the agent's
 * context unasked; only a `path` that names one searches it. They are never indexed (no code).
 */
export const secretFiles = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '*.tfvars',
  '*.tfstate',
  'credentials.json',
  '*service-account*.json',
  '*serviceAccount*.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
];

/** Minified sources: one line of a whole library, never the project's code to read. */
export const isMinified = (file: string) => /\.min\.[cm]?js$/.test(file);

const skipped = new Set(dependencyDirs);
const inGit = new Map<string, boolean>();

/** Whether [root] is inside a git working tree; asked once per root. */
export function inGitRepo(root: string): boolean {
  let known = inGit.get(root);
  if (known === undefined) {
    try {
      known = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true';
    } catch {
      known = false;
    }
    inGit.set(root, known);
  }
  return known;
}

/**
 * ripgrep's arguments for a search of [path] in [root] that leaves out what is not the project's
 * code: generated files and files that hold secrets; outside git, also the dependency folders
 * and the project's own `.gitignore`, never a parent folder's (read past a repository's root,
 * a parent's `eval/corpora/` hid a whole checked-out repository). In git, ripgrep reads the
 * repository's ignore files as git does. A search aimed inside a dependency folder, or at one
 * such file by name, keeps them.
 */
export function searchSkips(root: string, path = '.'): string[] {
  const parts = path.split(/[\\/]/);
  const intoDependency = parts.some((part) => skipped.has(part));
  const base = parts.at(-1) ?? '';
  const named = [...generatedFiles, ...secretFiles].some((glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(base));
  const git = inGitRepo(root);
  const globs = [
    ...(intoDependency || git ? [] : dependencyDirs.map((dir) => `!**/${dir}/**`)),
    ...(named ? [] : [...generatedFiles, ...secretFiles].map((glob) => `!${glob}`)),
  ];
  return [...(git ? [] : ['--no-require-git', '--no-ignore-parent']), ...globs.flatMap((glob) => ['--glob', glob])];
}

/**
 * The workspace's files with one of [extensions], repo-relative and sorted.
 * In a git repo these are tracked and untracked files minus ignored ones;
 * elsewhere, a walk that skips dependency and build folders.
 */
export async function listFiles(root: string, extensions: ReadonlySet<string>): Promise<string[]> {
  const files = await gitFiles(root).catch(() => walk(root, root));
  return files.filter((file) => extensions.has(extname(file)) && !file.endsWith('.d.ts') && !isMinified(file)).sort();
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
    else if (entry.isFile()) files.push(repoRelative(root, path));
  }
  return files;
}
