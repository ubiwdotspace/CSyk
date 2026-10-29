# CSyk

A code-search MCP server for AI agents: compiler-grade precision, minimal tokens.

CSyk aims to let an agent find the right code on the first call and read only the part it needs,
for TypeScript/JavaScript (React, Node, NestJS), Python (FastAPI), Go and Dart (Flutter).
Accuracy and token savings are measured by an evaluation suite, not claimed.

**Status:** P1 of [the plan](docs/PLAN.md): TypeScript and JavaScript, five tools, scored in
[docs/BASELINES.md](docs/BASELINES.md).

- Runs locally; code never leaves the machine.
- No telemetry.
- macOS and Linux first; Windows later.

## Using it

Needs Node 22.12 or later. CSyk runs the TypeScript sources directly; there is no build step yet.

```sh
npm install
claude mcp add csyk -- node /path/to/CSyk/src/server/main.ts   # serves the folder Claude runs in
```

`node src/server/main.ts <workspace>` serves another folder. The symbol index is built in memory
when the server starts; the TypeScript compiler (`tsc --lsp`) starts on the first `refs` or `def`.

| Tool | Answers |
|---|---|
| `find` | symbols whose name matches, best first: id, kind, line, signature |
| `outline` | a file's symbols with line ranges, or each file's symbols under a folder |
| `read` | one symbol's exact source, or its signature |
| `refs` | every reference the compiler resolves to the symbol, grouped by file |
| `def` | where a name, or the name at a file position, is declared |

## Evaluation

Needs Node 22.12 or later (`.nvmrc` pins 22).

```sh
npm install
npm run corpora           # fetch the pinned public corpora into eval/corpora/
npm test                  # unit tests, and the oracle against the hand-written cases
npm run eval              # every case through the B0 baseline
npm run eval -- --adapter b1 --corpus <name> --category A
npm run generate -- --corpus <name> --category <A|B|C|E>
```

- Cases live in `eval/cases/<corpus>.<category>.yaml`; categories A–G are defined in
  [PLAN.md §7](docs/PLAN.md). Each case has an `id`, a `query` and the `expect`ed locations
  (`file`, optional inclusive `lines`).
- Corpora are listed in `eval/corpora.yaml` as `<name>: { path, commit?, git?, codesift? }`. A
  `commit` pins the corpus: its cases refuse to run against any other, and with `git`,
  `npm run corpora` fetches that commit without history. Public corpora so far:
  [excalidraw](https://github.com/excalidraw/excalidraw) (React + TS monorepo, MIT).
  `eval/fixtures/mini-ts` is a tiny corpus the harness tests itself against.
- Private corpora (employer code) go in `eval/corpora.local.yaml`, checked out under
  `eval/corpora/`, with their cases in `eval/cases/private/`; all three are git-ignored.
- `npm run generate` writes A, B, C and E cases whose answers come from the TypeScript compiler
  (`tsc --lsp`). References are every mention of a name that the compiler resolves to the
  declaration, so they cross workspace packages and tell same-named symbols apart. Review
  generated cases before trusting them.
- Scores are written to `eval/results/` (git-ignored). Token counts use o200k_base as a stand-in
  for Claude's tokenizer, so they compare adapters rather than give exact numbers.

**Baselines** ([docs/BASELINES.md](docs/BASELINES.md) has the numbers):

- **B0** (`eval/adapters/b0-ripgrep.ts`): an agent with built-in tools only. It greps, then reads
  the first matching file whole, except for references, where the grep lines are the answer.
- **B1** (`eval/adapters/b1-codesift.ts`): CodeSift over MCP, evaluated only, never shipped. The
  corpus names its CodeSift repo in `codesift`; index it first with
  `codesift index <path> --no-watch`. CodeSift names a repo after its git remote, so a checkout
  of a repo already indexed elsewhere needs its remote removed, or it replaces that index.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
