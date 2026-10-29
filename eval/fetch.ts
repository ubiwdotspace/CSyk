import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpora } from './harness/corpora.ts';

/**
 * `npm run corpora`: checks out every corpus that names a git URL, at its
 * pinned commit and with no history, into its path. A checkout already
 * there is left alone once its HEAD is the pinned commit.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

for (const corpus of (await loadCorpora(root)).values()) {
  if (!corpus.git || !corpus.commit) continue;
  if (existsSync(join(corpus.root, '.git'))) {
    const head = git(corpus.root, 'rev-parse', 'HEAD');
    if (!head.startsWith(corpus.commit)) {
      throw new Error(`${corpus.name}: ${corpus.root} is at ${head}, not ${corpus.commit}; remove it to refetch`);
    }
    console.log(`${corpus.name}: already at ${corpus.commit.slice(0, 9)}`);
    continue;
  }
  mkdirSync(corpus.root, { recursive: true });
  git(corpus.root, 'init', '--quiet');
  git(corpus.root, 'remote', 'add', 'origin', corpus.git);
  git(corpus.root, 'fetch', '--quiet', '--depth', '1', 'origin', corpus.commit);
  git(corpus.root, 'checkout', '--quiet', 'FETCH_HEAD');
  console.log(`${corpus.name}: fetched ${corpus.commit.slice(0, 9)} into ${corpus.root.slice(root.length + 1)}`);
}
