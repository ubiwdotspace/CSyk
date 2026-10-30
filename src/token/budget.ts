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

/**
 * Lays out [header] and [rows] within the budget, always well-formed: every
 * row, then every compact row, then as many compact rows as fit (or full
 * rows, without compact ones), and last the header alone with the count. A
 * list cut short hides what is past it, and the agent searches again for
 * that, so less on each row comes first, and the cut leaves out no row that
 * would fit. Whatever is left out is said, with the way to narrow the call.
 */
export function fit(header: string, rows: readonly string[], options: FitOptions): Fitted {
  const total = Math.max(options.total ?? rows.length, rows.length);
  const layout = (variant: readonly string[], count: number) => {
    const lines = [header, ...variant.slice(0, count)];
    if (count < total) lines.push(`… ${total - count} more; ${options.narrow}`);
    return lines.join('\n');
  };
  const fits = (variant: readonly string[], count: number) => estimateTokens(layout(variant, count)) <= options.budget;
  for (const variant of [rows, options.compact]) {
    if (variant && fits(variant, rows.length)) return { text: layout(variant, rows.length), shown: rows.length, truncated: rows.length < total };
  }
  // The most rows that fit: every row costs tokens, so fitting is monotonic.
  const variant = options.compact ?? rows;
  let [low, high] = [0, rows.length - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(variant, middle)) low = middle;
    else high = middle - 1;
  }
  if (low > 0) return { text: layout(variant, low), shown: low, truncated: true };
  return {
    text: `${header}\n… ${total} not shown within the budget; ${options.narrow}`,
    shown: 0,
    truncated: total > 0,
  };
}
