import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTomlTable } from './index.ts';
import { choose } from '../tui.ts';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
const temp = (name: string) => mkdtempSync(join(tmpdir(), `csyk-${name}-`));

const run = (cwd: string, home: string, ...args: string[]) =>
  execFileSync(process.execPath, [cli, 'setup', '--write', ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), HERMES_HOME: join(home, '.hermes'), PATH: '/usr/bin:/bin' },
  });

describe('csyk setup --agent', () => {
  it('sets up Codex and Antigravity inside the project only, and a second run changes nothing', () => {
    const project = temp('project');
    const home = temp('home');
    writeFileSync(join(project, 'AGENTS.md'), '# Agents\n');
    const files = [
      '.codex/config.toml',
      'AGENTS.md',
      '.agents/plugins/csyk/plugin.json',
      '.agents/plugins/csyk/mcp_config.json',
      '.agents/plugins/csyk/rules/AGENTS.md',
      '.agents/plugins/csyk/hooks.json',
    ].map((f) => join(project, f));
    run(project, home, '--agent', 'codex,antigravity');
    const first = files.map((f) => readFileSync(f, 'utf8'));
    run(project, home, '--agent', 'codex,antigravity');
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(first);
    expect(readdirSync(home)).toEqual([]);

    const [toml = '', agents = '', , server = '{}'] = first;
    expect(toml).toMatch(/^\[mcp_servers\.csyk\]\ncommand = "node"\nargs = \[".+", "serve"\]\n$/);
    expect(agents).toMatch(/^# Agents\n\n<!-- csyk:start -->\n## Code search \(CSyk\)/);
    // Antigravity starts a plugin's server in the plugin's folder.
    expect(JSON.parse(server).mcpServers.csyk.args.slice(-2)).toEqual(['serve', '../../..']);
  }, 30_000);

  it('adds to the home configuration for every project, keeping what was there', () => {
    const project = temp('project');
    const home = temp('home');
    execFileSync('mkdir', ['-p', join(home, '.codex'), join(home, '.gemini', 'antigravity')]);
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n');
    writeFileSync(join(home, '.gemini', 'antigravity', 'mcp_config.json'), '{"mcpServers":{"other":{"command":"other"}}}');
    run(project, home, '--user', '--agent', 'codex,antigravity');
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toMatch(
      /^model = "o4"\n\n\[mcp_servers\.other\]\ncommand = "other"\n\n\[mcp_servers\.csyk\]\n/,
    );
    const servers = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity', 'mcp_config.json'), 'utf8')).mcpServers;
    expect(Object.keys(servers)).toEqual(['other', 'csyk']);
    expect(servers.csyk.args.slice(-2)).toEqual(['serve', '${workspace.path}']);
    expect(readdirSync(project)).toEqual([]);
  }, 30_000);
});

describe('csyk setup for Cursor, OpenCode and Hermes Agent', () => {
  it('sets up Cursor and OpenCode in the project, without an AGENTS.md that would hide CLAUDE.md', () => {
    const project = temp('project');
    const home = temp('home');
    writeFileSync(join(project, 'CLAUDE.md'), '# Project\n');
    writeFileSync(join(project, 'opencode.json'), '{"theme":"dark","instructions":["docs/rules.md"]}');
    const files = ['.cursor/mcp.json', '.cursor/rules/csyk.mdc', 'opencode.json', '.opencode/csyk.md'].map(
      (f) => join(project, f),
    );
    run(project, home, '--agent', 'cursor,opencode');
    const first = files.map((f) => readFileSync(f, 'utf8'));
    run(project, home, '--agent', 'cursor,opencode');
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(first);
    expect(readdirSync(home)).toEqual([]);
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('# Project\n');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);

    const [cursor = '{}', rule = '', opencode = '{}', opencodeNote = ''] = first;
    // Cursor names the open project in ${workspaceFolder}.
    expect(JSON.parse(cursor).mcpServers.csyk.args.slice(-2)).toEqual(['serve', '${workspaceFolder}']);
    expect(rule).toMatch(/^---\ndescription: Code search with CSyk\nalwaysApply: true\n---\n\n## Code search \(CSyk\)/);
    const config = JSON.parse(opencode);
    expect(config.theme).toBe('dark');
    expect(config.mcp.csyk).toMatchObject({ type: 'local', enabled: true });
    expect(config.mcp.csyk.command.at(-1)).toBe('serve');
    // Added once to what was listed, never twice.
    expect(config.instructions).toEqual(['docs/rules.md', '.opencode/csyk.md']);
    expect(opencodeNote).toMatch(/^## Code search \(CSyk\)/);
  }, 30_000);

  it('adds Hermes Agent to its config, keeping the rest, and the note to the context file it reads', () => {
    const project = temp('project');
    const home = temp('home');
    execFileSync('mkdir', ['-p', join(home, '.hermes')]);
    writeFileSync(join(home, '.hermes', 'config.yaml'), '# my settings\nmodel: hermes-4\nmcp_servers:\n  other:\n    command: other\n');
    writeFileSync(join(project, 'CLAUDE.md'), '# Project\n');
    run(project, home, '--agent', 'hermes');
    const first = readFileSync(join(home, '.hermes', 'config.yaml'), 'utf8');
    run(project, home, '--agent', 'hermes');
    expect(readFileSync(join(home, '.hermes', 'config.yaml'), 'utf8')).toBe(first);
    expect(first).toMatch(/^# my settings\nmodel: hermes-4\nmcp_servers:\n {2}other:\n {4}command: other\n {2}csyk:\n {4}command: node\n/);
    expect(first).toMatch(/ {4}args:\n(?: {6}- .+\n)* {6}- serve\n$/);
    expect(existsSync(join(home, '.hermes', 'skills'))).toBe(false);
    // Hermes reads one context file, CLAUDE.md here: the note goes there, not into a new AGENTS.md.
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toMatch(/^# Project\n\n<!-- csyk:start -->\n## Code search \(CSyk\)/);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
  }, 30_000);

  it('sets up Cursor and OpenCode for every project in the home folder', () => {
    const project = temp('project');
    const home = temp('home');
    run(project, home, '--user', '--agent', 'cursor,opencode');
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.csyk.args.at(-1)).toBe('${workspaceFolder}');
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(config.instructions).toEqual([join(home, '.config', 'opencode', 'csyk.md')]);
    expect(existsSync(join(home, '.cursor', 'skills'))).toBe(false);
    expect(existsSync(join(home, '.config', 'opencode', 'skills'))).toBe(false);
    expect(readdirSync(project)).toEqual([]);
  }, 30_000);
});

describe('the same hooks for every agent that has them', () => {
  const commands = (value: unknown) => JSON.stringify(value).match(/hook [a-z-]+(?: --agent [a-z]+)?/g) ?? [];

  it('Codex and Cursor in the project: pre-bash and session-reset, in each format, written once', () => {
    const project = temp('project');
    const home = temp('home');
    run(project, home, '--agent', 'codex,cursor');
    run(project, home, '--agent', 'codex,cursor');
    const codex = JSON.parse(readFileSync(join(project, '.codex', 'hooks.json'), 'utf8'));
    expect(Object.keys(codex.hooks).sort()).toEqual(['PostToolUse', 'PreCompact', 'PreToolUse', 'SessionStart']);
    expect(codex.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(commands(codex)).toEqual(['hook pre-bash --agent codex', 'hook post-read --agent codex', 'hook session-reset --agent codex', 'hook session-reset --agent codex']);
    // Codex reads code with CSyk, Claude Code with both: each note says how.
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toMatch(/Read code with CSyk `read`, not cat, sed or a file tool/);
    const cursor = JSON.parse(readFileSync(join(project, '.cursor', 'hooks.json'), 'utf8'));
    expect(cursor.version).toBe(1);
    expect(Object.keys(cursor.hooks).sort()).toEqual(['beforeShellExecution', 'preCompact', 'sessionStart']);
    expect(commands(cursor)).toEqual(['hook pre-bash --agent cursor', 'hook session-reset --agent cursor', 'hook session-reset --agent cursor']);
  }, 30_000);

  it("Antigravity for every project: its own group in agy's hooks, keeping the others", () => {
    const project = temp('project');
    const home = temp('home');
    execFileSync('mkdir', ['-p', join(home, '.gemini', 'config')]);
    writeFileSync(join(home, '.gemini', 'config', 'hooks.json'), '{"other":{"Stop":[{"type":"command","command":"x"}]}}');
    run(project, home, '--user', '--agent', 'antigravity');
    run(project, home, '--user', '--agent', 'antigravity');
    const hooks = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'));
    expect(Object.keys(hooks)).toEqual(['other', 'csyk']);
    expect(hooks.csyk.PreToolUse[0].matcher).toBe('run_command');
    expect(commands(hooks.csyk)).toEqual(['hook pre-bash --agent antigravity', 'hook post-read --agent antigravity', 'hook session-reset --agent antigravity']);
    expect(hooks.csyk.PostToolUse[0].matcher).toBe('read_file');
  }, 30_000);
});

describe('withTomlTable', () => {
  const table = '[mcp_servers.csyk]\ncommand = "csyk"\nargs = ["serve"]';
  it('replaces the table and its subtables, and leaves the next table alone', () => {
    const before = '[mcp_servers.csyk]\ncommand = "old"\n\n[mcp_servers.csyk.env]\nA = "1"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    expect(withTomlTable(before, table)).toBe(`${table}\n\n[projects."/x"]\ntrust_level = "trusted"\n`);
  });
  it('adds the table to an empty file', () => {
    expect(withTomlTable('', table)).toBe(`${table}\n`);
  });
});

describe('choose', () => {
  it('moves with the arrows, ticks with space and confirms with enter', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const picked = choose('Agents', [{ label: 'a', checked: true }, { label: 'b' }, { label: 'c' }], { multi: true, io: { input, output } });
    input.write('\x1b[B \x1b[A \r');
    expect(await picked).toEqual([1]);
  });
});
