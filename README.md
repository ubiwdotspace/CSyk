# CSyk

A code-search MCP server for AI coding agents: compiler-grade answers in a few dozen tokens.

An agent that explores code with grep and whole-file reads spends most of its context on text it
does not need, and still gets references wrong: comments, strings, imports and same-named symbols
look alike to grep. CSyk answers the questions agents actually ask (where is this defined, who
uses it, who calls it, what does my change touch) from a tree-sitter index and the language's own
compiler, and returns one line per answer.

TypeScript and JavaScript (React, Node, NestJS), Python (FastAPI, Django), Go and Dart (Flutter).
Every number below is measured by the evaluation suite in this repository, on twelve pinned public
repositories, and can be reproduced with one command.

| | grep + read (B0) | CodeSift MCP (B1) | **CSyk** |
|---|---|---|---|
| Definition by exact name, first answer right | 33.1% | 53.7% | **98.6%** |
| Definition by partial name, first answer right | 7.6% | 53.6% | **99.5%** |
| References: share of answers that are real references | 64.1% | 67.7% | **99.2%** |
| Tokens read for the same questions (A, B, C, E) | 16,899 | 1,322 | **240 (−98.6%)** |
| Time per answer, median, server warm | 75 ms | 10 ms | **8 ms** |

Means over the twelve corpora (CodeSift indexes no Dart symbols, which pulls its A and B down);
per-corpus tables are in [docs/BASELINES.md](docs/BASELINES.md).

On public issue benchmarks (SWE-bench Verified, SWE-PolyBench Verified, Multi-SWE-bench; 30 random
issues each), Claude Code with CSyk names more of the functions a real fix changed (+5 to +6 points
in TypeScript, JavaScript and Go, level in Python) in about the same time, but uses 29–38% more
tokens per session; see [Public benchmarks](#public-benchmarks-finding-the-code-an-issue-needs-changed).

- Runs locally. Code never leaves the machine, and there is no telemetry.
- macOS and Linux. Node 22.18 or later.
- Apache-2.0.

## Contents

- [Quick start](#quick-start)
- [Tools](#tools)
- [How it works](#how-it-works)
- [Languages and frameworks](#languages-and-frameworks)
- [Hooks](#hooks)
- [Results](#results)
- [Public benchmarks](#public-benchmarks-finding-the-code-an-issue-needs-changed)
- [Limitations](#limitations)
- [Evaluation](#evaluation)
- [Development](#development)

## Quick start

```sh
npm install -g csyk          # or from a clone: npm install && npm run build && npm install -g .
cd your-project
csyk setup --write           # writes .mcp.json and the hooks into .claude/settings.json
```

`csyk setup` without `--write` prints what it would write: the MCP server entry (equivalent to
`claude mcp add csyk -- csyk serve`), the hooks, and a short note for `CLAUDE.md` that tells the
agent when to use which tool. Start Claude Code in the project and the `csyk` tools are there.

For Go, install `gopls` (`go install golang.org/x/tools/gopls@latest`); for Dart, the Dart or
Flutter SDK. TypeScript and Python support is bundled. `csyk status` (the `status` tool) shows what
is indexed and which language servers run.

Other MCP clients: run `csyk serve [workspace]` as a stdio server.

## Tools

Ten tools, listed in under 1,000 tokens. Every answer fits a token budget (2,000 by default,
`budget` to change it) and says what it left out and how to narrow the call.

| Tool | Question | Answer |
|---|---|---|
| `find` | Where is a symbol, by name or part of one? | one line per symbol: id, kind, line, signature |
| `outline` | What is in this file or folder? | symbols with line ranges |
| `read` | Show me this one symbol | its exact source, or its signature |
| `refs` | Who uses this symbol? | every reference the compiler resolves, per file, with the enclosing symbol |
| `calls` | Who calls it, or what does it call? | callers (`in`) or callees (`out`), up to three levels |
| `impact` | What does my change touch? | changed symbols, their callers two levels up, the test files among them |
| `def` | Where is the name at this position declared? | the declaration |
| `grep` | Where does this text appear? | matches, each with the symbol that contains it |
| `status` | What does CSyk know? | index size, watcher, each language's server |
| `batch` | Several of the above | up to eight calls in one round trip |

What the agent sees, from the excalidraw repository:

```text
> find "restore elements"
2 symbols · index
packages/excalidraw/data/restore.ts#restoreElements  function 960  restoreElements = <T extends ExcalidrawElement>(
packages/excalidraw/components/App.tsx#App.restoreReadyToEraseElements  method 10301  private restoreReadyToEraseElements = () => {

> refs restoreElements
packages/excalidraw/data/restore.ts#restoreElements · 75 refs in 9 files · lsp
packages/excalidraw/components/App.tsx  305, 3621·initializeScene, 4625·addElementsFromPasteOrLibrary
packages/excalidraw/data/blob.ts  26, 163·loadSceneOrLibraryFromBlob
packages/excalidraw/scene/export.ts  61, 572·configExportDimension, 1325·exportToBlob, 1398·exportToClipboard
…

> calls getSceneVersion
calls in · packages/element/src/index.ts#getSceneVersion · 7 callers · lsp
excalidraw-app/collab/Collab.tsx#Collab.initializeRoom  752
excalidraw-app/collab/Collab.tsx#Collab.broadcastElements  973, 977
excalidraw-app/data/firebase.ts#isSavedToFirebase  135
…
```

A `read` of a body the agent already saw, unchanged, returns `[unchanged: <id>, shown at call #n]`
instead of the source again. Each hint appears once per session.

## How it works

**Index.** On start, CSyk parses every source file with tree-sitter (about 1 ms a file) and keeps
the symbols in memory: functions, classes, methods, fields, constants, types, enum members, with
their ranges and signatures, and framework roles as kinds. The index is saved under
`~/.cache/csyk` and only changed files are parsed on the next start. A file watcher re-parses files
whose content changed and tells the language servers; every tool call first applies pending
changes, so answers never lag an edit.

**Names.** `find` ranks exact, squashed (`token store` → `TokenStore`), prefix, substring and
word-prefix matches, weighted by kind, with tests and private helpers lower. A name with no match
gets the three nearest names.

**References.** A language server's own "find references" is limited to one project at a time, so
references across workspace packages go missing. CSyk instead finds every whole-word mention of the
name with ripgrep, asks the language server where each one is declared, and keeps those that land
on the symbol. That crosses packages, tells same-named symbols apart, and leaves out comments and
strings, because the server resolves nothing there. Overloads count as one symbol.

**Calls and impact.** Callers are the references used as values (calls, constructions,
decorators, JSX, callbacks), grouped by the symbol around them. For a method, calls through an
interface or base class declared in the workspace count too, since they may dispatch to it; for
Go, `gopls` names the interfaces a method satisfies. Callees are the calls in a body, each resolved
to its declaration. `impact` maps `git diff` to the symbols it changes and follows callers two
levels up, stopping at tests and at symbols with more than 40 callers.

**Speed.** Answers about the same names are cached until a file changes. A search resolves the
nearest mentions first and stops after five seconds (six for `calls` and `impact`); if it had to
stop, the answer says how many mentions it resolved. Language servers start on first use and stop
after ten idle minutes.

**Precision labels.** Every answer ends its header with where it came from: `index`, `lsp`, or
`text` when a language's server is not installed and CSyk falls back to mentions in code.

## Languages and frameworks

| Language | Index | References, definitions, calls | Framework roles |
|---|---|---|---|
| TypeScript, JavaScript | tree-sitter | `tsc --lsp` (TypeScript 7, bundled) | React components and hooks, NestJS routes and providers |
| Python | tree-sitter | pyright (bundled) | FastAPI routes |
| Go | tree-sitter | `gopls` | |
| Dart | tree-sitter (Dart 3.13 grammar) | the Dart analysis server | Flutter widgets |

Install a project's dependencies (`npm install`, `go mod download`, `flutter pub get`) for the
servers to resolve imports into them; CSyk's answers stay inside the workspace either way.

## Hooks

`csyk setup` wires three Claude Code hooks. Each acts only while a CSyk server serves the folder,
and lets the call through on any error. A hook starts and answers in about 80 ms.

- `pre-read` turns down a whole-file `Read` of a source file over 400 lines and points at
  `outline` and `read`. A read with an offset or a limit always passes.
- `pre-grep` turns down `Grep`, `rg` or recursive `grep` for a bare identifier and points at `find`
  and `refs`. Phrases, regexes and searches outside the workspace pass; shell commands are lexed
  (quotes, pipes, `cd`, redirections), and anything the lexer cannot follow passes.
- `session-reset` (SessionStart, PreCompact) tells CSyk that the agent's context was reset, so
  source it showed before is shown again.

## Results

Twelve public repositories, three per language from small to large, pinned to a commit. Cases are
generated from each language's own server and scored against it; 30 per category unless a small
repository has fewer.

| corpus | A P@1 | B P@1 | C recall / precision | D recall / precision | E R@5 | G recall / precision |
|---|---|---|---|---|---|---|
| zustand (TS, small) | 100% | 100% | 100% / 100% | 100% / 87% | 100% | 96.7% / 91.8% |
| excalidraw (TS, medium) | 100% | 100% | 100% / 100% | 100% / 85.3% | 100% | 98.3% / 96.8% |
| nest (TS, large) | 100% | 100% | 99.2% / 100% | 96.7% / 84.1% | 100% | 95.8% / 96.9% |
| provider (Dart, small) | 100% | 100% | 100% / 100% | 100% / 93.2% | 100% | 70.9% / 89.2% |
| wonderous (Dart, medium) | 100% | 100% | 100% / 100% | 100% / 99.2% | 100% | 100% / 98.2% |
| flame (Dart, large) | 96.7% | 100% | 100% / 100% | 97.9% / 100% | 100% | 71.4% / 80.9% |
| fastapi-template (Python, small) | 100% | 100% | 100% / 100% | 100% / 100% | 100% | 100% / 91.5% |
| dispatch (Python, medium) | 100% | 100% | 100% / 100% | 100% / 92.7% | 100% | 98.8% / 83.7% |
| django (Python, large) | 96.7% | 100% | 96.7% / 96.7% | 100% / 92.7% | 100% | 99.3% / 47.2% |
| chi (Go, small) | 100% | 100% | 100% / 100% | 100% / 100% | 100% | 97.8% / 98.7% |
| pocketbase (Go, medium) | 100% | 96.7% | 100% / 100% | 96.7% / 96% | 100% | 94.9% / 93.4% |
| prometheus (Go, large) | 90% | 96.7% | 93.3% / 93.3% | 93.3% / 91.9% | 100% | 89.3% / 97.2% |

A and B: the first answer is a declaration of the name. C: recall and precision of references
against the compiler. D: callers and callees against the server's call hierarchy. E: a quoted
message's enclosing function in the top five. G: the symbols an edit changes and their callers two
levels up. Latency, per tool and corpus, and the comparison with grep and CodeSift are in
[docs/BASELINES.md](docs/BASELINES.md).

**Against grep and CodeSift** (A and B: first answer right; C: precision; D: recall of callers and
callees, grep only finding callers; tokens: what the agent reads for one case of each of A to E):

| corpus | A P@1: B0 · B1 · CSyk | B P@1: B0 · B1 · CSyk | C precision: B0 · B1 · CSyk | D recall: B0 · B1 · CSyk | tokens A+B+C+D+E: B0 · B1 · CSyk |
|---|---|---|---|---|---|
| zustand | 28.6% · 47.6% · **100%** | 14.3% · 57.1% · **100%** | 46.9% · 45.7% · **100%** | 97.1% · 57.1% · **100%** | 8,838 · 1,496 · **250** |
| excalidraw | 60% · 83.3% · **100%** | 10% · 83.3% · **100%** | 78.3% · 78.3% · **100%** | 100% · 50.4% · **100%** | 17,289 · 1,554 · **325** |
| nest | 36.7% · 90% · **100%** | 10% · 86.7% · **100%** | 69.4% · 71.2% · **100%** | 96.7% · 41.9% · **96.7%** | 9,193 · 1,333 · **285** |
| provider | 24% · 0% · **100%** | 13.6% · 0% · **100%** | 62% · 64.7% · **100%** | 50% · 0% · **100%** | 8,746 · 1,914 · **326** |
| wonderous | 36.7% · 0% · **100%** | 13.3% · 0% · **100%** | 71.8% · 73.1% · **100%** | 66.7% · 0% · **100%** | 27,368 · 408 · **311** |
| flame | 16.7% · 0% · **96.7%** | 0% · 0% · **100%** | 62.9% · 64.1% · **100%** | 94.7% · 0% · **97.9%** | 17,527 · 1,568 · **340** |
| fastapi-template | 57.9% · 36.8% · **100%** | 0% · 57.1% · **100%** | 66% · 73.2% · **100%** | 100% · 54.7% · **100%** | 4,269 · 1,186 · **363** |
| dispatch | 50% · 76.7% · **100%** | 10% · 70% · **100%** | 70.9% · 70.8% · **100%** | 100% · 58.1% · **100%** | 20,938 · 1,550 · **324** |
| django | 40% · 76.7% · **96.7%** | 3.3% · 70% · **100%** | 61.3% · 67% · **96.7%** | 80% · 38.3% · **100%** | 18,646 · 1,489 · **337** |
| chi | 10% · 86.7% · **100%** | 3.6% · 85.7% · **100%** | 49.4% · 57.5% · **100%** | 71.4% · 39.3% · **100%** | 9,197 · 1,163 · **232** |
| pocketbase | 13.3% · 73.3% · **100%** | 3.3% · 63.3% · **96.7%** | 64.5% · 75.9% · **100%** | 66.7% · 33.8% · **96.7%** | 16,039 · 1,320 · **358** |
| prometheus | 23.3% · 73.3% · **90%** | 10% · 70% · **96.7%** | 65.3% · 70.6% · **93.3%** | 98.7% · 27.4% · **93.3%** | 46,703 · 1,512 · **357** |

## Public benchmarks: finding the code an issue needs changed

Tool-level numbers say how good each answer is; what matters in the end is whether an agent finds
the right code. Code localization measures that on real GitHub issues: headless Claude Code
(Claude Sonnet) gets the issue text and the repository at the commit before the fix, and must name
the files and functions to change without editing anything. Its answer is scored against the real,
merged fix, as LocAgent and Agentless report localization: **file Acc@1** (the first file named was
changed), **file Acc@5** (every changed file is among the first five) and **function recall** (the
share of changed functions and methods it named).

Each benchmark contributes 30 issues drawn at random from the whole dataset (seed 1, no filter on
difficulty; each run prints the sample's repositories and difficulty next to the dataset's). The
same issues run twice: **B0**, Claude Code with Read, Grep and Glob, and **CSyk**, the same tools
plus CSyk's MCP server, hooks and CLAUDE.md note. Measured on 2026-10-29; 240 runs cost about $18
at API prices.

| Benchmark | Language | Setup | File Acc@1 | File Acc@5 | Function recall | Time p50 | Tokens, all | Tokens from tools | Cost |
|---|---|---|---|---|---|---|---|---|---|
| [SWE-PolyBench Verified](https://github.com/amazon-science/SWE-PolyBench) (Amazon) | TypeScript | B0 | 96.7% | 46.7% | 65.2% | 11 s | 67,175 | 1,122 | $2.02 |
| | | CSyk | 96.7% | 46.7% | **70.2%** | 13 s | 92,551 (+38%) | 1,394 (+24%) | $2.46 |
| | JavaScript | B0 | 80.0% | 50.0% | 53.8% | 14 s | 80,941 | 1,740 | $2.50 |
| | | CSyk | **90.0%** | **53.3%** | **59.8%** | 15 s | 104,622 (+29%) | 1,697 (−2%) | $2.55 |
| [Multi-SWE-bench mini](https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench_mini) (ByteDance) | Go | B0 | 90.0% | 60.0% | 60.3% | 11 s | 58,108 | 1,506 | $2.22 |
| | | CSyk | **93.3%** | 60.0% | **66.6%** | 12 s | 74,865 (+29%) | 1,230 (−18%) | $2.25 |
| [SWE-bench Verified](https://www.swebench.com) (Princeton, OpenAI) | Python | B0 | 93.3% | 86.7% | 66.0% | 9 s | 47,059 | 719 | $1.99 |
| | | CSyk | 93.3% | 86.7% | 66.3% | 11 s | 63,661 (+35%) | 721 (0%) | $2.00 |

What this shows, plainly:

- **Accuracy goes up or stays.** With CSyk the agent names more of the functions the fix changed in
  every language (+5 to +6 points in TypeScript, JavaScript and Go, level in Python) and picks the
  right first file more often in JavaScript and Go. It is never worse.
- **Time stays about the same**: one to two seconds more per issue at the median, on 9–15 s.
- **Tokens do not go down at the agent level, they go up 29–38%.** Almost all of an agent's tokens
  are its context (system prompt, tool list, conversation) re-read on every turn, and with CSyk
  the agent takes about one more turn per issue. Those re-reads are cached, so cost rises much
  less: 0.5–2% in Python, Go and JavaScript, 22% in TypeScript. What the tools themselves returned
  is small in both setups for this task (700–1,700 tokens per issue), where reading a few files
  answers most issues; CSyk's share is 18% lower in Go and higher in TypeScript.
- 30 issues per benchmark is enough to see differences of 5–10 points, not of 1–2.

The tool-level savings at the top of this README (98.6% fewer tokens than grep and a whole-file
read for the same question) are real per question; this benchmark shows they do not yet turn into
fewer tokens for a whole agent session on short localization tasks. Reducing turns, not answer
size, is the next lever. Reproduce with
`npm run loc -- --dataset <polybench|swebench|multiswebench> --language <name> --setup <b0|csyk> --count 30 --seed 1`
and `npm run loc:report`. Where a dataset does not list the changed functions (SWE-bench,
Multi-SWE-bench), each changed line of the fix is mapped to its enclosing function at the base
commit. Dart has no public benchmark of this kind; its numbers are the tool-level ones above.

## Limitations

- A name written under another name (`import { a as b }`, a default import named differently) is
  not followed.
- Dart's call hierarchy counts implicit `super(...)` constructor calls and calls through framework
  base classes (Flutter's `State`, `Diagnosticable`); CSyk does not follow those, which is most of
  the gap on provider and flame in G.
- pyright's call hierarchy misses calls through module aliases and inferred receivers that CSyk
  finds, so CSyk's precision against it on Python D and G understates.
- A function declared twice under Go build tags resolves to the one `gopls` builds by default.
- A name used thousands of times (Django's `Model.save`) gives a partial answer after the deadline,
  and says so.
- Tool-level tokens are not agent-level tokens: on the public localization benchmarks an agent
  with CSyk is more accurate but uses 29–38% more tokens, from one more turn per issue.

## Evaluation

```sh
npm install
npm run corpora                              # fetch the twelve pinned corpora into eval/corpora/
npm test                                     # unit tests
npm run eval -- --adapter csyk --corpus excalidraw
npm run eval -- --adapter b0                 # every case through the grep baseline
npm run generate -- --corpus <name> --lang <ts|py|go|dart> --category <A|B|C|D|E|G>
```

- **Corpora** are listed in `eval/corpora.yaml` (`path`, `commit`, `git`, `codesift`); a case file
  refuses to run against any other commit. Run `go mod download` in the Go corpora and
  `flutter pub get` in the Dart ones (`packages/*` for provider) so their servers resolve imports.
  Private corpora go in a git-ignored `eval/corpora.local.yaml`, their cases in
  `eval/cases/private/`.
- **Cases** live in `eval/cases/<corpus>.<category>.yaml`: an `id`, a `query`, the `expect`ed
  locations (`file`, optional inclusive `lines`) and, for D, a `direction`. `npm run generate`
  writes them from the language's own server: references are every mention the server resolves to
  the declaration; D and G come from its call hierarchy. Review generated cases before trusting
  them.
- **Baselines.** B0 (`eval/adapters/b0-ripgrep.ts`) is an agent with built-in tools: it greps,
  then reads the first matching file whole; for references and callers the grep lines are its
  answer. B1 (`eval/adapters/b1-codesift.ts`) is CodeSift over MCP, evaluated only; index each
  corpus first with `codesift index <path> --no-watch` (CodeSift names a repository after its git
  remote, so a second checkout of an indexed repository needs its remote removed).
- **Scores** go to `eval/results/` (git-ignored). Token counts use o200k_base as a stand-in for
  Claude's tokenizer.
- **Agent benchmark** (PLAN.md §7.4): `npm run agent:tasks -- --corpus <name>` builds 20 tasks from
  a corpus's cases, and `npm run agent -- --setup <b0|b1|csyk> --corpus <name>` runs them through
  headless Claude Code (`claude -p`, billed to your account), recording tokens, tool calls, wall
  time, cost and passes.
- **Localization on SWE-PolyBench** (Amazon's multi-language benchmark of real GitHub issues):
  `npm run loc -- --setup <b0|csyk> --language TypeScript --count 10` asks headless Claude Code
  which files and functions each issue's fix must change, at the issue's base commit, and scores
  file Acc@1, Acc@5 and function recall against the real fix, with time and tokens.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # JavaScript into dist/, for the npm package
node src/cli.ts serve <workspace>   # run from source (Node strips the types)
```

The design, the phases and the decisions are in [docs/PLAN.md](docs/PLAN.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Dart grammar is built from
tree-sitter-dart (MIT); see [grammars/README.md](grammars/README.md).
