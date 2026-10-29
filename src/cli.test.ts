import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

describe('csyk setup --write', () => {
  it('writes the server, hooks, CLAUDE.md note and skill, and a second run changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csyk-setup-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n\nOwn notes.\n');
    const setup = () => execFileSync(process.execPath, [cli, 'setup', '--write'], { cwd: dir });
    setup();
    const first = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md', '.claude/skills/csyk/SKILL.md'].map((f) =>
      readFileSync(join(dir, f), 'utf8'),
    );
    setup();
    const second = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md', '.claude/skills/csyk/SKILL.md'].map((f) =>
      readFileSync(join(dir, f), 'utf8'),
    );
    expect(second).toEqual(first);
    expect(first[2]).toMatch(/^# Project\n\nOwn notes\.\n\n<!-- csyk:start -->\n## Code search \(CSyk\)/);
    expect(JSON.parse(first[0] ?? '{}').mcpServers.csyk.args.at(-1)).toBe('serve');
    expect(existsSync(join(dir, '.claude/skills/csyk/SKILL.md'))).toBe(true);
  }, 30_000);
});
