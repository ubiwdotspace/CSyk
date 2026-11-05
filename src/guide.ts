/**
 * What an agent is told about CSyk: a short note that is in its context on
 * every turn (CLAUDE.md or a rules file). It aims at fewer turns, since every
 * turn re-reads the whole context: answer from what a tool returned instead
 * of opening files to confirm it, and ask several things in one call. There
 * is no skill: no agent loaded one in about 2,700 benchmark sessions, and
 * its listing cost tokens on every request; what one answer needs, the
 * answer says itself.
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
