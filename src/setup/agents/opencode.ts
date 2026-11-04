import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { noteFor, skill } from '../../guide.ts';
import { onPath } from '../../precision/lsp-service.ts';
import { asRecord, type Agent, fileStep, home, launcher, merge } from '../steps.ts';

export const opencode: Agent = {
  id: 'opencode',
  name: 'OpenCode',
  found: () => Boolean(onPath('opencode')) || existsSync(home('.config', 'opencode')),
  gaps: ['Hooks are not set up.'],
  steps(scope) {
    const csyk = launcher();
    // The note goes in its own file, listed in the config's instructions: OpenCode adds those to
    // AGENTS.md, where a new AGENTS.md would hide a project's CLAUDE.md from it.
    const base = scope === 'user' ? home('.config', 'opencode') : '.opencode';
    const config = scope === 'user' ? join(base, 'opencode.json') : 'opencode.json';
    const noteFile = join(base, 'csyk.md');
    const listed = scope === 'user' ? noteFile : noteFile.split('\\').join('/');
    const server = { type: 'local', command: [...csyk, 'serve'], enabled: true };
    return [
      {
        target: config,
        preview: JSON.stringify({ mcp: { csyk: server }, instructions: [listed] }, null, 2),
        apply: () =>
          merge(config, (current) => {
            const instructions = Array.isArray(current.instructions) ? (current.instructions as unknown[]) : [];
            return {
              ...current,
              mcp: { ...asRecord(current.mcp), csyk: server },
              instructions: instructions.includes(listed) ? instructions : [...instructions, listed],
            };
          }),
      },
      fileStep(noteFile, `${noteFor('opencode')}\n`),
      fileStep(join(base, 'skills', 'csyk', 'SKILL.md'), skill),
    ];
  },
};
