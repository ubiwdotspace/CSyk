import { describe, expect, it } from 'vitest';
import { changedOldLines, parseAnswer, scoreAnswer } from './run.ts';

const gold = {
  files: ['src/a.ts', 'src/b.ts'],
  nodes: [
    { file: 'src/a.ts', name: 'save', isClass: false },
    { file: 'src/b.ts', name: 'load', isClass: false },
  ],
};

describe('localization scoring', () => {
  it('reads the last JSON object of an answer, paths made relative', () => {
    const answer = 'Thinking {"files": ["x"]}\nDone:\n{"files": ["./src/a.ts", "/repo/src/b.ts"], "functions": ["src/a.ts:Store.save"]}';
    expect(parseAnswer(answer, '/repo')).toEqual({ files: ['src/a.ts', 'src/b.ts'], functions: ['src/a.ts:Store.save'] });
  });

  it('scores files at 1 and 5, and the changed functions named', () => {
    expect(scoreAnswer(gold, ['src/a.ts', 'src/c.ts', 'src/b.ts'], ['src/a.ts:Store.save'])).toEqual({
      fileAt1: 1,
      fileAt5: 1,
      fileRecall5: 1,
      nodeRecall: 0.5,
    });
    expect(scoreAnswer({ files: gold.files, nodes: [] }, ['src/c.ts', 'src/a.ts'], [])).toEqual({ fileAt1: 0, fileAt5: 0, fileRecall5: 0.5 });
  });

  it('counts a function named inside a changed function, not a method named in a changed class', () => {
    const nodes = [
      { file: 'src/a.ts', name: 'useList', isClass: false },
      { file: 'src/b.ts', name: 'Store', isClass: true },
    ];
    expect(scoreAnswer({ files: ['src/a.ts', 'src/b.ts'], nodes }, ['src/a.ts'], ['src/a.ts:useList.onBlur', 'src/b.ts:Store.save']).nodeRecall).toBe(0.5);
  });

  it('finds the base lines a patch removes or adds next to', () => {
    const patch = [
      'diff --git a/x.py b/x.py',
      '--- a/x.py',
      '+++ b/x.py',
      '@@ -10,4 +10,4 @@ def f():',
      '     a = 1',
      '-    b = 2',
      '+    b = 3',
      '     c = 4',
      '@@ -40,2 +40,3 @@',
      '     d = 5',
      '+    e = 6',
    ].join('\n');
    expect(changedOldLines(patch)).toEqual(new Map([['x.py', [11, 12, 41]]]));
  });
});
