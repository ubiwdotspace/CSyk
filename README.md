# CSyk

A code-search MCP server for AI agents: compiler-grade precision, minimal tokens.

CSyk aims to let an agent find the right code on the first call and read only the part it needs,
for TypeScript/JavaScript (React, Node, NestJS), Python (FastAPI), Go and Dart (Flutter).
Accuracy and token savings are measured by an evaluation suite, not claimed.

**Status:** early. The plan is in [docs/PLAN.md](docs/PLAN.md); the evaluation harness comes
first (P0), then the tools.

- Runs locally; code never leaves the machine.
- No telemetry.
- macOS and Linux first; Windows later.

## Evaluation

Needs Node 22.12 or later (`.nvmrc` pins 22).

```sh
npm install
npm test                  # harness unit tests
npm run eval              # every case through the B0 baseline
npm run eval -- --corpus mini-ts --category A
```

- Cases live in `eval/cases/<corpus>.<category>.yaml`; categories A–G are defined in
  [PLAN.md §7](docs/PLAN.md). Each case has an `id`, a `query` and the `expect`ed locations
  (`file`, optional inclusive `lines`).
- Corpora are listed in `eval/corpora.yaml`. `eval/fixtures/mini-ts` is a tiny corpus the
  harness tests itself against.
- Private corpora (employer code) go in `eval/corpora.local.yaml` with their cases under
  `eval/cases/private/`; both are git-ignored and never committed.
- Scores are written to `eval/results/` (git-ignored). Token counts use o200k_base as a stand-in
  for Claude's tokenizer, so they compare adapters rather than give exact numbers.

**B0 baseline** (`eval/adapters/b0-ripgrep.ts`) is an agent with built-in tools only: it greps,
then reads the first matching file whole, except for references, where the grep lines are the
answer.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
