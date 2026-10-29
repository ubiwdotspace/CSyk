# CSyk — plan

A code-search MCP server for AI agents: compiler-grade precision, minimal tokens.
Languages: TypeScript/JavaScript (React, Node, NestJS), Python (FastAPI), Go, Dart (Flutter).

Status: P0 (evaluation harness), P1 (TS/JS index, compiler references, MCP server), P2 (fuzzy
names, `grep`, zero-hit suggestions), P3 (token layer), P4 (Python, Go, Dart through pyright,
gopls and the Dart analysis server; framework labels) and P5 (`calls`, `impact`, `status`,
watcher, saved index, deadlines) are done, with P6's hooks, `csyk setup`, the npm build and the
agent benchmark runner; scores are in [BASELINES.md](BASELINES.md). Left: running the agent
benchmark (P6) and P7. BM25F over signatures and bodies is deferred: name matching already meets
the P2 bar, and BM25F is for concept questions (F).

---

## 1. Goals and non-goals

**Goals**

1. An agent finds the right code on the first call, and reads only the part it needs.
2. Accuracy ≥ 95% in most contexts, **measured** by an evaluation suite (§7), not claimed.
3. ≥ 60% fewer tokens than built-in Grep + Read on the same tasks.
4. One tool, one install, small tool surface (~10 tools).
5. Built only from MIT / Apache / BSD parts; ideas from other tools are reimplemented, never copied.

**Non-goals**

- No 150-tool catalogue. Audits (dead code, complexity, clones, secrets) stay with dedicated CLIs
  (knip, ESLint, jscpd, gitleaks).
- No telemetry. If ever added: opt-in, off by default, documented endpoint.
- No hosted service. Everything runs locally; code never leaves the machine.

---

## 2. Where each part comes from

| Part | Source | How it is used |
|---|---|---|
| TS/JS precision (symbols, refs, defs, call hierarchy, rename) | `typescript` 7 native compiler, `tsc --lsp --stdio` (Apache-2.0) | npm dependency, run as an LSP server |
| Python precision | `pyright` / `basedpyright` language server (MIT) | external binary over LSP |
| Go precision | `gopls` (BSD-3) | external binary over LSP |
| Dart/Flutter precision | `dart language-server` from the Dart SDK (BSD-3) | external binary over LSP |
| LSP client | `vscode-jsonrpc` + `vscode-languageserver-protocol` (MIT) | npm dependency |
| Fast parsing for every language | `web-tree-sitter` + grammars for TS, JS, Python, Go, Dart (MIT; verify Dart grammar) | npm dependency + vendored `tags.scm` queries (with attribution) |
| BM25F ranking + fuzzy match | `minisearch` (MIT) | npm dependency |
| Text search | `@vscode/ripgrep` (MIT) | npm dependency (bundled binary) |
| Storage | `better-sqlite3` (MIT) | npm dependency |
| File watching | `chokidar` (MIT) | npm dependency |
| Compact output | TOON encoder (MIT per listing; verify) or own table encoder | dependency or vendored, decided in P3 |
| Static embeddings (optional) | Model2Vec `potion-code-16M` weights (verify licence) | own TS inference: tokenize → row lookup → mean-pool → L2 |
| MCP server | `@modelcontextprotocol/sdk` (MIT) | npm dependency |
| Hooks | Claude Code hooks | own scripts |

**Reimplemented from ideas only (no code copied):** search hits mapped to the function that
contains them, "source already shown" ledger, tiered response shortening, short hint codes,
redirect hooks. Other code-search tools are references for ideas, never for code.

---

## 3. Architecture

```
Claude Code ──stdio──► MCP server (tool surface, ~10 tools)
                          │
                          ├─ Token layer ── budget tiers · table/TOON output · shown-source ledger · hints
                          │
                          ├─ Ranking ────── BM25F (MiniSearch) · fuzzy · kind bonus · centrality · test demotion
                          │                 · RRF with semantic (optional)
                          │
                          ├─ Precision ──── LSP manager: tsc --lsp · pyright · gopls · dart
                          │                 (lazy start, idle stop)
                          │
                          ├─ Index ──────── tree-sitter symbols + ranges + imports → SQLite
                          │                 file hash per file · import graph · in-degree
                          │
                          └─ Workspace ──── .gitignore aware · monorepo detection
                                            (package.json workspaces, pubspec.yaml, go.mod, pyproject.toml)
```

### 3.1 Two layers, labelled results

- **Index layer (tree-sitter):** fast, every language, always available. Gives symbols, ranges,
  signatures, docstrings, imports. Used for search, outline, containing-symbol mapping and the
  import graph.
- **Precision layer (compiler / LSP):** type-aware. Used for references, definitions, call
  hierarchy, rename.
- Every result carries `precision: lsp | index | text`, so the agent knows how far to
  trust it. When an LSP is missing (no Go toolchain, no Flutter SDK, no Python venv), tools fall
  back to the index and say so.

### 3.2 Symbol model

```ts
type Symbol = {
  id: string;           // "<relpath>#<Qualified.name>" + "~n" for overloads
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "enum" | "const"
      | "component" | "hook" | "widget" | "route" | "provider" | "test";
  lang: "ts" | "js" | "py" | "go" | "dart";
  file: string;         // repo-relative
  range: [startLine, endLine];
  signature: string;    // one line, truncated
  doc?: string;         // first paragraph only
  parent?: string;      // containing symbol id
  exported: boolean;
  isTest: boolean;
  hash: string;         // content hash of the body
};
```

**Framework labels** (as `kind`, so they rank and filter):

- React: `component` (PascalCase function returning JSX), `hook` (`use*`).
- NestJS: `route` from `@Controller` + `@Get/@Post/...`; `provider` from `@Injectable`.
- FastAPI: `route` from `@app.get/...` and `@router.*`.
- Flutter: `widget` (class extends `StatelessWidget` / `StatefulWidget` / `State<...>`).
- Go: `route` for common routers (net/http `HandleFunc`, gin, chi), behind a flag.

### 3.3 Ranking

- **BM25F fields and starting weights:** name 3.0 · signature 2.0 · doc 1.5 · body (first 500
  chars) 1.0 · comments 0.5. Tuned in P2 against the eval suite.
- **Tokeniser:** split camelCase, PascalCase, snake_case and kebab-case; lowercase; drop tokens
  shorter than 2 characters. Example: `handleTokenRefresh` → `handle token refresh`.
- **Boosts:** kind bonus (function/component 1.0, method/hook 0.9, class/widget 0.8, type 0.5);
  file centrality = import in-degree (log-scaled); test files × 0.3 unless the query or a filter
  asks for tests.
- **Cutoff:** drop results scoring under 15% of the top score, but keep at least 3.
- **Hybrid (optional):** RRF with k = 60 over the BM25 and semantic lists.

---

## 4. Tool surface

Rules for every tool:

- Repo-relative paths only.
- Default budget ≈ 2,000 tokens per response; `budget` parameter to change it.
- Tables, not JSON, for lists.
- Each list ends with one short hint line, at most once per session per hint.

| Tool | Input | Output | Precision |
|---|---|---|---|
| `find` | `query`, `kind?`, `path?`, `lang?`, `limit=10` | table: id · kind · file:line · signature | index (+fuzzy) |
| `outline` | `file` or `dir`, `depth=2` | indented symbol tree, no bodies | index |
| `read` | `id` or `name`, `mode = body \| signature`, `context=0` | exact symbol body, or `[unchanged: <id>]` pointer | index (ranges) |
| `refs` | `id` or `name`, `limit=50`, `include_text=false` | grouped by file: line · containing symbol | lsp, plus flagged text candidates |
| `def` | `name` or `file:line:col` | location (+ body when `with_body`) | lsp |
| `calls` | `id`, `direction = in \| out`, `depth=1..3` | tree of callers or callees | lsp, index fallback |
| `grep` | `pattern`, `regex?`, `path?`, `limit=30` | hits mapped to containing symbol, at most 2 per symbol, ranked | text |
| `impact` | `since="HEAD~1"` or `diff` | changed symbols → callers (depth 2) → affected tests | lsp + index |
| `batch` | up to 8 sub-queries of the tools above | one combined response | — |
| `status` | — | index freshness, LSPs up or down, symbol counts | — |
| `semantic` (P7) | `query`, `limit=10` | same table as `find` | embedding |

### 4.1 Zero-hit behaviour (`find`, `grep`)

1. Fuzzy names: edit distance ≤ 2 and substring matches over the symbol vocabulary.
2. If semantic search is enabled: a 300 ms-capped semantic fallback.
3. One line: "no exact hit; nearest: a, b, c". The agent does not have to guess again.

### 4.2 `refs` recall for dynamic code

Compiler refs miss dynamic access: Python `getattr`, JS string keys, NestJS DI tokens, Flutter
`Provider.of<T>` / `context.read<T>()`. With `include_text=true`, `refs` also returns textual
mentions not already in the compiler set, labelled `text`. The two-tier answer is what makes high
recall reachable in "most contexts".

### 4.3 Output example

```
find "calcOrderTotal" · 2 hits · precision: index (fuzzy)
id                                                        kind  file:line                                                    signature
packages/billing/order-total.ts#calculateOrderTotal  fn  …/order-total.ts:91  ({ items, discounts, … }) => number
packages/billing/order-total.ts#getLineItemPrice  fn  …/order-total.ts:147  ({ sku, … }) => number | undefined
hint: read <id> for the body · refs <id> for usages
```

---

## 5. Token layer

1. **Budget tiers.** full → compact table → counts only. Arrays are capped step by step
   (30 → 10 → 5 → 3) and the output stays well-formed. Truncation always names the parameter that
   narrows the query.
2. **Shown-source ledger.** Key = symbol id + body hash. A repeat `read` of an unchanged body
   returns `[unchanged: <id>, shown at call #n]`.
   - Record only after the response is fully built and not truncated.
   - Reset when the `SessionStart` or `PreCompact` hook writes a timestamp marker file.
   - TTL of 30 minutes, for hosts that compact without hooks.
   - Never cache a response that contains a pointer.
3. **Short hints.** One line, plain words, only naming tools that are actually registered, and each
   hint at most once per session.
4. **Small tool list.** About 10 tools with one-sentence descriptions; target < 1,000 tokens for
   the whole tool list.
5. **`batch`.** Several lookups in one round trip.

---

## 6. Freshness and hooks

**Index updates**

- chokidar watcher plus a `PostToolUse` (Edit/Write) hook that pings the server to reindex that
  file (debounced 200 ms).
- Each file is re-parsed only when its content hash changes; its rows in BM25, the graph and the
  vectors are replaced.
- Open LSP documents get `didChange` / `didSave`.
- Response cache key = index version (SQLite file + WAL mtime and size) + git HEAD / index stat.
  No git subprocess on the hot path.

**Hooks**

- **`PreToolUse` Read.** Deny only when the file is over 400 lines **and** no `offset`/`limit` was
  given. The deny message opens with "Reading a range with offset+limit is allowed and needs no
  search", then names `outline` / `read`.
- **`PreToolUse` Grep / Bash (`rg`, `grep -r`).** Redirect only when the pattern is a bare
  identifier (`^[A-Za-z_]\w{2,}$`), and point to `find` / `refs`. Regex and phrase searches pass
  through.
  - Resolve the directory the command actually targets, not just the cwd, so a search outside the
    repository is never refused.
  - Lex the shell command properly: quotes, heredocs, `$(...)`.
- **All hooks.** Fail open: any error means allow. Never redirect when the server is not running.
- **`SessionStart` / `PreCompact`.** Write the ledger reset marker.

---

## 7. Evaluation — how "≥ 95%" is measured

### 7.1 Corpora (pinned commits)

Three public corpora per language, from small to large, all MIT, Apache-2.0 or BSD
(`eval/corpora.yaml` pins each commit):

| Language | Small | Medium | Large |
|---|---|---|---|
| TS / JS | `pmndrs/zustand` (React state) | `excalidraw/excalidraw` (React monorepo) | `nestjs/nest` (NestJS) |
| Python | `fastapi/full-stack-fastapi-template` | `Netflix/dispatch` (FastAPI app) | `django/django` |
| Go | `go-chi/chi` (router) | `pocketbase/pocketbase` | `prometheus/prometheus` |
| Dart | `rrousselGit/provider` | `gskinnerTeam/flutter-wonderous-app` | `flame-engine/flame` |

A private employer monorepo was measured through P4 and has since been removed; its cases were
never committed.

### 7.2 Case categories and targets

| Cat | Question | Metric | Target |
|---|---|---|---|
| A | definition by exact name | P@1 | ≥ 99% |
| B | definition by fuzzy / partial name | P@1, R@5 | ≥ 95%, ≥ 99% |
| C | all references | recall and precision vs oracle | ≥ 98%, ≥ 98% |
| D | callers / callees depth 1 | recall vs oracle | ≥ 97% |
| E | text / error string → containing symbol | R@5 | ≥ 95% |
| F | concept ("where are tokens refreshed") | R@5 | ≥ 85%, stretch 95% (needs P7) |
| G | impact of a real diff (changed symbols + callers + tests) | recall | ≥ 90% |

- **Overall score** = categories weighted by real usage frequency, from aggregate counts of how
  often agents ask each kind of question.
- **Oracle for C and D:** the same compiler / LSP in "oracle mode" (whole project loaded, no time
  limit), with 10% of cases checked by hand.
- **Cases A, B, E, F, G:** hand-written; at least 30 per category per corpus.

### 7.3 Token and cost metrics

- Tokens of tool output per case.
- Tool calls per case.
- Latency p50 / p95.
- Cold index time and peak RAM.

### 7.4 Agent-level benchmark

- 20 realistic tasks per corpus, for example "find where X is validated and list the callers".
- Run with `claude -p` (headless) under two setups:
  - **B0:** built-in Grep/Read only.
  - **CSyk.**
- Record total tokens, tool calls, wall time and pass/fail (judged against the expected files and
  symbols).
- Goal: CSyk pass rate ≥ B0, with ≥ 60% fewer tokens than B0.

### 7.5 Regression gate

- The tool-level eval runs on every change; a drop of more than 1 point in any category fails.
- The agent-level benchmark runs per milestone.

---

## 8. Milestones (rough, one person, part-time)

| Phase | Scope | Exit criteria | Est. |
|---|---|---|---|
| P0 | Repo skeleton, eval harness, case format, TS corpus cases, baselines B0 / B1 | harness runs; baseline numbers recorded | 1 wk |
| P1 | tree-sitter index (TS/JS), in memory; TS precision via `tsc --lsp`; `find` `outline` `read` `refs` `def`; MCP stdio | TS: A ≥ 99%, C ≥ 98% | 1–2 wk |
| P2 | BM25F + fuzzy + boosts + cutoff; `grep` with containing symbol; zero-hit | TS: B ≥ 95%, E ≥ 95% | 1 wk |
| P3 | Token layer: tiers, tables / TOON, ledger, hints, `batch` | ≥ 60% fewer tokens than B0 at equal pass rate | 1 wk |
| P4 | LSP manager (pyright, gopls, dart); Python / Go / Dart grammars; framework labels | per language: A ≥ 97%, C ≥ 95% | 2 wk |
| P5 | `calls`, `impact`, watcher + incremental, SQLite persistence, perf | D ≥ 97%, G ≥ 90%; warm `find` p95 < 150 ms | 1–2 wk |
| P6 | Hooks, install script, Claude Code config snippet, agent benchmark | agent-level goal met on 2+ corpora | 1 wk |
| P7 (opt) | Static embeddings + RRF + `semantic` | F R@5 ≥ 90% | 1 wk |

---

## 9. Performance targets

| Measure | Target |
|---|---|
| Cold index, ~5k files | < 60 s |
| Warm reload from SQLite | < 3 s |
| `find` / `outline` / `read` p95 | < 150 ms |
| `refs` / `calls` p95 (LSP warm) | < 1.5 s |
| RAM, index only | < 300 MB |
| RAM, with tsserver / pyright loaded | < 1.5 GB |

LSPs start lazily on first use and stop after 10 minutes idle.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| LSP memory / startup on big monorepos | lazy start, idle stop, one project per package, index fallback |
| Missing toolchains (Go, Flutter SDK, Python venv) | `status` reports it; results labelled `index`; install hints |
| Dynamic code beyond the compiler | `refs include_text`, `precision` labels |
| Stale index | content hash + watcher + PostToolUse ping + version-keyed cache |
| Agent ignores the tool | short descriptions, CLAUDE.md snippet, identifier-only hooks |
| Hook over-blocking | fail-open, identifier-only redirect, target-dir resolution, tests for the lexer |
| Licences | dependency licence check in CI; NOTICE file; verify the Dart grammar, TOON and potion weights before use |
| Ownership | personal repo; built on own time and own machine; no employer code or cases committed |

---

## 11. Repo layout (proposed)

```
CSyk/
  src/
    server/        MCP server, tool registry, schemas
    workspace/     discovery, ignore rules, monorepo detection
    index/         tree-sitter parsing, symbol model, SQLite store, import graph
    precision/     ts-service.ts, lsp-manager.ts, lsp/{pyright,gopls,dart}.ts
    rank/          bm25f, tokenizer, boosts, rrf
    token/         budget tiers, table/TOON encoder, ledger, hints
    tools/         find, outline, read, refs, def, calls, grep, impact, batch, status, semantic
    hooks/         pre-read, pre-grep, post-edit, session-reset
  queries/         vendored tags.scm per language (with attribution)
  eval/
    cases/         <corpus>.<category>.yaml   (private corpora git-ignored)
    oracle/        oracle-mode runners
    agent/         headless agent benchmark
  docs/
  NOTICE
```

---

## 12. Decisions

**Settled**

1. Name: CSyk, published on npm as `csyk` (the name was free when checked).
2. Licence: open source under Apache-2.0, with a NOTICE file.
3. Distribution: npm (`npm i -g csyk` or `npx csyk`).
4. Platforms: macOS and Linux first; Windows joins CI in P6.

5. Runtime: Node ≥ 22.18, which runs the TypeScript sources directly (type stripping, on by
   default from 22.18) and is what Vitest 5 needs. The npm package ships JavaScript built by
   `npm run build`, since Node does not strip types under `node_modules`.
6. TypeScript 7 (the native Go port). Its npm package no longer exposes the in-process
   LanguageService; its public API is under `typescript/unstable/*`. It does ship an LSP server
   (`tsc --lsp --stdio`), so TS/JS precision goes through the same LSP manager as Python, Go and
   Dart.

7. Persistence (P5): a JSON snapshot of the index under `~/.cache/csyk`, keyed by file size and
   modification time and invalidated by a hash of the index code, instead of SQLite. Cold
   indexing runs at about 0.8 ms a file, so the snapshot only has to spare the parse; the standard
   library does that without a native dependency (`better-sqlite3`) or an experimental one
   (`node:sqlite`).
8. Watching (P5): `fs.watch` with `recursive`, built into Node on macOS and Linux, instead of
   chokidar. Tool calls flush pending changes first, so a PostToolUse ping is not needed.

**Open**

1. Whether P7 (semantic) is needed at all. Decide after P3 numbers for category F.
