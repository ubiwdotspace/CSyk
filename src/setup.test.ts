import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTomlTable } from './setup.ts';
import { choose } from './tui.ts';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
const temp = (name: string) => mkdtempSync(join(tmpdir(), `csyk-${name}-`));

describe('csyk setup --agent', () => {
  it('writes Codex and Antigravity configuration, keeping what was there, and a second run changes nothing', () => {
    const project = temp('project');
    const home = temp('home');
    writeFileSync(join(project, 'AGENTS.md'), '# Agents\n');
    execFileSync('mkdir', ['-p', join(home, '.codex'), join(home, '.gemini', 'antigravity')]);
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n');
    writeFileSync(join(home, '.gemini', 'antigravity', 'mcp_config.json'), '{"mcpServers":{"other":{"command":"other"}}}');
    const files = ['.codex/config.toml', '.gemini/antigravity/mcp_config.json'].map((f) => join(home, f));
    files.push(...['AGENTS.md', '.codex/skills/csyk/SKILL.md', '.agents/rules/csyk.md', '.agents/skills/csyk/SKILL.md'].map((f) => join(project, f)));
    const setup = () =>
      execFileSync(process.execPath, [cli, 'setup', '--write', '--agent', 'codex,antigravity'], {
        cwd: project,
        env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), PATH: '/usr/bin:/bin' },
      });
    setup();
    const first = files.map((f) => readFileSync(f, 'utf8'));
    setup();
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(first);

    const [toml = '', antigravity = '{}', agents = '', , rule = ''] = first;
    expect(toml).toMatch(/^model = "o4"\n\n\[mcp_servers\.other\]\ncommand = "other"\n\n\[mcp_servers\.csyk\]\ncommand = "node"\nargs = \[".+", "serve"\]\n$/);
    const servers = JSON.parse(antigravity).mcpServers;
    expect(Object.keys(servers)).toEqual(['other', 'csyk']);
    expect(servers.csyk.args.slice(-2)).toEqual(['serve', '${workspace.path}']);
    expect(agents).toMatch(/^# Agents\n\n<!-- csyk:start -->\n## Code search \(CSyk\)/);
    expect(rule).toMatch(/^---\ntrigger: always_on\n/);
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
