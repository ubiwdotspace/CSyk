import { describe, expect, it } from 'vitest';
import { seconds, watchResources } from './resources.ts';

describe('resources', () => {
  it('reads ps CPU time on macOS and Linux', () => {
    expect(seconds('1:02.50')).toBe(62.5);
    expect(seconds('01:00:05')).toBe(3605);
    expect(seconds('2-00:00:01')).toBe(172801);
  });

  it('counts the CPU a busy loop spends and this process memory', async () => {
    const watch = watchResources();
    // The first sample is the starting point; a busy loop must not block it.
    await new Promise((done) => setTimeout(done, 300));
    const end = Date.now() + 600;
    while (Date.now() < end);
    const used = await watch.stop();
    expect(used.cpuSeconds).toBeGreaterThan(0.2);
    expect(used.peakMb).toBeGreaterThan(10);
  });
});
