import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { noteFor } from '../../guide.ts';
import { onPath } from '../../precision/lsp-service.ts';
import { asRecord, type Agent, staleSkillStep, home, hookCommand, jsonStep, launcher, merge, sectionStep, type Step, withHooks } from '../steps.ts';

export const claude: Agent = {
  id: 'claude',
  name: 'Claude Code',
  found: () => Boolean(onPath('claude')),
  steps(scope, withRefusals) {
    const run = (name: string) => [{ type: 'command', command: hookCommand(name, 'claude') }];
    // A shell search of the code (rg, grep, git grep) is turned down for CSyk grep: with the
    // built-in Grep off, agents search with the shell instead. --hooks also turns down whole
    // reads of long files and greps for a bare name.
    const hooks = {
      PreToolUse: [
        { matcher: 'Bash', hooks: run('pre-bash') },
        ...(withRefusals ? [{ matcher: 'Read', hooks: run('pre-read') }, { matcher: 'Grep', hooks: run('pre-grep') }] : []),
      ],
      // What the agent reads with Read counts as shown: CSyk read points at it, not again.
      PostToolUse: [{ matcher: 'Read', hooks: run('post-read') }],
      SessionStart: [{ hooks: run('session-reset') }],
      PreCompact: [{ hooks: run('session-reset') }],
    };
    // CSyk grep searches as Grep does and names each hit's symbol; with both listed, agents use
    // both, and Grep's tool description costs more tokens on every turn than all of CSyk's tools.
    const permissions = { deny: ['Grep'] };
    const base = scope === 'user' ? home('.claude') : '.claude';
    const launch = launcher();
    const server = { command: launch[0], args: [...launch.slice(1), 'serve'] };
    return [
      scope === 'user' ? userServer(launch) : jsonStep('.mcp.json', ['mcpServers', 'csyk'], server),
      {
        target: join(base, 'settings.json'),
        preview: JSON.stringify({ permissions, hooks }, null, 2),
        apply: () =>
          merge(join(base, 'settings.json'), (config) => {
            const deny = asRecord(config.permissions).deny;
            const denied = Array.isArray(deny) ? deny : [];
            const allDenied = [...denied, ...permissions.deny.filter((rule) => !denied.includes(rule))];
            return { ...config, permissions: { ...asRecord(config.permissions), deny: allDenied }, hooks: withHooks(asRecord(config.hooks), hooks) };
          }),
      },
      // The note goes where it is always in context: CLAUDE.md here, a rules file for every project.
      sectionStep(scope === 'user' ? join(base, 'rules', 'csyk.md') : 'CLAUDE.md', noteFor('claude')),
      ...staleSkillStep(join(base, 'skills', 'csyk', 'SKILL.md')),
    ];
  },
};

// Claude Code keeps servers for every project in its own config; `claude mcp add` writes it.
function userServer(csyk: string[]): Step {
  const command = ['claude', 'mcp', 'add', '--scope', 'user', 'csyk', '--', ...csyk, 'serve'];
  return {
    target: command.join(' '),
    preview: 'adds the CSyk MCP server for every project',
    apply: () => {
      if (!onPath('claude')) return console.log(`Claude Code is not on PATH; run later: ${command.join(' ')}`);
      if (spawnSync('claude', ['mcp', 'get', 'csyk'], { stdio: 'ignore' }).status === 0) return;
      spawnSync(command[0] ?? 'claude', command.slice(1), { stdio: 'inherit' });
    },
  };
}
