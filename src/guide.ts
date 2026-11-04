/**
 * What an agent is told about CSyk: a short note that is in its context on
 * every turn (CLAUDE.md or a rules file), and a skill it loads when it
 * needs the detail. Both aim at fewer turns, since every turn re-reads the
 * whole context: answer from what a tool returned instead of opening files
 * to confirm it, and ask several things in one call.
 */

/**
 * How to read code, by agent. Claude Code's Edit takes only a file its own Read has opened, and
 * a Read of a few lines is enough for it: CSyk `read` shows the code, Read opens the lines to
 * change, and each counts what the other showed. Other agents read code with CSyk alone.
 */
const reading: Record<'claude' | 'other', string> = {
  claude: `- Read code with CSyk: a symbol → \`read <id>\`, several in one call → \`read <id>, <id>\`, lines
  → \`read file:10-40\`, a large file's symbols → \`read <path>\`. Before an Edit, Read only the
  lines to change, with offset and limit from CSyk's answer: Edit needs a Read, not the whole file.
`,
  other: `- Read code with CSyk \`read\`, not cat, sed or a file tool: a symbol → \`read <id>\`, several in
  one call → \`read <id>, <id>\`, lines → \`read file:10-40\`, a large file's symbols → \`read <path>\`.
`,
};

/**
 * The tools' arguments, for an agent that hides MCP tools' schemas until it reads them
 * (Antigravity): without them, a session spent two calls reading schema files and two more on
 * calls with the wrong arguments before its first answer.
 */
const argumentsLine = `- Arguments: \`grep(pattern, path?, glob?, literal?)\`, \`find(query, kind?, path?)\`, \`read(target)\`,
  \`refs(target)\`, \`calls(target, direction?: in|out, depth?)\`, \`impact(since?)\`.`;

/** The note for [agent]'s always-read instructions; kept short, as it costs tokens on every turn. */
export const noteFor = (agent: string) =>
  note.replace(reading.claude, agent === 'claude' ? reading.claude : reading.other) + (agent === 'antigravity' ? `\n${argumentsLine}` : '');

/** The note for CLAUDE.md or ~/.claude/rules/csyk.md; kept short, as it costs tokens on every turn. */
export const note = `## Code search (CSyk)

- Search code with CSyk \`grep\` (a regex, as for Grep). Every hit names its enclosing function or
  class, and hits in a few small functions bring their source along, so you can often answer
  without opening files.
- A name, or part of one → \`find\`; its uses → \`refs\`; callers or callees → \`calls\`.
${reading.claude}- Start with every search the task suggests, in one turn: a \`grep\` for each error message, name
  or path it mentions, called in parallel. Each extra turn re-reads your whole context.
- After editing, \`impact\` lists the changed symbols, their callers and the tests to run.`;

/**
 * The skill, as .claude/skills/csyk/SKILL.md: a reference, loaded only when
 * the agent is unsure. Loading it costs a turn and its text is re-read on
 * every later turn: on a signature change in mini-ts, a session that loaded
 * it used 40k tokens against 29k without, for the same answer. What every
 * search needs is in the note; what one answer needs, it says itself.
 */
export const skill = `---
name: csyk
description: Reference for the CSyk code tools (find, grep, read, refs, calls, impact). Load only when unsure which of them fits a question, or what an answer means when it says text, partial or unconfirmed and its own hint is not enough. Not needed for ordinary searches or edits.
---

# CSyk reference

CSyk answers from the language's own compiler (tsc, pyright, gopls, the Dart analysis server).
Trust its answers instead of re-checking with grep or whole-file reads: every extra turn re-reads
your whole context. Make independent calls in parallel, in one turn.

## Which tool

| You have | Call | You get |
|---|---|---|
| text: a message, a label, a regex | \`grep\` (\`path\`, \`glob\` to narrow) | each hit with its line and enclosing symbol |
| a name, or part of one | \`find\` (\`kind\`, \`path\`) | \`file#Name  kind line  signature\` per symbol |
| ids, names or paths | \`read a, b\` | exact source of each symbol; a file's or folder's symbols |
| a symbol, before a rename or signature change | \`refs <id>\` | every use, per file, with its function |
| a symbol, before changing what it does | \`calls <id>\` (\`direction\` in or out, \`depth\` 1–3) | its callers, or what it calls |
| edits in the working tree | \`impact\` (\`since\` a revision) | changed symbols, callers two levels up, test files |

Ids look like \`src/cart/total.ts#Cart.total\`; pass them as they are. \`refs\` lists direct
uses, calls included; for a method, \`calls\` also finds calls through its interface or base class.

## What an answer means

- Its header ends with the source: \`lsp\` (the compiler), \`index\` (syntax only) or \`text\` (no
  language server: a text search, which may list mentions that are not uses).
- \`complete\`: everything is listed. Do not search again to make sure.
- \`partial: N of M mentions resolved in time\`: a very common name. What is listed is right; grep
  the name in the folder you care about for the rest.
- \`unconfirmed …, the compiler cannot tell\`: mentions the compiler could not resolve (an untyped
  receiver, \`any\`, plain JavaScript). They may be uses: read those lines to decide.
- \`… N more; <how>\`: cut to its token budget; the hint says how to see the rest.
- \`[unchanged: <id>, shown at call #n]\`: you saw that source earlier; reuse it.
`;
