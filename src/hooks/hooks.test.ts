import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeExtensions } from '../index/parse.ts';
import { dependencyDirs } from '../workspace/workspace.ts';
import { fileSearches, hookedDependencyDirs, hookedExtensions, preBash, preGrep, preRead, shellSearches, simpleCommands } from './hooks.ts';

// Symlinks followed, as servers write their roots (macOS's tmpdir is under /var, a link).
const root = realpathSync(mkdtempSync(join(tmpdir(), 'csyk-hooks-')));
writeFileSync(join(root, 'big.ts'), 'const x = 1;\n'.repeat(500));
writeFileSync(join(root, 'small.ts'), 'const x = 1;\n');

describe('hookedExtensions', () => {
  it('are the extensions of the code the index parses', () => {
    expect([...hookedExtensions].sort()).toEqual([...codeExtensions].sort());
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

describe('hookedDependencyDirs', () => {
  it('are the folders the workspace leaves out', () => {
    expect([...hookedDependencyDirs].sort()).toEqual([...dependencyDirs].sort());
  });
});

describe('fileSearches', () => {
  it('reads rg, git grep and grep over files as ripgrep patterns', () => {
    expect(fileSearches('rg -n "Token Store" src', '/repo')).toEqual([{ pattern: 'Token Store', literal: false, targets: ['/repo/src'] }]);
    expect(fileSearches('git grep -n saveToken', '/repo')).toEqual([{ pattern: 'saveToken', literal: false, targets: ['/repo'] }]);
    expect(fileSearches('grep -n "a\\|b(c)" lib/x.ts', '/repo')).toEqual([{ pattern: 'a|b\\(c\\)', literal: false, targets: ['/repo/lib/x.ts'] }]);
    expect(fileSearches('grep -rE "a|b" --include=*.ts .', '/repo')).toEqual([{ pattern: 'a|b', literal: false, glob: '*.ts', targets: ['/repo'] }]);
    expect(fileSearches('grep -rF "f(x)" .', '/repo')).toEqual([{ pattern: 'f(x)', literal: true, targets: ['/repo'] }]);
    expect(fileSearches('grep -rwi "f.x" .', '/repo')).toEqual([{ pattern: '(?i)\\b(?:f.x)\\b', literal: false, targets: ['/repo'] }]);
  });

  it('leaves out a grep of piped output', () => {
    expect(fileSearches('npm test 2>&1 | grep FAIL', '/repo')).toEqual([]);
    expect(fileSearches('git log --oneline | grep -i fix', '/repo')).toEqual([]);
  });
});

describe('preBash', () => {
  const bash = (command: string, roots = [root]) => preBash({ tool_name: 'Bash', tool_input: { command }, cwd: root }, roots)?.hookSpecificOutput.permissionDecisionReason;

  it('turns a shell search of a served workspace into CSyk grep', () => {
    expect(bash('grep -rn "Could not save" src')).toBe(
      'Search the code with CSyk grep (pattern: "Could not save", path: "src"): the same matches, each with the function it is in, in fewer tokens. A grep of a command\'s output still runs.',
    );
    expect(bash('rg -F "a.b" --glob "*.ts"')).toMatch(/^Search the code with CSyk grep \(pattern: "a\.b", literal: true, glob: "\*\.ts"\)/);
  });

  it('lets piped greps, dependencies, other folders and unserved workspaces through', () => {
    expect(bash('npm test | grep FAIL')).toBeUndefined();
    expect(bash('grep -rn useState node_modules/react')).toBeUndefined();
    expect(bash('rg TokenStore /elsewhere')).toBeUndefined();
    expect(bash('rg TokenStore', [])).toBeUndefined();
    expect(bash('ls -la && npm run build')).toBeUndefined();
  });
});
