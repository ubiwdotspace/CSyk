import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How long a shown body stays "already shown" for hosts that compact without telling us. */
const ledgerTtl = 30 * 60 * 1000;

/**
 * The marker file a SessionStart or PreCompact hook touches to say the
 * agent's context was reset, so source shown before must be shown again.
 */
export function resetMarker(root: string): string {
  const key = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return join(tmpdir(), 'csyk', `${key}.reset`);
}

/** A short content hash for the ledger. */
export function bodyHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/**
 * What one agent session has been told: the bodies `read` showed (by symbol
 * id and body hash, with the call that showed them) and the hints given.
 * Both are dropped when the reset marker is newer than the session's
 * memory; shown bodies also expire after 30 minutes.
 */
export class Session {
  private calls = 0;
  private readonly shownAt = new Map<string, { hash: string; call: number; at: number }>();
  private readonly hinted = new Set<string>();
  private resetAt: number;
  private readonly marker: string | undefined;
  private readonly now: () => number;

  constructor(options: { marker?: string; now?: () => number } = {}) {
    this.marker = options.marker;
    this.now = options.now ?? Date.now;
    this.resetAt = this.now();
  }

  /** Counts a tool call and returns its number, 1 for the first. */
  nextCall(): number {
    this.checkReset();
    return ++this.calls;
  }

  /** The call that showed this exact body of [id], if it is still in context. */
  shown(id: string, hash: string): number | undefined {
    this.checkReset();
    const entry = this.shownAt.get(id);
    if (!entry || entry.hash !== hash || this.now() - entry.at > ledgerTtl) return undefined;
    return entry.call;
  }

  /** Notes that the current call showed this body of [id] in full. */
  record(id: string, hash: string): void {
    this.shownAt.set(id, { hash, call: this.calls, at: this.now() });
  }

  /** [text] the first time [key] is hinted in this session, nothing after. */
  hint(key: string, text: string): string[] {
    if (this.hinted.has(key)) return [];
    this.hinted.add(key);
    return [text];
  }

  private checkReset(): void {
    if (!this.marker) return;
    let touched: number;
    try {
      touched = statSync(this.marker).mtimeMs;
    } catch {
      return;
    }
    if (touched <= this.resetAt) return;
    this.resetAt = touched;
    this.shownAt.clear();
    this.hinted.clear();
  }
}
