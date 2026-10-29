<p align="center">
  <img src="docs/logo.png" alt="CSyk, the one who knows where the code is" width="200">
</p>

<h1 align="center">CSyk</h1>

<p align="center"><em>He doesn't read the file. He knows the line.</em></p>

<p align="center">
  <a href="https://github.com/ubiwdotspace/CSyk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ubiwdotspace/CSyk/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Licence: Apache-2.0" src="https://img.shields.io/badge/licence-Apache--2.0-blue">
  <img alt="Node 22.18 or later" src="https://img.shields.io/badge/node-22.18%2B-339933">
  <img alt="Works with Claude Code, Codex and Antigravity" src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Antigravity-d97757">
  <img alt="TypeScript, JavaScript, Python, Go, Dart" src="https://img.shields.io/badge/languages-TypeScript%20%C2%B7%20JavaScript%20%C2%B7%20Python%20%C2%B7%20Go%20%C2%B7%20Dart-555">
</p>

Code search for AI coding agents. Your agent asks where something is defined, who uses it, who
calls it, or what an edit touches. CSyk answers in a few lines, from an index of the code and from
the language's own compiler, instead of a pile of text-search hits and whole files. It plugs
into the agent as an MCP server.

| **98.6%** | **240 tokens** | **7% fewer tokens** | **8 ms** |
|:---:|:---:|:---:|:---:|
| first answer right when looking up a definition by name (text search: 33.1%) | to answer what costs 16,899 tokens with text search and file reads | per real GitHub issue for Claude Code, over 120 issues in four languages, and faster | per answer, median |

<p align="center">
  <b><a href="#install">Install</a> · <a href="#before-and-after">Before and after</a> · <a href="#numbers">Numbers</a> · <a href="#tools">Tools</a> · <a href="#docs">Docs</a></b>
</p>

Runs on your machine: code never leaves it, and nothing is sent anywhere. macOS and Linux.

---

## Install

```sh
npm install -g csyk          # or: pnpm add -g csyk
cd your-project
csyk setup
```

`csyk setup` asks which agents to set up (Claude Code, Codex, Antigravity) and for which projects,
then adds the MCP server, a short note the agent always reads and a skill. If Go or Dart support
needs a language server you do not have, it offers to install it. Start your agent and the six
CSyk tools are there. Options for scripts, every file it writes, and hooks:
[docs/setup.md](docs/setup.md).

## Before and after

The question an agent asks all day: who uses this? Here, `restoreElements` in the excalidraw
repository.

**Text search** (`rg -n -w restoreElements`): 100 lines and 3,094 tokens, from 13 files. Imports,
tests and every other line where the name is written, for the agent to sort out:

```text
./excalidraw-app/data/firebase.ts:8:import { restoreElements } from "@excalidraw/excalidraw/data/restore";
./excalidraw-app/data/firebase.ts:222:      restoreElements(await decryptElements(prevStoredScene, roomKey), null),
./excalidraw-app/data/firebase.ts:244:    restoreElements(await decryptElements(storedScene, roomKey), null),
./excalidraw-app/data/firebase.ts:265:    restoreElements(await decryptElements(storedScene, roomKey), null, {
./packages/excalidraw/data/restore.ts:960:export const restoreElements = <T extends ExcalidrawElement>(
… 95 more lines
```

**CSyk** (`refs restoreElements`): 8 lines and 281 tokens. The uses the compiler confirms, one line
per file, with the function each one is in:

```text
packages/excalidraw/data/restore.ts#restoreElements · 75 refs in 9 files · lsp
packages/excalidraw/components/App.tsx  305, 3621·initializeScene, 4625·addElementsFromPasteOrLibrary
packages/excalidraw/data/blob.ts  26, 163·loadSceneOrLibraryFromBlob
packages/excalidraw/data/restore.ts  1390·restoreLibraryItem
packages/excalidraw/index.tsx  420
packages/excalidraw/scene/export.ts  61, 572·configExportDimension, 1325·exportToBlob, 1398·exportToClipboard
packages/excalidraw/tests/data/restore.test.ts  58, 77, 89, 97, 112, 118, 123, 128, 140, 149, 166, …
… 3 more; grep the name with a path to see them
```

Same question, a tenth of the tokens, and the agent can act on it without opening a file.

## Numbers

**Single questions** on twelve public repositories (three per language, small to large), scored
against each language's own compiler:

| | Text search and file reads | **CSyk** |
|---|---|---|
| Finding a definition by its exact name: first answer right | 33.1% | **98.6%** |
| Finding a definition by part of its name: first answer right | 7.6% | **99.5%** |
| Finding uses of a symbol: share of answers that really are uses | 64.1% | **99.2%** |
| Tokens the agent reads to answer the same questions | 16,899 | **240 (98.6% fewer)** |
| Time per answer (median) | 75 ms | **8 ms** |

**Whole agent sessions** on four benchmarks of real GitHub issues: over all 120 issues, Claude
Code with CSyk used 7% fewer tokens (11% in JavaScript, 10% in Python, 8% in Go, level in
TypeScript), finished sooner per issue, and named 3.4 points more of the functions the fix changed.

Method, every repository and every run: [docs/benchmarks.md](docs/benchmarks.md).

## Against Serena and Graphify

[Serena](https://github.com/oraios/serena) gives the agent an IDE: tools to find, edit and refactor
code through language servers. [Graphify](https://github.com/Graphify-Labs/graphify) turns a whole
project, docs included, into a knowledge graph to explore. CSyk does one job, finding code for the
agent, and does it this way:

- **Only finding code.** The agent already edits well with its own tools; it is slow at finding
  the place to edit.
- **Few tools, short answers.** An agent re-reads every tool description and every answer on every
  turn, so six tools and answers under 2,000 tokens.
- **The compiler decides.** A use or a caller counts only when the language's compiler confirms it.
- **Always current.** Every edit is indexed before the next answer; there is nothing to rebuild.

Measured on that job, each tool asked the way its own tools allow:

| | **CSyk** | Serena | Graphify |
|---|---|---|---|
| Definition by exact name: first answer right | **98.6%** | 85.1% | 79.9% |
| Definition by part of a name: first answer right | **99.4%** | 17.0% | 31.6% |
| Uses of a symbol: found / correct | **97.3% / 97.8%** | 76.5% / 81.2% | 28.6% / 41.6% |
| Callers and calls: found / correct | **98.7% / 93.5%** | 77.5% / 75.0% | 47.7% / 53.8% |
| From a message to the function it is in | **100%** | no such tool | 11.9% |
| Tokens per answer | **115** | 243 | 719 |
| Time per answer, median: a name / its uses | **1 ms / 45 ms** | 234 ms / 592 ms | 1 ms / 1 ms, from a graph built first |
| CPU for the same questions on twelve repositories, from cold | **205 s** | 2,764 s | 353 s |
| Peak memory, mean per repository | **887 MB** | 1,535 MB | 895 MB |
| Claude Code on 40 real issues: tokens, against Claude Code alone | **−7%** | +8% | +53% |

CPU and memory include the language servers each tool starts and, from cold, building CSyk's
index, Serena's cache and Graphify's graph. The issues are ten per language, so a few points
either way are noise. Why the others take longer, and every number:
[docs/benchmarks.md](docs/benchmarks.md#against-serena-and-graphify).

## Tools

Six tools, 539 tokens of descriptions in all. Every answer stays under 2,000 tokens and says what
it left out.

| Tool | Question |
|---|---|
| `find` | Where is a symbol, by name or part of a name? |
| `grep` | Where does this text appear, and in which function? |
| `read` | Show me this symbol, file, folder or line range. |
| `refs` | Who uses this symbol? |
| `calls` | Who calls this, or what does it call? |
| `impact` | What does my change touch, up to the tests? |

## Docs

- [Setup](docs/setup.md): what `csyk setup` writes, languages, hooks, other agents.
- [How it works](docs/how-it-works.md): the index, the compiler, the answers, limitations.
- [Benchmarks](docs/benchmarks.md): method, all results, and how to reproduce them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
