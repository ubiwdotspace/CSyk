/**
 * Case categories from PLAN.md §7.2:
 * A exact-name definition · B fuzzy-name definition · C all references ·
 * D callers / callees · E text → containing symbol · F concept · G impact.
 */
export const categories = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type Category = (typeof categories)[number];

/** Categories scored on a ranked list (P@1, R@5); the rest on a set. */
export const rankedCategories: ReadonlySet<Category> = new Set(['A', 'B', 'E', 'F']);

/**
 * Where an expected answer lives, repo-relative. `lines` is an inclusive
 * range; without it, any line of the file counts.
 */
export type Location = { file: string; lines?: [number, number] };

export type Case = {
  id: string;
  category: Category;
  query: string;
  /** Optional narrowing a tool may use, such as a symbol kind. */
  kind?: string;
  expect: Location[];
};

export type Corpus = {
  name: string;
  /** Absolute path of the checked-out corpus. */
  root: string;
  /** Listed in corpora.local.yaml: its cases stay in cases/private/. */
  private: boolean;
  /** The commit the cases were written against, when pinned. */
  commit?: string;
  /** Its repo id in CodeSift, for the B1 baseline. */
  codesift?: string;
};

/** One answer an adapter gives: a file and the line it points at. */
export type Hit = { file: string; line: number };

export type AdapterResult = {
  /** Answers in rank order. */
  hits: Hit[];
  /** Everything the agent would have read to get them. */
  output: string;
  /** Tool calls it took. */
  calls: number;
};

/** A way of answering cases: a baseline, another tool, or CSyk itself. */
export interface Adapter {
  name: string;
  supports(category: Category): boolean;
  run(c: Case, corpus: Corpus): Promise<AdapterResult>;
  /** Releases what the adapter started, such as a server. */
  close?(): Promise<void>;
}
