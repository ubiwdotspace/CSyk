import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { resetMarker } from '../token/session.ts';
import { markServing } from './hooks.ts';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'csyk-formats-')));
const unmark = markServing(root);
afterAll(() => {
  unmark();
});

const hook = (name: string, agent: string, event: unknown) =>
  execFileSync(process.execPath, [cli, 'hook', name, '--agent', agent], { input: JSON.stringify(event), encoding: 'utf8' });

// The same shell search, as each agent sends it: every one is turned down with the same CSyk grep.
describe('pre-bash in each agent format', () => {
  const command = 'rg -n "useStore" src';
  const reason = /^Search the code with CSyk grep \(pattern: "useStore", path: "src"\)/;

  it('Codex: as Claude Code', () => {
    const answer = JSON.parse(hook('pre-bash', 'codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root }));
    expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(reason);
  });

  it('Cursor: beforeShellExecution, the reason as agent_message', () => {
    const answer = JSON.parse(hook('pre-bash', 'cursor', { hook_event_name: 'beforeShellExecution', command, cwd: root, conversation_id: 'c1' }));
    expect(answer.permission).toBe('deny');
    expect(answer.agent_message).toMatch(reason);
    // A command that is not a search of the code: nothing printed, Cursor's own rules decide.
    expect(hook('pre-bash', 'cursor', { command: 'npm test | grep FAIL', cwd: root })).toBe('');
  });

  it('Antigravity: run_command in toolCall, the project in workspacePaths, nothing printed to let a call through', () => {
    // A hook runs in the folder of its hooks.json, not the project's.
    const event = (CommandLine: string) => ({ conversationId: 'c1', workspacePaths: [root], toolCall: { name: 'run_command', args: { CommandLine } } });
    const answer = JSON.parse(hook('pre-bash', 'antigravity', event(command)));
    expect(answer).toMatchObject({ decision: 'deny' });
    expect(answer.reason).toMatch(reason);
    expect(hook('pre-bash', 'antigravity', event('git log -3'))).toBe('');
    // An answer without a decision would deny the call, so input it cannot read prints nothing.
    expect(execFileSync(process.execPath, [cli, 'hook', 'pre-bash', '--agent', 'antigravity'], { input: 'not json', encoding: 'utf8' })).toBe('');
  });
});

describe('session-reset', () => {
  it('Cursor names the workspace, not a cwd', () => {
    const marker = resetMarker(root);
    rmSync(marker, { force: true });
    hook('session-reset', 'cursor', { hook_event_name: 'sessionStart', workspace_roots: [root], conversation_id: 'x' });
    expect(existsSync(marker)).toBe(true);
  });
});

describe('post-read: what the agent reads itself counts as shown', () => {
  it('Claude Code Read and Codex sed -n are logged with their lines; a pipe into grep is not', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { seenLog } = await import('../token/session.ts');
    mkdirSync(join(root, 'src'), { recursive: true });
    const file = join(root, 'src', 'a.ts');
    writeFileSync(file, Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n'));
    rmSync(seenLog(root), { force: true });
    hook('post-read', 'claude', { tool_name: 'Read', tool_input: { file_path: file, offset: 5, limit: 10 }, cwd: root });
    hook('post-read', 'codex', { tool_name: 'Bash', tool_input: { command: "sed -n '20,30p' src/a.ts" }, cwd: root });
    hook('post-read', 'codex', { tool_name: 'Bash', tool_input: { command: 'cat src/a.ts | grep v1' }, cwd: root });
    const view = (args: Record<string, unknown>) => ({ workspacePaths: [root], toolCall: { name: 'read_file', args: { Path: file, ...args } } });
    hook('post-read', 'antigravity', view({ StartLine: 40, EndLine: 45 }));
    // A read_file without its lines may show less than the file: not counted.
    hook('post-read', 'antigravity', view({}));
    const reads = readFileSync(seenLog(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(reads.map(({ file: f, from, to }) => [f, from, to])).toEqual([
      [file, 5, 14],
      [file, 20, 30],
      [file, 40, 45],
    ]);
    // A new session forgets them.
    hook('session-reset', 'claude', { hook_event_name: 'SessionStart', cwd: root });
    expect(existsSync(seenLog(root))).toBe(false);
  });
});
