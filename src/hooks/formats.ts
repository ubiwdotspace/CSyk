import type { HookInput } from './hooks.ts';

/**
 * How an agent sends a hook its event and reads the answer. The hooks themselves
 * (hooks.ts) see one input and give one reason; each agent differs only here.
 */
export type HookFormat = {
  /** The event as hooks.ts reads it. */
  read: (raw: Record<string, unknown>) => HookInput;
  /** The answer that turns the call down and tells the agent why. */
  deny: (reason: string) => unknown;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (...values: unknown[]) => values.find((v): v is string => typeof v === 'string');

// Claude Code's format, which Codex follows too (its shell is `Bash`, its command in tool_input.command).
const claude: HookFormat = {
  read: (raw) => raw as HookInput,
  deny: (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
};

export const formats: Record<string, HookFormat> = {
  claude,
  codex: claude,
  // beforeShellExecution sends the command itself; sessionStart and preCompact name the
  // workspace's folders, not a cwd. Printing nothing leaves the call to Cursor's own rules.
  cursor: {
    read: (raw) => {
      const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
      return {
        hook_event_name: text(raw.hook_event_name),
        tool_name: 'Bash',
        tool_input: { command: text(raw.command) ?? '' },
        cwd: text(raw.cwd, roots[0]),
      };
    },
    deny: (reason) => ({ permission: 'deny', user_message: 'Searched with CSyk grep instead.', agent_message: reason }),
  },
  // agy (as its own hooks guide says): the tool and its arguments in toolCall, the conversation in
  // conversationId, the project in workspacePaths, as a hook runs in the folder of its hooks.json.
  // Printing nothing lets a call through; an answer must name a decision, or the call is denied.
  // Its read_file counts as a read only with both StartLine and EndLine, the lines it then shows.
  antigravity: {
    read: (raw) => {
      const call = record(raw.toolCall);
      const args = record(call.args);
      const workspaces = Array.isArray(raw.workspacePaths) ? raw.workspacePaths : [];
      const cwd = text(args.Cwd, workspaces[0], raw.cwd);
      if (call.name === 'read_file') {
        const from = Number(args.StartLine);
        const to = Number(args.EndLine);
        const ranged = Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from;
        return { tool_name: ranged ? 'Read' : 'read_file', tool_input: ranged ? { file_path: text(args.Path), offset: from, limit: to - from + 1 } : {}, cwd };
      }
      return {
        tool_name: call.name === 'run_command' ? 'Bash' : text(call.name),
        tool_input: { command: text(args.CommandLine) ?? '' },
        cwd,
      };
    },
    deny: (reason) => ({ decision: 'deny', reason }),
  },
};

/** The format of [agent], Claude Code's for one this does not know. */
export const formatFor = (agent: string): HookFormat => formats[agent] ?? claude;
