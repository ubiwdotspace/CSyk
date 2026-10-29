/**
 * What an agent is told about CSyk: a short note that is in its context on
 * every turn (CLAUDE.md or a rules file), and a skill it loads when it
 * needs the detail. Both aim at fewer turns, since every turn re-reads the
 * whole context: answer from what a tool returned instead of opening files
 * to confirm it, and ask several things in one call.
 */

/** The note for CLAUDE.md or ~/.claude/rules/csyk.md; kept short, as it costs tokens on every turn. */
export const note = `## Code search (CSyk)

- Search code with CSyk \`grep\` (a regex, as for Grep). Every hit names its enclosing function or
  class, and hits in a few small functions bring their source along, so you can often answer
  without opening files.
- A name, or part of one → \`find\`; its uses → \`refs\`; callers or callees → \`calls\`.
- One symbol → \`read <id>\`; a large file's symbols → \`read <path>\`. Read a file whole when you
  need most of it.
- Make independent calls in parallel. After editing, \`impact\` lists the changed symbols, their
  callers and the tests to run.`;

/** The skill, as .claude/skills/csyk/SKILL.md. */
export const skill = `---
name: csyk
description: How to search code with the CSyk tools (find, grep, read, refs, calls, impact) in few turns and few tokens. Use when locating code for an issue or a change, tracing who uses or calls something, or checking what an edit affects.
---

# Searching code with CSyk

CSyk answers from a syntax index and the language's own compiler (tsc, pyright, gopls, the Dart
analysis server). Its answers are exact and short; trust them instead of re-checking with Grep or a
whole-file Read. Every extra turn re-reads your whole context, so the fewest calls win.

## Pick the tool

| You have | Call | You get |
|---|---|---|
| a name, or part of one | \`find "token store"\` | one line per symbol: \`file#Name  kind line  signature\` |
| a symbol and want its uses | \`refs <id or name>\` | per file, each line and the function it is in (\`code: true\` adds the text) |
| a symbol and want callers or callees | \`calls <id>\` (\`direction\` in or out, \`depth\` 1–3) | callers with call lines, or callees with their declarations |
| an error message, a label, any text | \`grep "Could not find"\` | each hit with its file, line and enclosing symbol |
| a file or folder | \`read <path>\` | its symbols with line ranges |
| a symbol id | \`read <id>\` (\`mode: signature\` for one line) | exactly its source |
| edits in the working tree | \`impact\` (\`since\` a revision) | changed symbols, callers two levels up, test files |

Ids look like \`src/cart/total.ts#Cart.total\`; pass them to \`read\`, \`refs\` and \`calls\` as they are.

## Recipes

**Locate the code an issue needs changed.** \`grep\` the most specific text in the issue (an error
message, a UI label, an option name) and \`find\` the names it mentions, as parallel calls in one turn. The hits
already name their functions: that is usually the answer. \`read\` only the one or two candidates
you need to be sure of, then \`calls direction=in\` if the fix may belong in a caller.

**Understand a function.** \`read <id>\`, then \`calls <id> direction=out\` for what it relies on and
\`direction=in\` for who relies on it. Do not read whole files around it.

**Change something safely.** \`refs\` before renaming or changing a signature; after editing,
\`impact\` and run the test files it lists.

## Reading the answers

- The header ends with where the answer came from: \`lsp\` (the compiler), \`index\` (syntax only) or
  \`text\`, when a language has no server installed.
- \`partial: N of M mentions resolved in time\`: a very common name; narrow with an id or a path.
- \`… N more; <how>\`: the answer was cut to its token budget; follow the hint or pass \`budget\`.
- \`[unchanged: <id>, shown at call #n]\`: you saw that source earlier in this session; reuse it.

## When to use Read instead

Read a file whole only when you need most of it (a short config, a file you will rewrite), or
with offset and limit around a line CSyk gave you.
`;
