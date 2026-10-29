# Setup

```sh
npm install -g csyk          # or from a clone: npm install && npm run build && npm install -g .
cd your-project
csyk setup --write           # sets up Claude Code for this project
```

## What `csyk setup` writes

1. `.mcp.json`: tells Claude Code to start CSyk (the same as `claude mcp add csyk -- csyk serve`).
2. `.claude/settings.json`: turns off Claude Code's own `Grep` tool, since CSyk's `grep` replaces
   it (see below).
3. A short note in `CLAUDE.md` telling the agent which CSyk tool to use when.
4. `.claude/skills/csyk/SKILL.md`: a longer guide the agent loads when it needs it.

Without `--write`, it only prints them. With `--user`, it writes them for every project (the note
goes to `~/.claude/rules/csyk.md`). Then start Claude Code in the project.

**Why turn off `Grep`.** CSyk's `grep` searches the same way (ripgrep, regular expressions, a
`path` and a `glob`), and also says which function each match is in. When an agent has both, it
uses both, and the description of `Grep` alone costs more tokens on every turn than all six CSyk
tools together. To keep `Grep`, remove `"Grep"` from `permissions.deny` in `.claude/settings.json`.

## Languages

| Language | Index | Uses, definitions, calls | Recognised framework parts |
|---|---|---|---|
| TypeScript, JavaScript | tree-sitter | TypeScript 7 compiler (bundled) | React components and hooks, NestJS routes and providers |
| Python | tree-sitter | pyright (bundled) | FastAPI routes |
| Go | tree-sitter | `gopls` | |
| Dart | tree-sitter (Dart 3.13 grammar) | the Dart analysis server | Flutter widgets |

For Go, install `gopls` (`go install golang.org/x/tools/gopls@latest`); for Dart, the Dart or
Flutter SDK. Install the project's dependencies (`npm install`, `go mod download`,
`flutter pub get`) so the compilers can follow imports into them. CSyk's answers only point inside
the project either way.

## Hooks

Hooks are small programs Claude Code runs before or after a tool call. `csyk setup` adds one:

- `session-reset`: when a session starts or its context is compacted, tells CSyk to send code
  again that it had already shown.

`csyk setup --hooks` adds two more, which refuse certain calls and point the agent to CSyk
instead. They are off by default: each refused call costs the agent a turn, and on the public
benchmarks the agent used fewer tokens without them.

- `pre-read`: refuses reading a whole source file over 400 lines and suggests `read` with the
  file's path. Reading part of a file is always allowed.
- `pre-grep`: refuses a text search for a single identifier and suggests `find` and `refs`.
  Phrases, regular expressions and searches outside the project are allowed.

Each hook only acts while CSyk serves the folder, lets the call through if anything goes wrong,
and answers in about 80 ms.

## Other agents

Any agent that supports MCP can run `csyk serve [folder]`, which talks over standard input and
output.
