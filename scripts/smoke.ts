// Asks a built CSyk, over MCP stdio, what needs each part a package ships:
// ripgrep (grep), the tree-sitter parsers (find) and the TypeScript compiler
// (a call through a renamed import). Exits 1 on a wrong answer.
//
//   node scripts/smoke.ts <command> [args...]    e.g. packages/csyk-linux-x64/bin/csyk
import { join } from 'node:path';
import { startMcp } from '../eval/adapters/mcp.ts';

const [command = 'csyk', ...args] = process.argv.slice(2);
const fixture = join(import.meta.dirname, '../eval/fixtures/mini-ts');
const server = await startMcp(command, [...args, 'serve', fixture], process.cwd());
const checks: [string, Record<string, unknown>, RegExp][] = [
  ['grep', { pattern: 'calculateTax' }, /checkout\.ts/],
  ['find', { query: 'calculateTotal' }, /total\.ts/],
  ['refs', { target: 'calculateTotal' }, / · lsp · [\s\S]*receipt\.ts +1, 6·/],
];
let failed = false;
for (const [tool, input, expected] of checks) {
  const answer = await server.call(tool, input);
  const ok = expected.test(answer);
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${tool} ${JSON.stringify(input)}${ok ? '' : `\n${answer}`}`);
}
await server.close();
process.exit(failed ? 1 : 0);
