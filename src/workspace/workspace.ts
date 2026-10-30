import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { rgPath } from '@vscode/ripgrep';
import { codeExtensions, sourceExtensions } from '../index/parse.ts';
import { parsedAtOnce, SymbolIndex } from '../index/symbol-index.ts';
import { LspService, pool, serverFor, servers } from '../precision/lsp-service.ts';
import { memoryBudget, treeMb } from '../precision/memory.ts';

const run = promisify(execFile);

// A change is indexed this long after the last event for it, or at once
// when a tool call comes first.
const debounceMs = 200;
// A language server nobody asked for this long is stopped.
const idleMs = 10 * 60 * 1000;
// A server asked within this long may be answering: it is never stopped for memory.
const busyMs = 30_000;

// Folders whose changes never touch the project's own sources.
const ignoredDirs = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|\.dart_tool)\//;
// Folders of dependencies and builds, left out when searching what git ignores.
const dependencyDirs = ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.dart_tool', 'vendor', 'target', '.venv', 'venv', '__pycache__', 'Pods', '.gradle'];

/** Where the index of [root] is saved between runs. */
export function snapshotPath(root: string): string {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(cache, 'csyk', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
}

type Running = { service: Promise<LspService | undefined>; used: number };

/**
 * One workspace: its symbol index and a language server per language, each
 * started the first time a tool needs it and stopped after ten idle
 * minutes. With [watch], files that change on disk are indexed again and
 * the servers told; with [persist], the index is saved for the next start.
 */
export class Workspace {
  readonly root: string;
  readonly index: SymbolIndex;
  readonly watching: boolean;
  /** Settles once every file is indexed; until then, only the files a tool touched are. */
  ready: Promise<void> = Promise.resolve();
  complete = true;
  private readonly services = new Map<string, Running>();
  // Servers started again after stopping on their own, and those that stopped twice.
  private readonly restarted = new Set<string>();
  private readonly gone = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly snapshot: string | undefined;
  private watcher: FSWatcher | undefined;
  // Names already looked for in what git ignores: each search reads the whole tree.
  private readonly searchedIgnored = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  // One flush at a time, so a tool never sees half of one.
  private flushing: Promise<void> = Promise.resolve();
  private readonly reaper: NodeJS.Timeout;
  private readonly watcherOfMemory: NodeJS.Timeout;

  private constructor(root: string, index: SymbolIndex, options: { watch?: boolean; persist?: boolean }) {
    this.root = root;
    this.index = index;
    this.snapshot = options.persist ? snapshotPath(root) : undefined;
    this.watching = options.watch === true;
    if (options.watch) {
      this.watcher = watch(root, { recursive: true }, (_event, name) => name && this.queue(name.replaceAll('\\', '/')));
      this.watcher.on('error', () => this.watcher?.close());
    }
    this.reaper = setInterval(() => void this.stopIdle(), 60_000);
    this.reaper.unref();
    this.watcherOfMemory = setInterval(() => void this.keepToBudget(), 10_000);
    this.watcherOfMemory.unref();
  }

  static async open(root: string, options: { watch?: boolean; persist?: boolean } = {}): Promise<Workspace> {
    const ws = Workspace.start(root, options);
    await ws.ready.catch(async (error: unknown) => {
      await ws.close();
      throw error;
    });
    return ws;
  }

  /**
   * A workspace at once, its index filling in the background: a large
   * checkout takes seconds to index, and grep need not wait for it.
   */
  static start(root: string, options: { watch?: boolean; persist?: boolean } = {}): Workspace {
    const ws = new Workspace(root, SymbolIndex.empty(root), options);
    ws.complete = false;
    ws.ready = ws.index.fill(options.persist ? { snapshot: snapshotPath(root) } : {}).then(() => {
      ws.complete = true;
    });
    return ws;
  }

  /** While the index fills, indexes [files] now, for a tool that needs only them. */
  async indexNow(files: string[]): Promise<void> {
    if (this.complete) return;
    const missing = files.filter((f) => !this.index.has(f) && sourceExtensions.has(extname(f)) && !f.endsWith('.d.ts'));
    await pool(missing, parsedAtOnce, (file) => this.index.update(file));
  }

  /**
   * Indexes the code files git ignores that mention [name], when no indexed
   * file declares it: generated code the project uses, such as Flutter's
   * translations or protobuf stubs.
   */
  async indexIgnored(name: string): Promise<void> {
    if (this.index.named(name).length > 0 || this.searchedIgnored.has(name)) return;
    this.searchedIgnored.add(name);
    const globs = [...[...codeExtensions].map((ext) => `*${ext}`), ...dependencyDirs.map((dir) => `!**/${dir}/**`)];
    let stdout = '';
    try {
      ({ stdout } = await run(rgPath, ['--no-ignore', '--files-with-matches', '-w', '-F', ...globs.flatMap((g) => ['-g', g]), '-e', name, '.'], {
        cwd: this.root,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      // Exit code 1 is ripgrep's "no match".
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
    const files = stdout.split('\n').map((f) => f.replace(/^\.\//, '')).filter((f) => f && !this.index.has(f) && !f.endsWith('.d.ts'));
    await pool(files.slice(0, 20), parsedAtOnce, (file) => this.index.update(file));
  }

  /**
   * The language server for [file], or undefined when none is installed or
   * it stopped twice. A server that stopped on its own starts again once.
   */
  async precision(file: string): Promise<LspService | undefined> {
    const spec = serverFor(file);
    if (!spec || this.gone.has(spec.name)) return undefined;
    let running = this.services.get(spec.name);
    if (running && (await running.service.catch(() => undefined))?.alive === false && this.services.get(spec.name) === running) {
      this.services.delete(spec.name);
      running = undefined;
      if (this.restarted.has(spec.name)) {
        this.gone.add(spec.name);
        return undefined;
      }
      this.restarted.add(spec.name);
    }
    if (!running) {
      // Room is made before a server starts, not after it has filled the machine.
      running = { service: this.keepToBudget(spec.name).then(() => LspService.start(this.root, spec)), used: 0 };
      this.services.set(spec.name, running);
    }
    running.used = Date.now();
    return running.service;
  }

  /** Indexes the changes seen so far; tools call this before they answer. */
  fresh(): Promise<void> {
    clearTimeout(this.timer);
    // A failed update leaves that file as it was; tools still answer.
    this.flushing = this.flushing.then(() => this.flush()).catch(() => {});
    return this.flushing;
  }

  private async flush(): Promise<void> {
    const files = [...this.pending];
    this.pending.clear();
    for (const file of files) {
      if (!this.index.has(file) && (await isIgnored(this.root, file))) continue;
      if (!(await this.index.update(file))) continue;
      for (const running of this.services.values()) await (await running.service.catch(() => undefined))?.changed(file);
    }
    if (files.length > 0 && this.snapshot) await this.index.save(this.snapshot);
  }

  /** Whether [file]'s language server stopped twice, so its language is answered from text. */
  stopped(file: string): boolean {
    const spec = serverFor(file);
    return spec !== undefined && this.gone.has(spec.name);
  }

  /** Each language in the index with its server: running, not started yet, not installed, or stopped twice. */
  servers(): { lang: string; server: string; state: 'running' | 'starts on first use' | 'not installed' | 'stopped twice' }[] {
    const extensions = new Set(this.index.files.map((file) => extname(file)));
    return servers
      .filter((spec) => [...spec.extensions].some((ext) => extensions.has(ext)))
      .map((spec) => ({
        lang: [...spec.extensions].filter((ext) => extensions.has(ext)).join(' '),
        server: spec.name,
        state: this.gone.has(spec.name)
          ? 'stopped twice'
          : this.services.has(spec.name)
            ? 'running'
            : spec.command()
              ? 'starts on first use'
              : 'not installed',
      }));
  }

  get pendingChanges(): number {
    return this.pending.size;
  }

  async close(): Promise<void> {
    this.watcher?.close();
    clearTimeout(this.timer);
    clearInterval(this.reaper);
    clearInterval(this.watcherOfMemory);
    const services = [...this.services.values()];
    this.services.clear();
    for (const { service } of services) await (await service.catch(() => undefined))?.stop();
  }

  private queue(file: string): void {
    if (!sourceExtensions.has(extname(file)) || file.endsWith('.d.ts') || ignoredDirs.test(file)) return;
    this.pending.add(file);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fresh(), debounceMs);
  }

  /**
   * While CSyk and its servers hold more than the budget (memoryBudget),
   * stops the servers used longest ago, never one asked in the last half
   * minute nor [keep]: each starts again the next time a tool needs it.
   * Answers stay those of the compiler; only time is traded.
   */
  private async keepToBudget(keep?: string): Promise<void> {
    if (this.services.size === 0) return;
    const { mb } = memoryBudget();
    const idle = [...this.services]
      .filter(([name, running]) => name !== keep && Date.now() - running.used > busyMs)
      .sort(([, a], [, b]) => a.used - b.used);
    for (const [name, running] of idle) {
      if (treeMb(process.pid) <= mb) return;
      this.services.delete(name);
      await (await running.service.catch(() => undefined))?.stop();
    }
  }

  private async stopIdle(): Promise<void> {
    for (const [name, running] of this.services) {
      if (Date.now() - running.used < idleMs) continue;
      this.services.delete(name);
      await (await running.service.catch(() => undefined))?.stop();
    }
  }
}

// Whether git ignores [file], such as generated output; outside git, no.
async function isIgnored(root: string, file: string): Promise<boolean> {
  try {
    await run('git', ['check-ignore', '-q', file], { cwd: root });
    return true;
  } catch {
    return false;
  }
}
