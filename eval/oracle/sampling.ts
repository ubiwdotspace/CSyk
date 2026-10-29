/** A seeded random source (mulberry32): the same seed gives the same cases. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy of [items]. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/** `parseHTTPResponse` → `parse HTTP Response`; snake, kebab and $ split too. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .filter(Boolean);
}

/**
 * A name as someone half-remembering it might type: its words in lower
 * case, the first word cut short, or the first word dropped. Undefined when
 * there is nothing to blur or the blur is too short to say what it is after.
 */
export function fuzzyQuery(name: string, random: () => number): string | undefined {
  const words = splitWords(name);
  if (words.length < 2) return undefined;
  const lower = words.map((word) => word.toLowerCase()).join(' ');
  // SCREAMING_CASE reads as words once lowered; cut up, it reads as noise.
  const shouting = words.every((word) => word === word.toUpperCase());
  const [first = '', ...rest] = words;
  // snake_case and kebab-case keep their separator; camelCase joins.
  const separator = /[_-]/.exec(name.replace(/^[_-]+/, ''))?.[0] ?? '';
  const join = (parts: string[]) => parts.join(separator);
  const styles = shouting
    ? [() => lower]
    : [
        () => lower,
        ...(first.length > 5 ? [() => join([first.slice(0, 4), ...rest])] : []),
        ...(rest.length >= 2 ? [() => join(rest)] : []),
      ];
  const query = styles[Math.floor(random() * styles.length)]?.();
  return query && query !== name && query.length >= 8 ? query : undefined;
}

/**
 * Whether [name] answers [query] at all: the same letters once case and
 * separators are dropped, or each query word starting a name word, in
 * order. A fuzzy case is fair only when one name in the repo answers it.
 */
export function answers(query: string, name: string): boolean {
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (squash(query) === squash(name)) return true;
  const nameWords = splitWords(name).map((w) => w.toLowerCase());
  let at = 0;
  for (const word of splitWords(query).map((w) => w.toLowerCase())) {
    while (at < nameWords.length && !nameWords[at]?.startsWith(word)) at++;
    if (at === nameWords.length) return false;
    at++;
  }
  return true;
}
