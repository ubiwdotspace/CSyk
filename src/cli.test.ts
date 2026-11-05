import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

describe('csyk setup --write', () => {
  it('writes the server, the Grep deny rule and CLAUDE.md note, and a second run changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-setup-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n\nOwn notes.\n');
    const setup = () => execFileSync(process.execPath, [cli, 'setup', '--write'], { cwd: dir });
    setup();
    const first = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md'].map((f) =>
      readFileSync(join(dir, f), 'utf8'),
    );
    setup();
    const second = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md'].map((f) =>
      readFileSync(join(dir, f), 'utf8'),
    );
    expect(second).toEqual(first);
    expect(first[2]).toMatch(/^# Project\n\nOwn notes\.\n\n<!-- csyk:start -->\n## Code search \(CSyk\)/);
    expect(JSON.parse(first[0] ?? '{}').mcpServers.csyk.args.at(-1)).toBe('serve');
    const settings = JSON.parse(first[1] ?? '{}');
    expect(settings.permissions.deny).toEqual(['Grep']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PreCompact', 'PreToolUse', 'SessionStart']);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Read');
    // Shell searches go through CSyk grep; reads are not turned down without --hooks.
    expect(settings.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher)).toEqual(['Bash']);
    expect(existsSync(join(dir, '.claude/skills/csyk'))).toBe(false);
  }, 30_000);

  it('removes the csyk skill an earlier setup wrote, and leaves a skill of that name it did not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-setup-'));
    const skill = join(dir, '.claude/skills/csyk/SKILL.md');
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, '---\nname: csyk\ndescription: Reference for the CSyk code tools.\n---\n\n# CSyk reference\n');
    const setup = () => execFileSync(process.execPath, [cli, 'setup', '--write'], { cwd: dir });
    setup();
    expect(existsSync(join(dir, '.claude/skills/csyk'))).toBe(false);
    expect(existsSync(join(dir, '.claude/skills'))).toBe(true);
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, '---\nname: my-own\n---\n');
    setup();
    expect(readFileSync(skill, 'utf8')).toBe('---\nname: my-own\n---\n');
  }, 30_000);
});
