import { countTokens as count } from 'gpt-tokenizer';

/**
 * Tokens in [text]. Claude's tokenizer is not public, so this uses
 * o200k_base as a stand-in: absolute counts are approximate, but every
 * adapter is measured the same way, so the comparisons hold.
 */
export function countTokens(text: string): number {
  return text.length === 0 ? 0 : count(text);
}
