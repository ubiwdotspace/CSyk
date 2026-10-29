# Setup

```sh
npm install -g csyk          # or from a clone: npm install && npm run build && npm install -g .
cd your-project
csyk setup
```

`csyk setup` in a terminal asks three things: which agents should use CSyk (Claude Code, Codex,
Antigravity; the ones installed are ticked), whether for this project or every project, and, once
the files are written, whether to install a language server CSyk needs and cannot find (`gopls`
for Go, the Dart SDK for Dart). It lists every file before writing any.

For scripts, name the agents instead:

```sh
csyk setup --write --agent claude,codex,antigravity     # this project
csyk setup --write --user --agent codex                 # every project
csyk setup --agent codex                                # print what it would write
```

## What `csyk setup` writes

For this project, everything goes inside the project and nothing in your home folder:

| Agent | MCP server | Note, always in context | Skill |
|---|---|---|---|
| Claude Code | `.mcp.json` | `CLAUDE.md` | `.claude/skills/csyk/SKILL.md` |
| Codex | `.codex/config.toml`, read once Codex trusts the project | `AGENTS.md` | `.agents/skills/csyk/SKILL.md` |
| Antigravity | a workspace plugin in `.agents/plugins/csyk/`: its `mcp_config.json`, `rules/AGENTS.md` and `skills/` | | |

For every project (`--user`):

| Agent | MCP server | Note | Skill |
|---|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude/rules/csyk.md` | `~/.claude/skills/csyk/SKILL.md` |
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.md` | `~/.codex/skills/csyk/SKILL.md` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json`, and `~/.gemini/config/mcp_config.json` for `agy` | `~/.gemini/GEMINI.md` | `~/.gemini/config/skills/csyk/SKILL.md` |

A second run replaces what the first wrote and leaves everything else in those files alone.

For Claude Code, setup also writes `.claude/settings.json` (`~/.claude/settings.json`): a hook
that resets what CSyk has shown when a session starts or is compacted, and a rule that turns off
Claude Code's own `Grep`.

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

TypeScript and Python come bundled. For Go, CSyk needs `gopls`; for Dart, the Dart or Flutter SDK.
`csyk setup` offers to install them (`go install golang.org/x/tools/gopls@latest`, or Homebrew's
`gopls` and `dart`), and otherwise says how. Install the project's dependencies (`npm install`, `go mod download`,
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
