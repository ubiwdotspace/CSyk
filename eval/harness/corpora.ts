import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Corpus } from './types.ts';

/**
 * The corpora by name: `corpora.yaml` (committed, public) overlaid by
 * `corpora.local.yaml` (git-ignored), which points at private checkouts.
 * Each entry is `<name>: { path, commit?, git?, codesift? }`, the path
 * relative to the repo root or absolute. A commit pins the corpus: the
 * harness refuses to run its cases against any other. With `git`,
 * `npm run corpora` fetches that commit into the path. `codesift` names the
 * corpus's CodeSift repo for the B1 baseline.
 */
export async function loadCorpora(root: string): Promise<Map<string, Corpus>> {
  const corpora = new Map<string, Corpus>();
  for (const name of ['eval/corpora.yaml', 'eval/corpora.local.yaml']) {
    let text: string;
    try {
      text = await readFile(join(root, name), 'utf8');
    } catch {
      continue;
    }
    const doc: unknown = parse(text) ?? {};
    if (typeof doc !== 'object' || Array.isArray(doc) || doc === null) {
      throw new Error(`${name}: expected a mapping of corpus names`);
    }
    for (const [corpus, entry] of Object.entries(doc)) {
      const { path, commit, codesift, git } = (entry ?? {}) as Record<string, unknown>;
      if (typeof path !== 'string' || !path) {
        throw new Error(`${name}: corpus ${corpus} needs a path`);
      }
      if (commit !== undefined && typeof commit !== 'string') {
        throw new Error(`${name}: corpus ${corpus} has a commit that is not text`);
      }
      if (codesift !== undefined && typeof codesift !== 'string') {
        throw new Error(`${name}: corpus ${corpus} has a codesift repo that is not text`);
      }
      if (git !== undefined && (typeof git !== 'string' || typeof commit !== 'string')) {
        throw new Error(`${name}: corpus ${corpus} needs a git URL and the commit to fetch`);
      }
      corpora.set(corpus, {
        name: corpus,
        root: isAbsolute(path) ? path : resolve(root, path),
        private: name.endsWith('.local.yaml'),
        ...(commit ? { commit } : {}),
        ...(codesift ? { codesift } : {}),
        ...(git ? { git } : {}),
      });
    }
  }
  return corpora;
}

/** Throws unless [corpus] is checked out at the commit its cases were written for. */
export function assertPinned(corpus: Corpus): void {
  if (!corpus.commit) return;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: corpus.root, encoding: 'utf8' }).trim();
  if (!head.startsWith(corpus.commit)) {
    throw new Error(
      `Corpus ${corpus.name} is at ${head.slice(0, 9)}, but its cases were written for ${corpus.commit}`,
    );
  }
}
