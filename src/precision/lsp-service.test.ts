import { describe, expect, it } from 'vitest';
import { nameColumn } from './lsp-service.ts';

describe('nameColumn', () => {
  it('finds the declared name as a whole word, past a Go receiver', () => {
    expect(nameColumn('func (a *xor2Appender) Append(t int64) {', 'Append')).toBe(23);
    expect(nameColumn('func (a Append) Append() {', 'Append')).toBe(16);
    expect(nameColumn('  appendItem(x) { return append(x); }', 'append')).toBe(25);
    expect(nameColumn('export function total(xs) {', 'total')).toBe(16);
  });
});
