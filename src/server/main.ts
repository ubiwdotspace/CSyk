import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';

// `csyk [workspace]`: serves the workspace (the current folder by default) over stdio.
const { server, close } = createServer(resolve(process.argv[2] ?? process.cwd()));
const shutdown = () => void close().finally(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
await server.connect(new StdioServerTransport());
