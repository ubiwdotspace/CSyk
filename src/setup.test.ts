import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTomlTable } from './setup.ts';
import { choose } from './tui.ts';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
const temp = (name: string) => mkdtempSync(join(tmpdir(), `csyk-${name}-`));

const run = (cwd: string, home: string, ...args: string[]) =>
  execFileSync(process.execPath, [cli, 'setup', '--write', ...args], {
    cwd,
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), PATH: '/usr/bin:/bin' },
  });

describe('csyk setup --agent', () => {
  it('sets up Codex and Antigravity inside the project only, and a second run changes nothing', () => {
    const project = temp('project');
    const home = temp('home');
    writeFileSync(join(project, 'AGENTS.md'), '# Agents\n');
    const files = [
      '.codex/config.toml',
      'AGENTS.md',
      '.agents/skills/csyk/SKILL.md',
      '.agents/plugins/csyk/plugin.json',
      '.agents/plugins/csyk/mcp_config.json',
      '.agents/plugins/csyk/rules/AGENTS.md',
      '.agents/plugins/csyk/skills/csyk/SKILL.md',
    ].map((f) => join(project, f));
    run(project, home, '--agent', 'codex,antigravity');
    const first = files.map((f) => readFileSync(f, 'utf8'));
    run(project, home, '--agent', 'codex,antigravity');
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(first);
    expect(readdirSync(home)).toEqual([]);

    const [toml = '', agents = '', , , server = '{}'] = first;
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
