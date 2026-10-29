import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Session } from './session.ts';

describe('Session', () => {
  it('remembers the call that showed a body, for that exact body', () => {
    const session = new Session();
    session.nextCall();
    session.record('a.ts#f', 'h1');
    session.nextCall();
    expect(session.shown('a.ts#f', 'h1')).toBe(1);
    expect(session.shown('a.ts#f', 'h2')).toBeUndefined();
    expect(session.shown('a.ts#g', 'h1')).toBeUndefined();
  });

  it('forgets shown bodies after thirty minutes', () => {
    let now = 0;
    const session = new Session({ now: () => now });
    session.nextCall();
    session.record('a.ts#f', 'h1');
    now = 31 * 60 * 1000;
    expect(session.shown('a.ts#f', 'h1')).toBeUndefined();
  });

  it('forgets everything when the reset marker is touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-session-'));
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, 'reset');
    const session = new Session({ marker, now: () => 1_000 });
    session.nextCall();
    session.record('a.ts#f', 'h1');
    expect(session.hint('find', 'hint')).toEqual(['hint']);
    writeFileSync(marker, '');
    utimesSync(marker, 5, 5);
    expect(session.shown('a.ts#f', 'h1')).toBeUndefined();
    expect(session.hint('find', 'hint')).toEqual(['hint']);
  });

  it('gives each hint once', () => {
    const session = new Session();
    expect(session.hint('find', 'hint: read')).toEqual(['hint: read']);
    expect(session.hint('find', 'hint: read')).toEqual([]);
  });
});
