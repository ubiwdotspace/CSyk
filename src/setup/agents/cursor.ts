import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { noteFor, skill } from '../../guide.ts';
import { onPath } from '../../precision/lsp-service.ts';
import { type Agent, fileStep, hintStep, home, hookCommand, hooksStep, jsonStep, launcher } from '../steps.ts';

export const cursor: Agent = {
  id: 'cursor',
  name: 'Cursor',
  found: () => Boolean(onPath('cursor') || onPath('cursor-agent')) || existsSync('/Applications/Cursor.app') || existsSync(home('.cursor')),
  gaps: ["Its own Grep cannot be turned off (its permission rules do not reach it), so the agent has both Grep and CSyk grep."],
  steps(scope) {
    const csyk = launcher();
    // Cursor names the open project in ${workspaceFolder}, in a project's .cursor/mcp.json and
    // in the one for every project alike.
    const server = { command: csyk[0], args: [...csyk.slice(1), 'serve', '${workspaceFolder}'] };
    const base = scope === 'user' ? home('.cursor') : '.cursor';
    // Cursor's hooks: a shell command before it runs, and a new chat or a compaction, after which
    // the agent no longer holds the code CSyk showed. Project hooks run in a trusted workspace.
    const run = (name: string) => [{ command: hookCommand(name, 'cursor') }];
    const hooks = hooksStep(join(base, 'hooks.json'), { beforeShellExecution: run('pre-bash'), sessionStart: run('session-reset'), preCompact: run('session-reset') }, { version: 1 });
    if (scope === 'project') {
      return [
        jsonStep(join(base, 'mcp.json'), ['mcpServers', 'csyk'], server),
        hooks,
        // A rule that applies to every chat in this project; Cursor reads .mdc files only.
        fileStep(join(base, 'rules', 'csyk.mdc'), `---\ndescription: Code search with CSyk\nalwaysApply: true\n---\n\n${noteFor('cursor')}\n`),
        fileStep(join(base, 'skills', 'csyk', 'SKILL.md'), skill),
      ];
    }
    // Rules for every project live in Cursor's settings, not in a file setup can write.
    return [
      jsonStep(join(base, 'mcp.json'), ['mcpServers', 'csyk'], server),
      hooks,
      fileStep(join(base, 'skills', 'csyk', 'SKILL.md'), skill),
      hintStep('Cursor → Settings → Rules', 'add this note as a User Rule', noteFor('cursor')),
    ];
  },
};
