import { describe, expect, it } from 'vitest';
import { parseAnswer, scoreAnswer } from './run.ts';

const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '--- a/src/b.ts', '+++ b/src/b.ts'].join('\n');
const nodes = JSON.stringify(['src/a.ts->program->class_declaration:Store->method_definition:save', 'src/b.ts->program->function_declaration:load']);

describe('localization scoring', () => {
  it('reads the last JSON object of an answer, paths made relative', () => {
    const answer = 'Thinking {"files": ["x"]}\nDone:\n{"files": ["./src/a.ts", "/repo/src/b.ts"], "functions": ["src/a.ts:Store.save"]}';
    expect(parseAnswer(answer, '/repo')).toEqual({ files: ['src/a.ts', 'src/b.ts'], functions: ['src/a.ts:Store.save'] });
  });

  it('scores files at 1 and 5, and the changed functions named', () => {
    expect(scoreAnswer({ patch, modified_nodes: nodes }, ['src/a.ts', 'src/c.ts', 'src/b.ts'], ['src/a.ts:Store.save'])).toEqual({
      fileAt1: 1,
      fileAt5: 1,
      fileRecall5: 1,
      nodeRecall: 0.5,
    });
    expect(scoreAnswer({ patch, modified_nodes: '[]' }, ['src/c.ts', 'src/a.ts'], [])).toEqual({ fileAt1: 0, fileAt5: 0, fileRecall5: 0.5 });
  });
});
