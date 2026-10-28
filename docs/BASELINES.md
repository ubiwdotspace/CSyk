# Baselines

Tool-level scores of the two baselines from PLAN.md §7.4, the bar CSyk has to clear. Recorded
with `npm run eval -- --adapter <b0|b1>`; tokens are o200k_base counts of what the agent reads.

- **B0:** built-in tools only: ripgrep, then a whole-file read of the first match.
- **B1:** CodeSift over MCP, as its own rules direct (`search_symbols` with source,
  `find_references`, `search_text`).

## private-ts

An employer React + Node monorepo (npm workspaces, ~2.3k TS/TSX files), pinned to one commit. Its
cases are generated from `tsc --lsp` by `eval/generate.ts` and stay on the machine; only these
aggregate numbers are recorded. 30 cases per category, seed 1. Recorded 2026-10-28.

| cat | metric | B0 | B1 | CSyk target |
|---|---|---|---|---|
| A exact name → definition | P@1 / R@5 | 50.0% / 54.4% | 80.0% / 86.1% | ≥ 99% |
| B fuzzy name → definition | P@1 / R@5 | 16.7% / 26.7% | 70.0% / 100.0% | ≥ 95% / ≥ 99% |
| C all references | recall / precision | 100.0% / 70.3% | 100.0% / 71.3% | ≥ 98% / ≥ 98% |
| E text → containing symbol | P@1 / R@5 | 100.0% / 100.0% | 100.0% / 100.0% | ≥ 95% R@5 |

| cat | tokens mean (B0 → B1) | tool calls (B0 → B1) |
|---|---|---|
| A | 2,651 → 685 | 2.0 → 1.0 |
| B | 1,270 → 685 | 1.4 → 1.0 |
| C | 451 → 305 | 1.0 → 1.0 |
| E | 3,232 → 31 | 2.0 → 1.0 |

What the numbers say:

- Grep finds every reference (recall 100%) but nearly a third of what it returns is noise: comments,
  strings, and a same-named function in another app. CodeSift's `find_references` is text-based too
  and scores the same; compiler-resolved references are where CSyk can pull ahead.
- Grep has no ranking, so an exact-name search often opens an importing file first (P@1 50%).
- Fuzzy names defeat grep outright; CodeSift ranks them into the top five but misses first place
  on almost a third.

## mini-ts

The 19 hand-written cases the harness tests itself on (`eval/fixtures/mini-ts`), B0 only.

| cat | cases | P@1 | R@5 | recall | precision | tokens mean |
|---|---|---|---|---|---|---|
| A | 5 | 40.0% | 100.0% | – | – | 269 |
| B | 5 | 20.0% | 40.0% | – | – | 97 |
| C | 4 | – | – | 100.0% | 66.4% | 84 |
| E | 3 | 100.0% | 100.0% | – | – | 255 |
| F | 2 | 0.0% | 50.0% | – | – | 165 |
