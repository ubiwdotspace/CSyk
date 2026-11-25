import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noteFor } from '../../guide.ts';
import { onPath } from '../../precision/lsp-service.ts';
import { type Agent, staleSkillStep, home, hookCommand, hooksStep, launcher, sectionStep, withTomlTable, write } from '../steps.ts';

export const codex: Agent = {
  id: 'codex',
  name: 'Codex',
  found: () => Boolean(onPath('codex')),
  gaps: ["A project's hooks run only once each is trusted in Codex's /hooks."],
  steps(scope) {
    const csyk = launcher();
    // Codex starts MCP servers in the project. It reads a project's .codex/ once the project is
    // trusted, and its hooks once each is trusted in /hooks; its skills from .agents/skills.
    const codexHome = process.env.CODEX_HOME ?? home('.codex');
    const dir = scope === 'user' ? codexHome : '.codex';
    const config = join(dir, 'config.toml');
    const args = [...csyk.slice(1), 'serve'].map((a) => JSON.stringify(a)).join(', ');
    const table = `[mcp_servers.csyk]\ncommand = ${JSON.stringify(csyk[0])}\nargs = [${args}]`;
    // The same events and answers as Claude Code's: Bash is the shell, SessionStart also fires
    // after /clear and a compaction.
    const run = (name: string) => [{ type: 'command', command: hookCommand(name, 'codex') }];
    const hooks = {
      PreToolUse: [{ matcher: 'Bash', hooks: run('pre-bash') }],
      // A file printed by cat, sed -n or head counts as shown: CSyk read points at it, not again.
      PostToolUse: [{ matcher: 'Bash', hooks: run('post-read') }],
      SessionStart: [{ hooks: run('session-reset') }],
      PreCompact: [{ hooks: run('session-reset') }],
    };
    const trust = scope === 'user' ? '' : '\n(read once Codex trusts the project)';
    const hookFile = hooksStep(join(dir, 'hooks.json'), hooks);
    return [
      {
        target: config,
        preview: `${table}${trust}`,
        apply: () => write(config, withTomlTable(existsSync(config) ? readFileSync(config, 'utf8') : '', table)),
      },
      { ...hookFile, preview: `${hookFile.preview}\n(run once each is trusted in Codex's /hooks)` },
      sectionStep(scope === 'user' ? join(codexHome, 'AGENTS.md') : 'AGENTS.md', noteFor('codex')),
      ...staleSkillStep(scope === 'user' ? join(codexHome, 'skills', 'csyk', 'SKILL.md') : join('.agents', 'skills', 'csyk', 'SKILL.md')),
    ];
  },
};
