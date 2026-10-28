# Baselines

Tool-level scores of the two baselines from PLAN.md §7.4 and of CSyk itself, recorded with
`npm run eval -- --adapter <b0|b1|csyk>`. Tokens are o200k_base counts of what the agent reads.

- **B0:** built-in tools only: ripgrep, then a whole-file read of the first match.
- **B1:** CodeSift over MCP, as its own rules direct (`search_symbols` with source,
  `find_references`, `search_text`).
- **CSyk:** `find` for A and B, `refs` for C, `grep` for E.

Cases are generated from `tsc --lsp` by `eval/generate.ts`, 30 per category, seed 1, leaving out
tests, generated code, function locals and names that are only imported. A cases expect the
top-level or member declarations of a name, never an import path or a same-named local. A B query
must be answered by exactly one name in the repo (same letters, or each query word starting a name
word in order): a query that fits several names equally is ambiguous, not fuzzy. Recorded
2026-10-28.

## excalidraw

[excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) at `14bb42ede` (MIT): a React +
TypeScript monorepo with workspace packages, ~690 TS/TSX files. Its cases are committed
(`eval/cases/excalidraw.*.yaml`).

| cat | metric | B0 | B1 | CSyk | target |
|---|---|---|---|---|---|
| A exact name → definition | P@1 / R@5 | 50.0% / 83.3% | 76.7% / 93.3% | **100% / 100%** | ≥ 99% |
| B fuzzy name → definition | P@1 / R@5 | 3.3% / 16.7% | 86.7% / 93.3% | **100% / 100%** | ≥ 95% / ≥ 99% |
| C all references | recall / precision | 100% / 76.5% | 100% / 78.0% | **100% / 100%** | ≥ 98% / ≥ 98% |
| E text → containing symbol | P@1 / R@5 | 100% / 100% | 100% / 100% | **100% / 100%** | ≥ 95% R@5 |

| cat | tokens mean: B0 · B1 · CSyk | tool calls: B0 · B1 · CSyk |
|---|---|---|
| A | 4,280 · 678 · **42** | 2.0 · 1.0 · 1.0 |
| B | 5,124 · 715 · **34** | 1.3 · 1.0 · 1.0 |
| C | 230 · 164 · **88** | 1.0 · 1.0 · 1.0 |
| E | 12,072 · 25 · **39** | 2.0 · 1.0 · 1.0 |

CSyk's `refs` takes 40 ms at p50 and 121 ms at p95 with the compiler running; starting it adds a
few seconds to the first call.

**Checking C against the compiler's own search.** CSyk's references and the oracle share a method
(each written mention, resolved by the compiler), so their agreement alone proves little. On all 30
excalidraw C cases CSyk was also compared with `textDocument/references`, a different algorithm:
CSyk returned every reference it did, and its only extra lines were `import { … }` and
`export { … } from` specifiers, which that request leaves out and the cases count.

## private-ts

An employer React + Node monorepo (npm workspaces, ~2.3k TS/TSX files), pinned to one commit. Its
cases stay on the machine; only these aggregate numbers are recorded.

| cat | metric | B0 | B1 | CSyk | target |
|---|---|---|---|---|---|
| A exact name → definition | P@1 / R@5 | 40.0% / 55.0% | 86.7% / 96.7% | **100% / 100%** | ≥ 99% |
| B fuzzy name → definition | P@1 / R@5 | 6.7% / 13.3% | 66.7% / 90.0% | **100% / 100%** | ≥ 95% / ≥ 99% |
| C all references | recall / precision | 100% / 66.8% | 99.8% / 70.0% | **100% / 100%** | ≥ 98% / ≥ 98% |
| E text → containing symbol | P@1 / R@5 | 100% / 100% | 100% / 100% | **100% / 100%** | ≥ 95% R@5 |

| cat | tokens mean: B0 · B1 · CSyk |
|---|---|
| A | 2,868 · 673 · **63** |
| B | 561 · 680 · **37** |
| C | 569 · 363 · **121** |
| E | 3,232 · 31 · **42** |

## What the numbers say

- Grep finds every reference but a quarter to a third of what it returns is noise: comments,
  strings, import paths and same-named symbols elsewhere. CodeSift's `find_references` is text
  based and scores the same. Resolving each mention through the compiler removes all of it.
- Grep cannot rank, so an exact-name search often opens an importing file first; it cannot match
  a fuzzy name at all. CSyk ranks the declaration first every time.
- Token layer (P3): across A, B, C and E together CSyk reads 99% fewer tokens than B0 on
  excalidraw and 96% fewer on private-ts, and at least 62% fewer in every single category, at the
  same or a higher pass rate. Its A and B answers cost a twentieth of CodeSift's: one line per
  symbol, no source until `read` asks for it. CodeSift's single bare line still beats CSyk's on E,
  where CSyk also names the enclosing symbol, which is the answer E asks for.
- Tool-level tokens are not agent-level tokens: the headless agent benchmark (P6) measures those.
- CSyk reaches these scores with name matching alone (exact, squashed, prefix, substring, word
  prefix). BM25F over signatures and bodies waits for concept questions (F), where names alone
  fall short.

## mini-ts

The 19 hand-written cases the harness tests itself on (`eval/fixtures/mini-ts`).

| cat | cases | B0 P@1 | CSyk P@1 | B0 recall / precision | CSyk recall / precision |
|---|---|---|---|---|---|
| A | 5 | 40.0% | 100% | – | – |
| B | 5 | 20.0% | 100% | – | – |
| C | 4 | – | – | 100% / 66.4% | 100% / 100% |
| E | 3 | 100% | 100% | – | – |
| F | 2 | 0.0% | P7 | – | – |
