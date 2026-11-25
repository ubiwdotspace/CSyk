import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { isComponentFile } from '../index/embedded.ts';
import type { Problem } from '../precision/lsp-client.ts';
import { pool, serverFor, type LspService } from '../precision/lsp-service.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { importersOf } from './map.ts';

const run = promisify(execFile);

/**
 * The compiler errors an edit made, for `impact`: what a change breaks, which only a compiler
 * knows and grep cannot, so the agent need not run tsc, go build or dart analyze to find out.
 * Asked of the servers already running, for the changed files and the files that import them
 * (a Go package's other files too), nearest first, within a time budget. Errors that were there
 * before the edit are left out: each changed file's text at [since] is given to its server in
 * memory (the disk is not touched), the same files are asked again, and only the errors that
 * run lacks are new.
 */
export type NewErrors = {
  errors: Problem[];
  /** Files asked, and how many of them answered in time, before and after. */
  asked: number;
  answered: number;
  /** Files whose errors could not be told apart from the ones before the edit. */
  unsure: Set<string>;
  /** Changed files no server answers for (components, a language with none installed). */
  unchecked: string[];
};

// Files asked at most, and how long both runs may take together.
const maxFiles = 30;
const errorsMs = 15_000;

export async function newErrors(ws: Workspace, changed: readonly string[], since: string, names: readonly string[] = []): Promise<NewErrors> {
  const checkable = changed.filter((f) => serverFor(f) && !isComponentFile(f));
  const unchecked = changed.filter((f) => !checkable.includes(f));
  const none: NewErrors = { errors: [], asked: 0, answered: 0, unsure: new Set(), unchecked };
  if (checkable.length === 0) return none;
  // A Go file's package is its folder: its other files use its names without an import.
  const siblings = checkable
    .filter((f) => f.endsWith('.go'))
    .flatMap((f) => ws.index.files.filter((o) => o !== f && o.endsWith('.go') && posix.dirname(o) === posix.dirname(f)));
  const users = [...new Set([...siblings, ...(await usersOf(ws, checkable))])].filter((f) => serverFor(f) && !isComponentFile(f));
  // The files that name what changed (now or before the edit) first: they are where it breaks.
  const named = [...new Set([...names, ...(await namesBefore(ws.root, since, checkable))])].filter((n) => n.length > 1);
  const pattern = named.length ? new RegExp(`\\b(?:${named.map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\b`) : undefined;
  const naming = pattern
    ? await pool(users, 16, async (f) => pattern.test(await readFile(join(ws.root, f), 'utf8').catch(() => '')))
    : users.map(() => false);
  const ordered = [...users.filter((_, i) => naming[i]), ...users.filter((_, i) => !naming[i])];
  const files = [...new Set([...checkable, ...ordered])].slice(0, maxFiles);
  const services = new Map<string, LspService>();
  for (const file of files) {
    const service = await ws.precision(file).catch(() => undefined);
    if (service) services.set(file, service);
  }
  const asked = files.filter((f) => services.has(f));
  if (asked.length === 0) return { ...none, unchecked: [...changed] };
  const deadline = Date.now() + errorsMs;
  // Most of a file's wait is the server's quiet after it pushes, so many are asked at once.
  const ask = async (which: readonly string[]) => {
    const answers = await pool([...which], 16, async (file) => ({ file, found: await services.get(file)?.diagnostics(file, deadline) }));
    return new Map(answers.filter((a) => a !== undefined).map((a) => [a.file, a.found]));
  };
  // Only the errors this edit could have made: not an import of a package the machine has not
  // installed (unless the edit wrote it), and, in a file that uses what changed, only on a line
  // that names it. Errors on every line of a project whose packages are missing (netbox without
  // Django) would otherwise all be asked about again, and listed when that runs out of time.
  const added = await addedLines(ws.root, since, checkable);
  // The text before the edit, for each changed file the revision has; an added file has none,
  // and every line of it is the edit's.
  const before = new Map<string, string>();
  for (const file of checkable) {
    if (!services.has(file)) continue;
    const text = await run('git', ['show', `${since}:./${file}`], { cwd: ws.root, maxBuffer: 64 * 1024 * 1024 }).then(
      (r) => r.stdout,
      () => undefined,
    );
    if (text !== undefined) before.set(file, text);
  }
  const project = await projectNames(ws, since);
  const texts = new Map<string, string[]>();
  const lineOf = async (p: Problem) => {
    if (!texts.has(p.file)) texts.set(p.file, (await readFile(join(ws.root, p.file), 'utf8').catch(() => '')).split('\n'));
    return texts.get(p.file)?.[p.line] ?? '';
  };
  const relevant = async (p: Problem) => {
    const written = (added.get(p.file)?.has(p.line) ?? false) || (checkable.includes(p.file) && !before.has(p.file));
    if (!written && (await missingPackage(p, project))) return false;
    return checkable.includes(p.file) || !pattern || pattern.test(await lineOf(p));
  };
  const after = new Map<string, Problem[] | undefined>();
  for (const [file, found] of await ask(asked)) {
    const kept: Problem[] = [];
    for (const p of found ?? []) if (await relevant(p)) kept.push(p);
    after.set(file, found && kept);
  }
  // Only a file with errors now can have new ones: the rest are not asked again.
  const erring = asked.filter((f) => (after.get(f) ?? []).length > 0);
  let earlier = new Map<string, Problem[] | undefined>();
  if (erring.length > 0 && before.size > 0) {
    try {
      for (const [file, text] of before) await services.get(file)?.setText(file, text);
      earlier = await ask(erring);
    } finally {
      for (const file of before.keys()) await services.get(file)?.changed(file);
    }
  }
  const errors: Problem[] = [];
  const unsure = new Set<string>();
  for (const file of asked) {
    const now = after.get(file);
    if (!now?.length) continue;
    const added = checkable.includes(file) && !before.has(file);
    const then = earlier.get(file);
    if (then === undefined && !added) unsure.add(file);
    // Matched by code and message, not line: an edit above an old error moves it.
    const old = new Map<string, number>();
    for (const p of then ?? []) old.set(key(p), (old.get(key(p)) ?? 0) + 1);
    for (const p of now) {
      const left = old.get(key(p)) ?? 0;
      if (left > 0) old.set(key(p), left - 1);
      else errors.push(p);
    }
  }
  const answered = asked.filter((f) => after.get(f) !== undefined).length;
  return { errors, asked: asked.length, answered, unsure, unchecked };
}

// The files that import [files], and those that import them through a file that re-exports them
// (an index.ts, Dart's lib/<package>.dart, a Python __init__.py), three such files deep.
async function usersOf(ws: Workspace, files: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  let level = [...files];
  for (let depth = 0; depth < 3 && level.length > 0; depth++) {
    const next: string[] = [];
    for (const user of await importersOf(ws, level)) {
      if (found.has(user) || files.includes(user)) continue;
      found.add(user);
      if (user.endsWith('__init__.py') || reExports.test(await readFile(join(ws.root, user), 'utf8').catch(() => ''))) next.push(user);
    }
    level = next;
  }
  return [...found];
}

const reExports = /^\s*export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s*from\s|^\s*export\s+['"]/m;

// The names declared on the lines an edit removed from [files] since [since]: a renamed function's
// old name, which its users still write.
async function namesBefore(root: string, since: string, files: readonly string[]): Promise<string[]> {
  const diff = await run('git', ['diff', '--relative', '--unified=0', '--no-color', '--no-ext-diff', since, '--', ...files], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  }).then((r) => r.stdout, () => '');
  const found = new Set<string>();
  const declaration = /\b(?:function|const|let|var|class|interface|type|enum|def|func|struct)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/g;
  for (const line of diff.split('\n')) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    for (const [, name = ''] of line.matchAll(declaration)) found.add(name);
  }
  return [...found];
}

const key = (p: Problem) => `${p.code}\u0000${p.message}`;

// Whether [p] says an import names a package that is not the project's, one the machine has not
// installed: pyright's `Import "django.conf" could not be resolved`, TypeScript's bare
// `Cannot find module 'react'`, Dart's `package:` URI of another package. A module named like a
// file or folder the edit changed, moved or deleted is the project's: its importers broke.
async function missingPackage(p: Problem, project: Project): Promise<boolean> {
  const python = /^Import "([\w.]+)" could not be resolved/.exec(p.message);
  const ts = /^Cannot find module '([^']+)'/.exec(p.message);
  const dart = /^Target of URI doesn't exist: 'package:(\w+)\/([^']*)'/.exec(p.message);
  const parts = python?.[1]?.split('.') ?? ts?.[1]?.split('/') ?? (dart ? [dart[1] ?? '', ...(dart[2] ?? '').split('/')] : undefined);
  if (!parts) return false;
  // Its first name: `django.db.models` is Django's, whatever models.py the edit changed.
  if (project.touched.has((parts[0] ?? '').replace(/\.\w+$/, ''))) return false;
  if (python) return !project.folders.has(parts[0] ?? '');
  if (ts) return !/^(\.|\/|@\/|~|#|\$)/.test(ts[1] ?? '') && !project.folders.has(parts[0] ?? '');
  return !(await project.dartPackages()).has(parts[0] ?? '');
}

type Project = { folders: Set<string>; touched: Set<string>; dartPackages: () => Promise<Set<string>> };

// The names an import of the project's own code may start with: its folders and Python modules;
// the stems and folders of the files the edit since [since] changed, moved or deleted; and,
// when asked, its Dart packages' names from their pubspec.yaml.
async function projectNames(ws: Workspace, since: string): Promise<Project> {
  const parts = (file: string) => file.split('/').map((part) => part.replace(/\.\w+$/, ''));
  const diff = await run('git', ['diff', '--relative', '--name-only', '--no-renames', since, '--'], { cwd: ws.root, maxBuffer: 64 * 1024 * 1024 }).then(
    (r) => r.stdout.split('\n').filter(Boolean),
    () => [],
  );
  let dart: Promise<Set<string>> | undefined;
  return {
    folders: new Set(ws.index.files.flatMap(parts)),
    touched: new Set(diff.flatMap(parts)),
    dartPackages: () =>
      (dart ??= run('git', ['ls-files', '--', 'pubspec.yaml', '*/pubspec.yaml'], { cwd: ws.root }).then(
        async (r) => {
          const names = new Set<string>();
          for (const file of r.stdout.split('\n').filter(Boolean)) {
            const name = /^name:\s*([\w]+)/m.exec(await readFile(join(ws.root, file), 'utf8').catch(() => ''))?.[1];
            if (name) names.add(name);
          }
          return names;
        },
        () => new Set<string>(),
      )),
  };
}

// The lines (0-based) the edit since [since] wrote in [files], by file.
async function addedLines(root: string, since: string, files: readonly string[]): Promise<Map<string, Set<number>>> {
  const diff = await run('git', ['diff', '--relative', '--unified=0', '--no-color', '--no-ext-diff', since, '--', ...files], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  }).then((r) => r.stdout, () => '');
  const found = new Map<string, Set<number>>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]) - 1;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = found.get(file) ?? new Set<number>();
    for (let i = 0; i < count; i++) lines.add(start + i);
    found.set(file, lines);
  }
  return found;
}
