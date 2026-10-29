/** Tokens per answer unless a tool call asks for another budget. */
export const defaultBudget = 2000;

/** A rough token count: four characters a token, the usual rule for code and English. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type FitOptions = {
  budget: number;
  /** How to narrow the call, named whenever rows are left out. */
  narrow: string;
  /** The same rows with less in each, tried before giving up on rows. */
  compact?: readonly string[];
  /** How many results exist, when more than [rows] were gathered. */
  total?: number;
};

export type Fitted = { text: string; shown: number; truncated: boolean };

// Row counts tried in turn: everything, then fewer and fewer.
const steps = [30, 10, 5, 3];

/**
 * Lays out [header] and [rows] within the budget, always well-formed: rows
 * are cut step by step (30, 10, 5, 3), then the compact rows are tried the
 * same way, and last the header stands alone with the count. Whatever is
 * left out is said, with the way to narrow the call.
 */
export function fit(header: string, rows: readonly string[], options: FitOptions): Fitted {
  const total = Math.max(options.total ?? rows.length, rows.length);
  const counts = [rows.length, ...steps.filter((n) => n < rows.length)];
  for (const variant of [rows, options.compact].filter((v) => v !== undefined)) {
    for (const count of counts) {
      const lines = [header, ...variant.slice(0, count)];
      if (count < total) lines.push(`… ${total - count} more; ${options.narrow}`);
      const text = lines.join('\n');
      if (estimateTokens(text) <= options.budget) return { text, shown: count, truncated: count < total };
    }
  }
  return {
    text: `${header}\n… ${total} not shown within the budget; ${options.narrow}`,
    shown: 0,
    truncated: total > 0,
  };
}
