import { installHints } from '../precision/lsp-service.ts';
import { memoryBudget, treeMb } from '../precision/memory.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { ToolResult } from './tools.ts';

/**
 * `status`: the index, each language's server with how to install a missing
 * one, and the memory CSyk and its servers may hold (CSYK_MEMORY).
 */
export function status(ws: Workspace): ToolResult {
  const { index } = ws;
  const fromSnapshot = index.reused > 0 ? ` · ${index.reused} from the saved index` : '';
  const watching = ws.watching ? `watching · ${ws.pendingChanges} pending` : 'not watching';
  const rows = ws.servers().map(({ lang, server, state }) => {
    const hint = state === 'not installed' && installHints[server] ? ` (${installHints[server]})` : '';
    return `${lang}  ${server} ${state}${hint}`;
  });
  const memory = memoryBudget();
  const budget = `memory · ${memory.mode} · ${memory.mb} MB for CSyk and its servers (${memory.why}) · ${treeMb(process.pid)} MB in use`;
  return { text: [`index · ${index.files.length} files · ${index.size} symbols${fromSnapshot} · ${watching}`, ...rows, budget].join('\n'), locations: [] };
}
