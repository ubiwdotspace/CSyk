import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tokens of answers after which a session counts as long. CSYK_LONG_SESSION
// changes it, for measuring (Infinity: never long).
const longSession = Number(process.env.CSYK_LONG_SESSION) || 3000;

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
  private given = 0;
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

  /** Notes that an answer of [tokens] went into the agent's context. */
  spend(tokens: number): void {
    this.given += tokens;
  }

  /**
   * Whether this session's answers already fill much of the agent's context:
   * a long exploration, where every token added now is re-read on each of
   * its many later turns, so answers should stay short.
   */
  get long(): boolean {
    this.checkReset();
    return this.given > longSession;
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
    this.given = 0;
  }
}
