# Setup

```sh
npm install -g @ubiw/csyk    # or: pnpm add -g @ubiw/csyk
                             # or from a clone: npm install && npm run build && npm install -g .
cd your-project
csyk setup
```

With pnpm, CSyk's dependencies (the TypeScript compiler, pyright, ripgrep) come from pnpm's
shared store, so versions another project already installed are not downloaded or stored twice.
The parsers ship inside CSyk as WebAssembly; nothing is built at install.

`csyk setup` in a terminal asks three things: which agents should use CSyk (Claude Code, Codex,
Antigravity, Cursor, OpenCode, Hermes Agent; the ones installed are ticked), whether for this project or every project, and, once
the files are written, whether to install a language server CSyk needs and cannot find (`gopls`
for Go, the Dart SDK for Dart). It lists every file before writing any.

For scripts, name the agents instead:

```sh
csyk setup --write --agent claude,codex,cursor,opencode # this project
csyk setup --write --user --agent codex                 # every project
csyk setup --agent codex                                # print what it would write
```

## What `csyk setup` writes

For this project, everything goes inside the project and nothing in your home folder:

| Agent | MCP server | Note, always in context | Skill |
|---|---|---|---|
| Claude Code | `.mcp.json` | `CLAUDE.md` | `.claude/skills/csyk/SKILL.md` |
| Codex | `.codex/config.toml`, read once Codex trusts the project | `AGENTS.md` | `.agents/skills/csyk/SKILL.md` |
| Antigravity | a workspace plugin in `.agents/plugins/csyk/`: its `mcp_config.json`, `rules/AGENTS.md`, `skills/` and `hooks.json` | | |
| Cursor | `.cursor/mcp.json` | `.cursor/rules/csyk.mdc`, applied to every chat | `.cursor/skills/csyk/SKILL.md` |
| OpenCode | `opencode.json` | `.opencode/csyk.md`, listed in `opencode.json`'s `instructions` | `.opencode/skills/csyk/SKILL.md` |
| Hermes Agent | `~/.hermes/config.yaml`: Hermes reads servers from there only, and serves the folder each session runs in | the context file Hermes reads (`.hermes.md`, `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md`, the first that exists), else a new `AGENTS.md` | `~/.hermes/skills/csyk/SKILL.md` |

OpenCode and Hermes read one of `AGENTS.md` and `CLAUDE.md`, not both: setup never creates an
`AGENTS.md` that would hide a project's `CLAUDE.md` from them.

For every project (`--user`):

| Agent | MCP server | Note | Skill |
|---|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude/rules/csyk.md` | `~/.claude/skills/csyk/SKILL.md` |
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.md` | `~/.codex/skills/csyk/SKILL.md` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json`, and `~/.gemini/config/mcp_config.json` for `agy` | `~/.gemini/GEMINI.md` | `~/.gemini/config/skills/csyk/SKILL.md` |
| Cursor | `~/.cursor/mcp.json` | printed, to add as a User Rule in Cursor's settings (they are not a file) | `~/.cursor/skills/csyk/SKILL.md` |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.config/opencode/csyk.md`, in its `instructions` | `~/.config/opencode/skills/csyk/SKILL.md` |
| Hermes Agent | `~/.hermes/config.yaml` | none: Hermes has no rules file for every project | `~/.hermes/skills/csyk/SKILL.md` |

Hermes Agent's folder is `$HERMES_HOME` when it is set, as Codex's is `$CODEX_HOME`.

A second run replaces what the first wrote and leaves everything else in those files alone.

## The same on every agent

CSyk works the same way in each agent; only where each keeps its configuration differs, and
each agent's setup is its own file in `src/setup/agents/`. What every agent gets, where it allows
it:

| | Claude Code | Codex | Cursor | Antigravity |
|---|---|---|---|---|
| MCP server, note, skill | yes | yes | yes (the note by hand for every project) | yes |
| Its own code search off, so searches go through CSyk | `Grep` turned off | has none: it searches with the shell | no: its permission rules do not reach `Grep` | no: its tools cannot be turned off |
| `pre-bash`: a shell search of the code becomes CSyk `grep` | `PreToolUse` `Bash` | `PreToolUse` `Bash`, in `.codex/hooks.json` | `beforeShellExecution`, in `.cursor/hooks.json` | `PreToolUse` `run_command`, in the plugin's `hooks.json` (`~/.gemini/config/hooks.json` for every project) |
| `post-read`: code the agent read itself counts as shown | `PostToolUse` `Read` | `PostToolUse` `Bash` (`cat`, `sed -n`, `head`, `nl` alone) | not yet | `PostToolUse` `read_file` with `StartLine` and `EndLine` |
| `session-reset`: code is shown again in a new chat or after a compaction | `SessionStart`, `PreCompact` | `SessionStart`, `PreCompact` | `sessionStart`, `preCompact` | `SessionStart`; no event marks a compaction |

`csyk setup` prints what an agent could not be given. Codex runs a project's hooks once each is
trusted in its `/hooks`; Cursor runs them in a trusted workspace. Antigravity hides an MCP tool's
arguments until the agent reads them, a call or two before it first uses CSyk.
OpenCode and Hermes Agent get the server, the note and the skill, without hooks.

For Claude Code, setup also writes `.claude/settings.json` (`~/.claude/settings.json`): a hook
that resets what CSyk has shown when a session starts or is compacted, a rule that turns off
Claude Code's own `Grep`, and a hook that turns down a search of the code from the shell (`rg`,
`grep` over files or folders, `git grep`) with the CSyk `grep` that finds the same matches, so
every search of the code goes through CSyk. A `grep` of a command's output (`npm test | grep
FAIL`), searches in dependencies (`node_modules`, `vendor`, …) or outside the project, and every
search while no CSyk server serves the folder run as usual.

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

Hooks are small programs an agent runs before or after a tool call. `csyk setup` adds these, to
Claude Code, Codex, Cursor and Antigravity where each allows it (see the table above) (`csyk hook <name> --agent <id>` reads and
answers in each one's format):

- `session-reset`: when a session starts or its context is compacted, tells CSyk to send code
  again that it had already shown.
- `pre-bash`: refuses a search of the code from the shell (`rg`, `grep` over files or folders,
  `git grep`) and gives the CSyk `grep` call that finds the same matches, its pattern written as
  ripgrep reads it (grep's `\|`, `-i`, `-w` and `-F` included). With Claude Code's `Grep` turned
  off, agents otherwise search with the shell, which costs more tokens and names no function. A
  `grep` of a command's output, searches in dependencies or outside the project, and every search
  while no CSyk server serves the folder pass.

- `post-read`: notes the lines of a source file the agent read with its own tool (Claude Code's
  `Read`; `cat`, `sed -n 'a,bp'`, `head` or `nl` alone in Codex's shell; Antigravity's
  `read_file` given its lines). A CSyk `read` of a
  symbol inside them, unchanged since, answers with where it is instead of the lines again. A
  shell read of more than 200 lines, or piped into another command, is not counted, as the agent
  may not have seen all of it.

The note tells each agent how to read code. Claude Code's `Edit` only changes a file its own
`Read` has opened, and a `Read` of a few lines is enough: there the note says to read code with
CSyk and, before an edit, to `Read` only the lines to change, with the offset and limit CSyk's
answer gave. Other agents are told to read code with CSyk `read` rather than `cat`, `sed` or their
file tool.

`csyk setup --hooks` adds two more to Claude Code, which refuse certain calls and point the agent to CSyk
instead. They are off by default: each refused call costs the agent a turn, and on the public
benchmarks the agent used fewer tokens without them.

- `pre-read`: refuses reading a whole source file over 400 lines and suggests `read` with the
  file's path. Reading part of a file is always allowed.
- `pre-grep`: refuses a `Grep` for a single identifier, if you turn Claude Code's `Grep` back on,
  and suggests `find` and `refs`.
  Phrases, regular expressions and searches outside the project are allowed.

Each hook only acts while CSyk serves the folder, lets the call through if anything goes wrong,
and answers in about 80 ms.

## Other agents

Any agent that supports MCP can run `csyk serve [folder]`, which talks over standard input and
output.
