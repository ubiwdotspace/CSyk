import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** A started MCP server: call a tool for its text answer, then close it. */
export type McpServer = {
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

const bins = new Map<string, string>();

/**
 * The bin folder of the Python tool uvx installs [from], so commands start
 * as fast as an installed tool's (`uv tool install`) rather than through uvx.
 */
export function uvToolBin(from: string): string {
  let bin = bins.get(from);
  if (!bin) {
    const script = 'import os, sys; print(os.path.dirname(sys.executable))';
    bin = execFileSync('uvx', ['-q', '--from', from, 'python', '-c', script], { encoding: 'utf8' }).trim();
    bins.set(from, bin);
  }
  return bin;
}

/**
 * The bin folder of the npm [packages], exact versions, installed once into a
 * folder of their own: a run never depends on what is installed globally.
 */
export function npmToolBin(...packages: string[]): string {
  const dir = join(tmpdir(), 'csyk-agent', 'npm', packages.join('+').replace(/[^\w.@+-]/g, '_'));
  const bin = join(dir, 'node_modules/.bin');
  if (!existsSync(bin)) execFileSync('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--silent', ...packages], { stdio: 'ignore' });
  return bin;
}

/** Starts [command] over stdio in [cwd]. A first call may start language servers, so calls wait five minutes. */
export async function startMcp(command: string, args: string[], cwd: string): Promise<McpServer> {
  const client = new Client({ name: 'csyk-eval', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command, args, cwd, stderr: 'ignore' }));
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
      return (result.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('\n');
    },
    close: () => client.close(),
  };
}
