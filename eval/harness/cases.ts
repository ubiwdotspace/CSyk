import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { categories, type Case, type Category, type Location } from './types.js';

/** The cases of one `<corpus>.<category>.yaml` file. */
export type CaseFile = { corpus: string; category: Category; cases: Case[] };

const fileName = /^(?<corpus>[\w-]+)\.(?<category>[A-G])\.yaml$/;

/**
 * Loads every case file under [dir] and its `private/` folder, which holds
 * cases on private corpora and is never committed.
 */
export async function loadCaseFiles(dir: string): Promise<CaseFile[]> {
  const files: CaseFile[] = [];
  for (const folder of [dir, join(dir, 'private')]) {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.yaml')) continue;
      const path = join(folder, name);
      files.push(parseCaseFile(path, name, await readFile(path, 'utf8')));
    }
  }
  return files;
}

/** Parses and checks one case file; throws naming the file and the case. */
export function parseCaseFile(path: string, name: string, text: string): CaseFile {
  const match = fileName.exec(name);
  if (!match?.groups) {
    throw new Error(`${path}: name it <corpus>.<category>.yaml`);
  }
  const { corpus, category } = match.groups as { corpus: string; category: Category };
  const doc: unknown = parse(text);
  if (!isRecord(doc) || !Array.isArray(doc.cases)) {
    throw new Error(`${path}: expected a "cases" list`);
  }
  const ids = new Set<string>();
  const cases = doc.cases.map((raw: unknown, i: number): Case => {
    const where = `${path}: case ${i + 1}`;
    if (!isRecord(raw)) throw new Error(`${where} is not a mapping`);
    const { id, query, kind, expect } = raw;
    if (typeof id !== 'string' || !id) throw new Error(`${where} needs an id`);
    if (ids.has(id)) throw new Error(`${where} repeats id ${id}`);
    ids.add(id);
    if (typeof query !== 'string' || !query) throw new Error(`${where} (${id}) needs a query`);
    if (kind !== undefined && typeof kind !== 'string') {
      throw new Error(`${where} (${id}): kind must be text`);
    }
    if (!Array.isArray(expect) || expect.length === 0) {
      throw new Error(`${where} (${id}) needs at least one expected location`);
    }
    return {
      id,
      category,
      query,
      ...(kind === undefined ? {} : { kind }),
      expect: expect.map((loc: unknown) => parseLocation(loc, `${where} (${id})`)),
    };
  });
  if (!categories.includes(category)) throw new Error(`${path}: unknown category`);
  return { corpus, category, cases };
}

function parseLocation(raw: unknown, where: string): Location {
  if (!isRecord(raw) || typeof raw.file !== 'string' || !raw.file) {
    throw new Error(`${where}: each expected location needs a file`);
  }
  if (raw.file.startsWith('/') || raw.file.includes('..')) {
    throw new Error(`${where}: ${raw.file} must be repo-relative`);
  }
  if (raw.lines === undefined) return { file: raw.file };
  const lines = raw.lines;
  const valid =
    Array.isArray(lines) &&
    lines.length === 2 &&
    lines.every((n) => Number.isInteger(n) && n > 0) &&
    lines[0] <= lines[1];
  if (!valid) throw new Error(`${where}: lines must be [first, last], 1-based`);
  return { file: raw.file, lines: [lines[0], lines[1]] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
