import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { noteFor, skill } from '../../guide.ts';
import { onPath } from '../../precision/lsp-service.ts';
import { type Agent, fileStep, home, hookCommand, hooksStep, jsonStep, launcher, sectionStep } from '../steps.ts';

export const antigravity: Agent = {
  id: 'antigravity',
  name: 'Antigravity',
  found: () => Boolean(onPath('agy')) || existsSync('/Applications/Antigravity.app') || existsSync(home('.gemini', 'antigravity')),
  gaps: [
    'Its own tools cannot be turned off, so the agent has its read_file and shell besides CSyk.',
    'It hides MCP tool schemas until the agent reads them, a call or two before CSyk is first used.',
    'No event marks a compaction, so code shown before one is not shown again for 30 minutes.',
  ],
  steps(scope) {
    const csyk = launcher();
    // agy's hooks (its hooks guide, in the agy binary): named groups in a hooks.json, PreToolUse and
    // PostToolUse grouped by a tool matcher, SessionStart a flat list. A shell search becomes CSyk
    // grep, a ranged read_file counts as shown, a new conversation shows code again.
    const hook = (name: string) => ({ type: 'command', command: hookCommand(name, 'antigravity'), timeout: 10 });
    const hooks = {
      PreToolUse: [{ matcher: 'run_command', hooks: [hook('pre-bash')] }],
      PostToolUse: [{ matcher: 'read_file', hooks: [hook('post-read')] }],
      SessionStart: [hook('session-reset')],
    };
    if (scope === 'project') {
      // A workspace plugin: on in this project only, with its server, rule and skill. Antigravity
      // starts a plugin's server in the plugin's folder, three levels below the project.
      const plugin = join('.agents', 'plugins', 'csyk');
      const server = { mcpServers: { csyk: { command: csyk[0], args: [...csyk.slice(1), 'serve', '../../..'] } } };
      const manifest = { name: 'csyk', description: 'Code search for the agent: definitions, uses, callers and edit impact, from the compiler.' };
      return [
        fileStep(join(plugin, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`),
        fileStep(join(plugin, 'mcp_config.json'), `${JSON.stringify(server, null, 2)}\n`),
        fileStep(join(plugin, 'rules', 'AGENTS.md'), `${noteFor('antigravity')}\n`),
        fileStep(join(plugin, 'skills', 'csyk', 'SKILL.md'), skill),
        hooksStep(join(plugin, 'hooks.json'), hooks, {}, 'csyk'),
      ];
    }
    // For every project: the editor reads ~/.gemini/antigravity and names the open folder in
    // ${workspace.path}; the agy command line reads ~/.gemini/config and starts servers in the project.
    const steps = [
      jsonStep(home('.gemini', 'antigravity', 'mcp_config.json'), ['mcpServers', 'csyk'], {
        command: csyk[0],
        args: [...csyk.slice(1), 'serve', '${workspace.path}'],
      }),
    ];
    if (onPath('agy') || existsSync(home('.gemini', 'config'))) {
      steps.push(jsonStep(home('.gemini', 'config', 'mcp_config.json'), ['mcpServers', 'csyk'], { command: csyk[0], args: [...csyk.slice(1), 'serve'] }));
      steps.push(hooksStep(home('.gemini', 'config', 'hooks.json'), hooks, {}, 'csyk'));
    }
    return [...steps, sectionStep(home('.gemini', 'GEMINI.md'), noteFor('antigravity')), fileStep(home('.gemini', 'config', 'skills', 'csyk', 'SKILL.md'), skill)];
  },
};
