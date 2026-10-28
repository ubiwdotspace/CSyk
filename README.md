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

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
