import { describe, expect, it } from 'vitest';
import { memoryBudget, treeMb } from './memory.ts';

const machine = (gb: number, freeGb: number) => ({ totalMb: gb * 1024, availableMb: freeGb * 1024 });

describe('memory budget', () => {
  it('goes by the machine on auto: 1 GB on 8, 2 on 16, 3 on 24, 4 on 32', () => {
    expect([8, 16, 24, 32].map((gb) => memoryBudget('auto', machine(gb, 20)).mb)).toEqual([1024, 2048, 3072, 4096]);
    expect(memoryBudget(undefined, machine(8, 20))).toEqual({ mode: 'low', mb: 1024, why: 'auto: 8 GB machine, 20.0 GB free' });
    expect(memoryBudget('auto', machine(32, 20)).mode).toBe('high');
  });

  it('takes at most half of what is free, and never under 512 MB', () => {
    expect(memoryBudget('auto', machine(32, 3)).mb).toBe(1536);
    expect(memoryBudget('auto', machine(16, 0.5)).mb).toBe(512);
  });

  it('takes a mode or a number of MB as set', () => {
    expect(memoryBudget('low', machine(32, 20))).toEqual({ mode: 'low', mb: 1024, why: 'CSYK_MEMORY=low' });
    expect(memoryBudget('High', machine(8, 1)).mb).toBe(4096);
    expect(memoryBudget('2500', machine(8, 1))).toEqual({ mode: 'normal', mb: 2500, why: 'CSYK_MEMORY=2500' });
  });

  it('measures this process', () => {
    expect(treeMb(process.pid)).toBeGreaterThan(10);
  });
});
