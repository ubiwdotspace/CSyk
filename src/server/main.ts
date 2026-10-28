import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { markServing } from '../hooks/hooks.ts';
import { createServer } from './server.ts';

/** Serves [root] over stdio until the client goes away; hooks see it while it runs. */
export async function serve(root: string): Promise<void> {
  const { server, close } = createServer(root);
  const unmark = markServing(root);
  const shutdown = () => {
    unmark();
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  await server.connect(new StdioServerTransport());
}

// `node src/server/main.ts [workspace]` serves too, as `csyk serve` does.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await serve(resolve(process.argv[2] ?? process.cwd()));
}
