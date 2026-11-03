import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { styleText } from 'node:util';
import { note, skill } from './guide.ts';
import { installHints, onPath, servers } from './precision/lsp-service.ts';
import { choose, confirm } from './tui.ts';

type Scope = 'project' | 'user';
/** One thing setup does for an agent: a file it writes, or a command it runs. */
type Step = { target: string; preview: string; apply: () => void };
type Agent = { id: string; name: string; found: () => boolean; steps: (scope: Scope, hooks: boolean) => Step[] };

/**
 * `csyk setup`: in a terminal with no options, asks which agents and
 * projects to set up and offers to install missing language servers;
 * otherwise prints, or with --write writes, the configuration for the
 * agents named with --agent (Claude Code by default).
 */
export async function setup(args: string[]): Promise<void> {
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) return interactive();
  const named = args.find((a) => a.startsWith('--agent='))?.slice('--agent='.length) ?? (args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined);
  const ids = (named ?? 'claude').split(',');
  const unknown = ids.filter((id) => !agents.some((a) => a.id === id));
  if (unknown.length > 0) throw new Error(`Unknown agent ${unknown.join(', ')}; known: ${agents.map((a) => a.id).join(', ')}`);
  const scope: Scope = args.includes('--user') ? 'user' : 'project';
  const steps = agents.filter((a) => ids.includes(a.id)).flatMap((a) => a.steps(scope, args.includes('--hooks')));
  if (!args.includes('--write')) {
    for (const step of steps) console.log(`${step.target}\n${step.preview}\n`);
    console.log(`Run "csyk setup --write ${args.join(' ')}" to write them, or "csyk setup" in a terminal to choose.`);
    return;
  }
  for (const step of steps) step.apply();
  console.log(`Wrote ${steps.map((s) => s.target).join(', ')}.`);
  for (const missing of missingServers()) console.log(`For ${missing.language}, install ${missing.name}: ${missing.hint}`);
}

async function interactive(): Promise<void> {
  console.log(`${styleText('bold', 'CSyk setup')}\n`);
  const found = agents.map((a) => a.found());
  const picked = await choose(
    'Which agents should search code with CSyk?',
    agents.map((a, i) => ({ label: a.name, hint: found[i] ? 'installed' : 'not found', checked: found[i] })),
    { multi: true },
  );
  if (picked.length === 0) return console.log('No agent picked; nothing written.');
  const [where] = await choose('For which projects?', [
    { label: 'This project', hint: process.cwd() },
    { label: 'Every project', hint: 'your home folder' },
  ]);
  const scope: Scope = where === 0 ? 'project' : 'user';
  const steps = picked.flatMap((i) => agents[i]?.steps(scope, false) ?? []);
  console.log(`\n${steps.map((s) => `  ${s.target.replace(homedir(), '~')}`).join('\n')}\n`);
  if (!(await confirm('Write these?', true))) return console.log('Nothing written.');
  for (const step of steps) step.apply();
  console.log(styleText('green', `Done: ${picked.map((i) => agents[i]?.name).join(', ')} will use CSyk.\n`));

  for (const missing of missingServers()) {
    const plan = missing.install;
    if (!plan) {
      console.log(`For ${missing.language}, install ${missing.name}: ${missing.hint}`);
      continue;
    }
    const commands = plan.map((c) => c.join(' ')).join(' && ');
    const relevant = existsSync(missing.marker);
    if (!(await confirm(`${missing.language} needs ${missing.name}, which is not installed. Run "${commands}"?`, relevant))) continue;
    const failed = plan.find((c) => spawnSync(c[0] ?? '', c.slice(1), { stdio: 'inherit' }).status !== 0);
    console.log(failed ? styleText('red', `"${failed.join(' ')}" failed; ${missing.hint}`) : styleText('green', `${missing.name} installed.`));
  }
  console.log('Start your agent in the project; CSyk starts with it.');
}

/** The language servers CSyk cannot start, with how to install each. */
function missingServers(): { name: string; language: string; marker: string; hint: string; install?: string[][] }[] {
  const plans: Record<string, { language: string; marker: string; install?: string[][] }> = {
    gopls: {
      language: 'Go',
      marker: 'go.mod',
      install: onPath('go')
        ? [['go', 'install', 'golang.org/x/tools/gopls@latest']]
        : onPath('brew')
          ? [['brew', 'install', 'gopls']]
          : undefined,
    },
    dart: {
      language: 'Dart',
      marker: 'pubspec.yaml',
      install: onPath('brew') ? [['brew', 'tap', 'dart-lang/dart'], ['brew', 'install', 'dart']] : undefined,
    },
  };
  return servers.flatMap((s) => {
    const plan = plans[s.name];
    return plan && !s.command() ? [{ name: s.name, hint: installHints[s.name] ?? '', ...plan }] : [];
  });
}

// How this install of CSyk is started: the package's command, or node on a
// clone's build (hooks start in half the time) or else on this file.
function self(): string[] {
  const script = process.argv[1] ?? '';
  if (!script.endsWith('.ts')) return ['csyk'];
  const built = resolve(dirname(script), '../dist/cli.js');
  return ['node', existsSync(built) ? built : resolve(script)];
}

const home = (...parts: string[]) => join(homedir(), ...parts);

export const agents: Agent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    found: () => Boolean(onPath('claude')),
    steps(scope, withHooks) {
      const csyk = self();
      const run = (name: string) => [{ type: 'command', command: `${csyk.join(' ')} hook ${name}` }];
      // A shell search of the code (rg, grep, git grep) is turned down for CSyk grep: with the
      // built-in Grep off, agents search with the shell instead. --hooks also turns down whole
      // reads of long files and greps for a bare name.
      const hooks = {
        PreToolUse: [
          { matcher: 'Bash', hooks: run('pre-bash') },
          ...(withHooks ? [{ matcher: 'Read', hooks: run('pre-read') }, { matcher: 'Grep', hooks: run('pre-grep') }] : []),
        ],
        SessionStart: [{ hooks: run('session-reset') }],
        PreCompact: [{ hooks: run('session-reset') }],
      };
      // CSyk grep searches as Grep does and names each hit's symbol; with both listed, agents use
      // both, and Grep's tool description costs more tokens on every turn than all of CSyk's tools.
      const permissions = { deny: ['Grep'] };
      const base = scope === 'user' ? home('.claude') : '.claude';
      const server = { command: csyk[0], args: [...csyk.slice(1), 'serve'] };
      return [
        scope === 'user' ? claudeUserServer(csyk) : jsonStep('.mcp.json', ['mcpServers', 'csyk'], server),
        {
          target: join(base, 'settings.json'),
          preview: JSON.stringify({ permissions, hooks }, null, 2),
          apply: () =>
            merge(join(base, 'settings.json'), (config) => {
              const existing = asRecord(config.hooks);
              const merged: Record<string, unknown> = { ...existing };
              for (const [event, entries] of Object.entries(hooks)) {
                const current = Array.isArray(existing[event]) ? (existing[event] as unknown[]) : [];
                // An entry already running the same command is not added twice.
                const fresh = entries.filter((e) => !JSON.stringify(current).includes(JSON.stringify(e.hooks[0]?.command)));
                merged[event] = [...current, ...fresh];
              }
              const deny = asRecord(config.permissions).deny;
              const denied = Array.isArray(deny) ? deny : [];
              const allDenied = [...denied, ...permissions.deny.filter((rule) => !denied.includes(rule))];
              return { ...config, permissions: { ...asRecord(config.permissions), deny: allDenied }, hooks: merged };
            }),
        },
        // The note goes where it is always in context: CLAUDE.md here, a rules file for every project.
        sectionStep(scope === 'user' ? join(base, 'rules', 'csyk.md') : 'CLAUDE.md', note),
        fileStep(join(base, 'skills', 'csyk', 'SKILL.md'), skill),
      ];
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    found: () => Boolean(onPath('codex')),
    steps(scope) {
      const csyk = self();
      // Codex starts MCP servers in the project. It reads a project's .codex/config.toml once the
      // project is trusted, and its skills from .agents/skills.
      const codexHome = process.env.CODEX_HOME ?? home('.codex');
      const config = scope === 'user' ? join(codexHome, 'config.toml') : join('.codex', 'config.toml');
      const args = [...csyk.slice(1), 'serve'].map((a) => JSON.stringify(a)).join(', ');
      const table = `[mcp_servers.csyk]\ncommand = ${JSON.stringify(csyk[0])}\nargs = [${args}]`;
      return [
        {
          target: config,
          preview: scope === 'user' ? table : `${table}\n(read once Codex trusts the project)`,
          apply: () => write(config, withTomlTable(existsSync(config) ? readFileSync(config, 'utf8') : '', table)),
        },
        sectionStep(scope === 'user' ? join(codexHome, 'AGENTS.md') : 'AGENTS.md', note),
        fileStep(scope === 'user' ? join(codexHome, 'skills', 'csyk', 'SKILL.md') : join('.agents', 'skills', 'csyk', 'SKILL.md'), skill),
      ];
    },
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    found: () => Boolean(onPath('agy')) || existsSync('/Applications/Antigravity.app') || existsSync(home('.gemini', 'antigravity')),
    steps(scope) {
      const csyk = self();
      if (scope === 'project') {
        // A workspace plugin: on in this project only, with its server, rule and skill. Antigravity
        // starts a plugin's server in the plugin's folder, three levels below the project.
        const plugin = join('.agents', 'plugins', 'csyk');
        const server = { mcpServers: { csyk: { command: csyk[0], args: [...csyk.slice(1), 'serve', '../../..'] } } };
        const manifest = { name: 'csyk', description: 'Code search for the agent: definitions, uses, callers and edit impact, from the compiler.' };
        return [
          fileStep(join(plugin, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`),
          fileStep(join(plugin, 'mcp_config.json'), `${JSON.stringify(server, null, 2)}\n`),
          fileStep(join(plugin, 'rules', 'AGENTS.md'), `${note}\n`),
          fileStep(join(plugin, 'skills', 'csyk', 'SKILL.md'), skill),
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
      }
      return [...steps, sectionStep(home('.gemini', 'GEMINI.md'), note), fileStep(home('.gemini', 'config', 'skills', 'csyk', 'SKILL.md'), skill)];
    },
  },
];

// Claude Code keeps servers for every project in its own config; `claude mcp add` writes it.
function claudeUserServer(csyk: string[]): Step {
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

function jsonStep(path: string, [section, name]: [string, string], value: unknown): Step {
  return {
    target: path,
    preview: JSON.stringify({ [section]: { [name]: value } }, null, 2),
    apply: () => merge(path, (config) => ({ ...config, [section]: { ...asRecord(config[section]), [name]: value } })),
  };
}

function sectionStep(path: string, text: string): Step {
  return { target: path, preview: text, apply: () => writeSection(path, text) };
}

function fileStep(path: string, text: string): Step {
  return { target: path, preview: text.length > 300 ? `${text.split('\n').slice(0, 4).join('\n')}\n…` : text, apply: () => write(path, text) };
}

/** [toml] with the table [block] starts replaced by [block], its subtables included, or [block] added at the end. */
export function withTomlTable(toml: string, block: string): string {
  const header = block.split('\n')[0] ?? '';
  const name = header.slice(1, -1);
  const lines = toml.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) return `${toml}${toml && !toml.endsWith('\n') ? '\n' : ''}${toml ? '\n' : ''}${block}\n`;
  const ownHeader = (line: string) => line === header || line.startsWith(`[${name}.`);
  let end = at + 1;
  while (end < lines.length && !(lines[end]?.startsWith('[') && !ownHeader(lines[end] ?? ''))) end++;
  const rest = lines.slice(end);
  return [...lines.slice(0, at), ...block.split('\n'), ...(rest.length > 0 ? ['', ...rest] : [''])].join('\n');
}

// Puts [text] in [path] between CSyk's markers, replacing what an earlier setup wrote there.
function writeSection(path: string, text: string): void {
  const start = '<!-- csyk:start -->';
  const end = '<!-- csyk:end -->';
  const block = `${start}\n${text}\n${end}`;
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const at = current.indexOf(start);
  const next =
    at >= 0
      ? current.slice(0, at) + block + current.slice(current.indexOf(end, at) + end.length)
      : `${current}${current && !current.endsWith('\n\n') ? (current.endsWith('\n') ? '\n' : '\n\n') : ''}${block}\n`;
  write(path, next);
}

function merge(path: string, change: (config: Record<string, unknown>) => Record<string, unknown>): void {
  const config = existsSync(path) ? asRecord(JSON.parse(readFileSync(path, 'utf8'))) : {};
  write(path, `${JSON.stringify(change(config), null, 2)}\n`);
}

function write(path: string, text: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
