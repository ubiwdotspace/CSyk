import { installHints } from '../precision/lsp-service.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { ToolResult } from './tools.ts';

/** `status`: the index and each language's server, with how to install a missing one. */
export function status(ws: Workspace): ToolResult {
  const { index } = ws;
  const fromSnapshot = index.reused > 0 ? ` · ${index.reused} from the saved index` : '';
  const watching = ws.watching ? `watching · ${ws.pendingChanges} pending` : 'not watching';
  const rows = ws.servers().map(({ lang, server, state }) => {
    const hint = state === 'not installed' && installHints[server] ? ` (${installHints[server]})` : '';
    return `${lang}  ${server} ${state}${hint}`;
  });
  return { text: [`index · ${index.files.length} files · ${index.size} symbols${fromSnapshot} · ${watching}`, ...rows].join('\n'), locations: [] };
}
