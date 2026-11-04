import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { noteFor, skill } from '../../guide.ts';
import { onPath } from '../../precision/lsp-service.ts';
import { type Agent, fileStep, home, launcher, sectionStep, type Step, write } from '../steps.ts';

export const hermes: Agent = {
  id: 'hermes',
  name: 'Hermes Agent',
  found: () => Boolean(onPath('hermes')) || existsSync(process.env.HERMES_HOME ?? home('.hermes')),
  gaps: ['Hooks are not set up.'],
  steps(scope) {
    const csyk = launcher();
    // Hermes reads MCP servers from config.yaml in HERMES_HOME (~/.hermes) only, and starts them in the session's
    // folder: one entry serves whichever project Hermes runs in, for both scopes.
    const hermesHome = process.env.HERMES_HOME ?? home('.hermes');
    const config = join(hermesHome, 'config.yaml');
    const server = { command: csyk[0], args: [...csyk.slice(1), 'serve'] };
    const steps: Step[] = [
      {
        target: config,
        preview: `mcp_servers:\n  csyk:\n    command: ${server.command}\n    args: ${JSON.stringify(server.args)}`,
        apply: () => {
          const doc = parseDocument(existsSync(config) ? readFileSync(config, 'utf8') : '');
          doc.setIn(['mcp_servers', 'csyk'], doc.createNode(server));
          write(config, doc.toString());
        },
      },
      fileStep(join(hermesHome, 'skills', 'csyk', 'SKILL.md'), skill),
    ];
    // A project's context is the first of these files that exists, and only that one is read.
    if (scope === 'project') {
      const context = ['.hermes.md', 'HERMES.md', 'AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'].find((f) => existsSync(f)) ?? 'AGENTS.md';
      steps.push(sectionStep(context, noteFor('hermes')));
    }
    return steps;
  },
};
