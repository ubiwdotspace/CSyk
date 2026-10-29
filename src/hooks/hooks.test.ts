import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceExtensions } from '../index/parse.ts';
import { hookedExtensions, preGrep, preRead, shellSearches, simpleCommands } from './hooks.ts';

const root = mkdtempSync(join(tmpdir(), 'csyk-hooks-'));
writeFileSync(join(root, 'big.ts'), 'const x = 1;\n'.repeat(500));
writeFileSync(join(root, 'small.ts'), 'const x = 1;\n');

describe('hookedExtensions', () => {
  it('are the extensions the index reads', () => {
    expect([...hookedExtensions].sort()).toEqual([...sourceExtensions].sort());
  });
});

describe('simpleCommands', () => {
  it('splits pipelines and lists, undoes quotes and drops redirections', () => {
    expect(simpleCommands(`cd src && rg -n "Token Store" . 2>/dev/null | head -5; echo 'a|b'`)).toEqual([
      ['cd', 'src'],
      ['rg', '-n', 'Token Store', '.'],
      ['head', '-5'],
      ['echo', 'a|b'],
    ]);
  });

  it('gives up on substitutions, subshells and heredocs', () => {
    expect(simpleCommands('rg $(cat names) .')).toBeUndefined();
    expect(simpleCommands('(cd a && rg x)')).toBeUndefined();
    expect(simpleCommands('cat <<EOF\nx\nEOF')).toBeUndefined();
  });
});

describe('shellSearches', () => {
  it('finds the pattern and folders of rg and recursive grep, after a cd', () => {
    expect(shellSearches('cd src && rg -t ts -w TokenStore lib', '/repo')).toEqual([
      { pattern: 'TokenStore', targets: ['/repo/src/lib'] },
    ]);
    expect(shellSearches('grep -rn -e saveToken .', '/repo')).toEqual([{ pattern: 'saveToken', targets: ['/repo'] }]);
    expect(shellSearches('grep saveToken file.ts', '/repo')).toEqual([]);
  });
});

describe('preRead', () => {
  it('turns down a whole read of a long source file in a served workspace only', () => {
    const read = (args: Record<string, unknown>, roots = [root]) => preRead({ tool_name: 'Read', tool_input: args, cwd: root }, roots);
    expect(read({ file_path: join(root, 'big.ts') })?.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^Reading a range with offset\+limit is allowed and needs no search\. big\.ts has 501 lines/,
    );
    expect(read({ file_path: join(root, 'big.ts'), offset: 1, limit: 50 })).toBeUndefined();
    expect(read({ file_path: join(root, 'small.ts') })).toBeUndefined();
    expect(read({ file_path: join(root, 'big.ts') }, [])).toBeUndefined();
  });
});

describe('preGrep', () => {
  const grep = (input: Record<string, unknown>, roots = [root]) => preGrep({ cwd: root, ...input }, roots);

  it('points a search for a bare name at find and refs', () => {
    expect(grep({ tool_name: 'Grep', tool_input: { pattern: 'TokenStore' } })?.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^"TokenStore" is a name: CSyk find TokenStore/,
    );
    expect(grep({ tool_name: 'Bash', tool_input: { command: 'rg TokenStore src' } })).toBeDefined();
  });

  it('lets phrases, regexes, other folders and unserved workspaces through', () => {
    expect(grep({ tool_name: 'Grep', tool_input: { pattern: 'token store' } })).toBeUndefined();
    expect(grep({ tool_name: 'Grep', tool_input: { pattern: 'Token\\w+' } })).toBeUndefined();
    expect(grep({ tool_name: 'Bash', tool_input: { command: 'rg TokenStore /elsewhere' } })).toBeUndefined();
    expect(grep({ tool_name: 'Grep', tool_input: { pattern: 'TokenStore' } }, [])).toBeUndefined();
  });
});
