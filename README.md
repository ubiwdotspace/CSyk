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
  <b><a href="#install">Install</a> · <a href="#languages">Languages</a> · <a href="#before-and-after">Before and after</a> · <a href="#why-csyk">Why CSyk</a> · <a href="#numbers">Numbers</a> · <a href="#tools">Tools</a></b>
</p>

Runs on your machine: code never leaves it, and nothing is sent anywhere. macOS and Linux.

---

## Install

You need Node.js 22.18 or later, on macOS or Linux, and an AI coding agent: Claude Code, Codex or
Antigravity. Any other agent that supports MCP works too, set up by hand.

1. **Install CSyk**, once for your machine:

   ```sh
   npm install -g csyk          # or, with pnpm: pnpm add -g csyk
   ```

2. **Set it up in your project:**

   ```sh
   cd your-project
   csyk setup
   ```

   It asks, with the arrow keys and Enter: which agents should use CSyk (the ones on your machine
   are already ticked), whether for this project or for every project, and whether to write the
   files it lists. Nothing is written before you say yes.

3. **Start your agent in the project.** CSyk starts with it, and the agent has six more tools and a
   short note on when to use them.

## Languages

| | Language | What you need | Also recognises |
|:---:|---|---|---|
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/typescript/typescript-original.svg" alt="TypeScript" width="28"> <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/javascript/javascript-original.svg" alt="JavaScript" width="28"> | TypeScript and JavaScript | nothing more | React components and hooks, NestJS routes and providers |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/python/python-original.svg" alt="Python" width="28"> | Python | nothing more | FastAPI routes |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/go/go-original.svg" alt="Go" width="28"> | Go | `gopls`, Go's language server | |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/dart/dart-original.svg" alt="Dart" width="28"> | Dart and Flutter | the Dart or Flutter SDK | Flutter widgets |

A project can mix these languages: each file is read with its own language's parser and compiler.
TypeScript, JavaScript and Python work as soon as CSyk is installed: their compilers come with it.
For Go and Dart, CSyk uses the compiler you install for those languages. If `csyk setup` does not
find it, it offers to install it for you, or says how. Without it, CSyk still finds names and text
in those files, but cannot confirm which uses and callers are real.

Every file `csyk setup` writes, its options for scripts, and its hooks are in
[setup](docs/setup.md).

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

## Why CSyk

Other tools already give agents more than text search. [Serena](https://github.com/oraios/serena)
gives the agent an IDE: tools to find, edit and refactor code through language servers.
[Graphify](https://github.com/Graphify-Labs/graphify) turns a whole project, docs included, into a
knowledge graph to explore. CSyk does one job, finding code for the agent, and does it this way:

- **Only finding code.** The agent already edits well with its own tools; it is slow at finding
  the place to edit.
- **Few tools, short answers.** An agent re-reads every tool description and every answer on every
  turn, so six tools and answers under 2,000 tokens.
- **The compiler decides.** A use or a caller counts only when the language's compiler confirms it.
- **Always current.** Every edit is indexed before the next answer; there is nothing to rebuild.

## Numbers

The same questions on twelve public repositories (three per language, small to large), and Claude
Code on the first ten issues of four public benchmarks of real GitHub issues:

| | Text search | **CSyk** | Serena | Graphify |
|---|---|---|---|---|
| Definition by name: first answer right | 33.1% | **98.6%** | 85.1% | 79.9% |
| Uses of a symbol: answers that really are uses | 64.1% | **97.8%** | 81.2% | 41.6% |
| Tokens per answer | 3,400 | **115** | 243 | 719 |
| CPU for the same questions on all twelve, from cold | – | **205 s** | 2,764 s | 353 s |
| Claude Code, tokens per issue against Claude Code alone | – | **−7%** | +8% | +53% |

Text search is ripgrep and a read of the first matching file, what an agent does with its built-in
tools; Serena and Graphify answer through their own MCP servers, each asked the way its tools
allow. The [full benchmarks](docs/benchmarks.md) have every repository and kind of question, the
time and memory each tool uses with and without its index built, 30 issues per language, and why
Serena and Graphify take longer.

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

How each answer is built, and what CSyk cannot do yet, is in [how it works](docs/how-it-works.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
