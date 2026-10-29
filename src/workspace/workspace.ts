import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { sourceExtensions } from '../index/parse.ts';
import { SymbolIndex } from '../index/symbol-index.ts';
import { LspService, serverFor, servers } from '../precision/lsp-service.ts';

const run = promisify(execFile);

// A change is indexed this long after the last event for it, or at once
// when a tool call comes first.
const debounceMs = 200;
// A language server nobody asked for this long is stopped.
const idleMs = 10 * 60 * 1000;

// Folders whose changes never touch the project's own sources.
const ignoredDirs = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|\.dart_tool)\//;

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
  private readonly pending = new Set<string>();
  private readonly snapshot: string | undefined;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  // One flush at a time, so a tool never sees half of one.
  private flushing: Promise<void> = Promise.resolve();
  private readonly reaper: NodeJS.Timeout;

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
    await Promise.all(missing.map((file) => this.index.update(file)));
  }

  /** The language server for [file], or undefined when none is installed. */
  precision(file: string): Promise<LspService | undefined> {
    const spec = serverFor(file);
    if (!spec) return Promise.resolve(undefined);
    let running = this.services.get(spec.name);
    if (!running) {
      running = { service: LspService.start(this.root, spec), used: 0 };
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

  /** Each language in the index with its server: running, not started yet, or not installed. */
  servers(): { lang: string; server: string; state: 'running' | 'starts on first use' | 'not installed' }[] {
    const extensions = new Set(this.index.files.map((file) => extname(file)));
    return servers
      .filter((spec) => [...spec.extensions].some((ext) => extensions.has(ext)))
      .map((spec) => ({
        lang: [...spec.extensions].filter((ext) => extensions.has(ext)).join(' '),
        server: spec.name,
        state: this.services.has(spec.name) ? 'running' : spec.command() ? 'starts on first use' : 'not installed',
      }));
  }

  get pendingChanges(): number {
    return this.pending.size;
  }

  async close(): Promise<void> {
    this.watcher?.close();
    clearTimeout(this.timer);
    clearInterval(this.reaper);
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
