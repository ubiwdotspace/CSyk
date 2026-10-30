import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * What a process and everything it started used. `peakMb` and `cpuSeconds`
 * cover the whole tree; the rest split it into the process itself (its
 * growth over its size at the start, so code it had already loaded does not
 * count) and the processes it started.
 */
export type Resources = {
  peakMb: number;
  cpuSeconds: number;
  selfGrowthMb: number;
  selfCpuSeconds: number;
  childPeakMb: number;
  childCpuSeconds: number;
  /** The largest growth of the process itself plus what it started, at the same moment. */
  growthAndChildPeakMb: number;
};

/**
 * Samples [pid] and its descendants with `ps` until stop(). CPU time counts
 * from the first sample, so a process that ran before does not carry its
 * past in. Unlike wall time, neither memory nor CPU time grows much when
 * other work shares the machine.
 */
export function watchResources(pid: number = process.pid, everyMs = 250): { stop(): Promise<Resources> } {
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  let selfBaseKb: number | undefined;
  let peak = { tree: 0, self: 0, children: 0, together: 0 };
  let pending: Promise<void> | undefined;

  const sample = async () => {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=']);
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .map(([p, pp, rss, time]) => ({ pid: Number(p), ppid: Number(pp), kb: Number(rss), cpu: procCpu(Number(p)) ?? seconds(time ?? '') }));
    const children = new Map<number, number[]>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
    const tree = new Set<number>();
    for (const queue = [pid]; queue.length > 0; ) {
      const next = queue.pop() as number;
      if (tree.has(next)) continue;
      tree.add(next);
      queue.push(...(children.get(next) ?? []));
    }
    let selfKb = 0;
    let childKb = 0;
    for (const row of rows) {
      if (!tree.has(row.pid)) continue;
      if (row.pid === pid) selfKb = row.kb;
      else childKb += row.kb;
      if (!first.has(row.pid)) first.set(row.pid, selfBaseKb === undefined ? row.cpu : 0);
      last.set(row.pid, Math.max(last.get(row.pid) ?? 0, row.cpu));
    }
    selfBaseKb ??= selfKb;
    peak = {
      tree: Math.max(peak.tree, selfKb + childKb),
      self: Math.max(peak.self, selfKb - selfBaseKb),
      children: Math.max(peak.children, childKb),
      together: Math.max(peak.together, Math.max(0, selfKb - selfBaseKb) + childKb),
    };
  };
  const tick = () => {
    pending ??= sample().finally(() => (pending = undefined));
  };
  tick();
  // unref: a run that fails still exits, instead of waiting on the timer.
  const timer = setInterval(tick, everyMs).unref();

  return {
    async stop() {
      clearInterval(timer);
      await pending;
      await sample();
      let self = 0;
      let child = 0;
      for (const [p, end] of last) {
        const used = end - (first.get(p) ?? 0);
        if (p === pid) self += used;
        else child += used;
      }
      const mb = (kb: number) => Math.round(kb / 1024);
      const s = (n: number) => Math.round(n * 10) / 10;
      return {
        peakMb: mb(peak.tree),
        cpuSeconds: s(self + child),
        selfGrowthMb: mb(peak.self),
        selfCpuSeconds: s(self),
        childPeakMb: mb(peak.children),
        childCpuSeconds: s(child),
        growthAndChildPeakMb: mb(peak.together),
      };
    },
  };
}

/**
 * A process's CPU time from /proc on Linux, in hundredths of a second where
 * `ps` gives whole seconds: user and system ticks, at Linux's fixed 100 a second.
 */
function procCpu(pid: number): number | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    // The process has already exited.
    return undefined;
  }
}

/** `ps` CPU time: `M:SS.ss` on macOS, `[D-]HH:MM:SS` on Linux. */
export function seconds(time: string): number {
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
  return Number(days) * 86400 + (clock ?? '').split(':').reduce((total, part) => total * 60 + Number(part), 0);
}
