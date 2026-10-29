import { describe, expect, it } from 'vitest';
import { parseGraphifyLocations, parseGraphifyNeighbors } from './graphify.ts';
import { parseSerenaReferences, parseSerenaSymbols } from './serena.ts';

describe('Serena answers', () => {
  it('reads symbols with lines counted from 1', () => {
    const text =
      '[{"name_path": "JsonStorageOptions", "kind": "Variable", "relative_path": "src/persist.ts", "body_location": {"start_line": 25, "end_line": 28}}]';
    expect(parseSerenaSymbols(text)).toEqual([{ file: 'src/persist.ts', line: 26, namePath: 'JsonStorageOptions' }]);
    expect(parseSerenaSymbols('The answer is too long')).toEqual([]);
  });

  it('reads the marked line of each reference', () => {
    const text = JSON.stringify({
      'src/persist.ts': { Variable: [{ name_path: 'StorePersist', content_around_reference: '... 135:  a\n  > 136:  b\n... 137:  c' }] },
      'src/middleware.ts': { File: [{ name_path: 'middleware', content_around_reference: '  >  14:  type PersistOptions,' }] },
    });
    expect(parseSerenaReferences(text)).toEqual([
      { file: 'src/persist.ts', line: 137 },
      { file: 'src/middleware.ts', line: 15 },
    ]);
  });
});

describe('Graphify answers', () => {
  it('reads node locations from get_node and query_graph', () => {
    expect(parseGraphifyLocations('Node: Store\n  Source: examples/index.tsx L9\n')).toEqual([{ file: 'examples/index.tsx', line: 9 }]);
    expect(parseGraphifyLocations('NODE A [src=src/a.ts loc=L1 community=6]\nNODE ref [src= loc= community=9]')).toEqual([
      { file: 'src/a.ts', line: 1 },
    ]);
  });

  it('reads edges with their direction, relation and site', () => {
    const text = 'Neighbors of persistImpl():\n  --> toThenable() [calls] [EXTRACTED] at=src/persist.ts:L270\n  <-- persist.ts [contains] [EXTRACTED] at=src/persist.ts:L63';
    expect(parseGraphifyNeighbors(text)).toEqual([
      { incoming: false, label: 'toThenable()', relation: 'calls', at: { file: 'src/persist.ts', line: 270 } },
      { incoming: true, label: 'persist.ts', relation: 'contains', at: { file: 'src/persist.ts', line: 63 } },
    ]);
  });
});
