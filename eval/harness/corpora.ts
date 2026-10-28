import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Corpus } from './types.js';

/**
 * The corpora by name: `corpora.yaml` (committed, public) overlaid by
 * `corpora.local.yaml` (git-ignored), which points at private checkouts.
 * Each entry is `<name>: { path: <dir> }`, relative to the repo root or
 * absolute.
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
      const path = (entry as { path?: unknown } | null)?.path;
      if (typeof path !== 'string' || !path) {
        throw new Error(`${name}: corpus ${corpus} needs a path`);
      }
      corpora.set(corpus, {
        name: corpus,
        root: isAbsolute(path) ? path : resolve(root, path),
      });
    }
  }
  return corpora;
}
