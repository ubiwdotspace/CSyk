import { execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

/**
 * How much memory CSyk and its language servers may hold together, and how
 * it was chosen. Past it, servers not in use stop; in low mode the servers
 * also work with less (see LspService).
 */
export type Memory = { mode: 'low' | 'normal' | 'high'; mb: number; why: string };

const MB = 1024 * 1024;
const modes = { low: 1024, normal: 2048, high: 4096 } as const;
// The budget for a machine of this many GB of RAM, or less: a laptop with
// 8 GB runs an editor, a browser and the agent beside CSyk.
const tiers: [number, number][] = [
  [8, 1024],
  [16, 2048],
  [24, 3072],
];

/**
 * The budget [setting] (CSYK_MEMORY) asks for: `low`, `normal`, `high`, a
 * number of MB, or `auto` (the default), which goes by the machine's RAM
 * (1 GB on 8 GB, 2 on 16, 3 on 24, 4 on more) and takes at most half of
 * what is free, so a machine busy with other work gets less.
 */
export function memoryBudget(setting = process.env.CSYK_MEMORY, machine?: { totalMb: number; availableMb: number }): Memory {
  // What is free is read again at most every ten seconds: searches ask often.
  if (!machine && setting === process.env.CSYK_MEMORY && cached && Date.now() - cached.at < 10_000) return cached.memory;
  const memory = budgetFor(setting, machine);
  if (!machine && setting === process.env.CSYK_MEMORY) cached = { at: Date.now(), memory };
  return memory;
}

let cached: { at: number; memory: Memory } | undefined;

function budgetFor(setting: string | undefined, machine?: { totalMb: number; availableMb: number }): Memory {
  const value = setting?.trim().toLowerCase() ?? '';
  if (value in modes) {
    const mode = value as keyof typeof modes;
    return { mode, mb: modes[mode], why: `CSYK_MEMORY=${mode}` };
  }
  if (/^\d+$/.test(value) && Number(value) > 0) return { mode: modeOf(Number(value)), mb: Number(value), why: `CSYK_MEMORY=${value}` };
  const { totalMb, availableMb } = machine ?? { totalMb: totalmem() / MB, availableMb: available() };
  const gb = Math.round(totalMb / 1024);
  const tier = tiers.find(([upTo]) => gb <= upTo)?.[1] ?? modes.high;
  const mb = Math.max(512, Math.min(tier, Math.round(availableMb / 2)));
  return { mode: modeOf(mb), mb, why: `auto: ${gb} GB machine, ${(availableMb / 1024).toFixed(1)} GB free` };
}

function modeOf(mb: number): Memory['mode'] {
  return mb < 1536 ? 'low' : mb < 3584 ? 'normal' : 'high';
}

// Memory other programs can have now, in MB. macOS counts the cache it
// would give up as inactive, purgeable or speculative, not free.
function available(): number {
  if (process.platform !== 'darwin') return freemem() / MB;
  try {
    const stat = execFileSync('vm_stat', { encoding: 'utf8' });
    const page = Number(/page size of (\d+) bytes/.exec(stat)?.[1] ?? 4096);
    const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stat)?.[1] ?? 0);
    return ((pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page) / MB;
  } catch {
    return freemem() / MB;
  }
}

/** The memory, in MB, of process [pid] and every process below it; 0 where ps is missing. */
export function treeMb(pid: number): number {
  let rows: string[][];
  try {
    rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((row) => row.trim().split(/\s+/));
  } catch {
    return 0;
  }
  const tree = new Set([String(pid)]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const [child, parent] of rows) {
      if (child && parent && tree.has(parent) && !tree.has(child)) {
        tree.add(child);
        grown = true;
      }
    }
  }
  return Math.round(rows.reduce((kb, [child, , rss]) => kb + (child && tree.has(child) ? Number(rss) : 0), 0) / 1024);
}
