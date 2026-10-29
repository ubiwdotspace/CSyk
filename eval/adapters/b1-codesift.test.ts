import { describe, expect, it } from 'vitest';
import { parseCodeSiftHits } from './b1-codesift.ts';

describe('parseCodeSiftHits', () => {
  it('reads located lines and lines under a file heading, once each', () => {
    const answer = [
      '⚡H4',
      '',
      'src/a.ts:39 function calcTotal ({',
      'const calcTotal = ({',
      'src/b.ts',
      '  10:   calcTotal,',
      '  94:       return calcTotal({',
      'src/a.ts:39 again',
    ].join('\n');
    expect(parseCodeSiftHits(answer)).toEqual([
      { file: 'src/a.ts', line: 39 },
      { file: 'src/b.ts', line: 10 },
      { file: 'src/b.ts', line: 94 },
    ]);
  });
});
