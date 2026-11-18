import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../token/session.ts';
import { Workspace } from '../workspace/workspace.ts';
import { runTool } from './dispatch.ts';

// A monorepo as Astro, Svelte and Vue projects are laid out: a UI package used by its name.
const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', private: true, workspaces: ['packages/*', 'apps/*'] }),
  'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': './src/index.ts', './Card.astro': './src/Card.astro' } }),
  'packages/ui/src/index.ts': ["export { default as Card } from './Card.astro';", "export { default as Btn } from './Btn.vue';"].join('\n'),
  'packages/ui/src/format.ts': 'export function shout(s: string) {\n  return s.toUpperCase();\n}\n',
  'packages/ui/src/Card.astro': [
    '---',
    "import { shout } from './format';",
    'const { title } = Astro.props;',
    '---',
    '<h2>{shout(title)}</h2>',
    '<p>shout, as plain text</p>',
  ].join('\n'),
  'packages/ui/src/Btn.vue': [
    '<script setup lang="ts">',
    "import { shout } from './format';",
    "const label = shout('hi');",
    '</script>',
    '<template>',
    '  <button @click="shout(label)">{{ label }}</button>',
    '</template>',
  ].join('\n'),
  'apps/site/package.json': JSON.stringify({ name: 'site' }),
  'apps/site/src/pages/index.astro': ['---', "import { Card } from '@acme/ui';", '---', '<Card title="Shop" />', '<Card title="Again" />'].join('\n'),
  'apps/site/src/pages/about.astro': ['---', "import Card from '@acme/ui/Card.astro';", '---', '<Card title="About" />'].join('\n'),
  'apps/site/src/Elsewhere.astro': ['---', "import { Card } from 'some-ui-kit';", '---', '<Card />'].join('\n'),
  'apps/vue/package.json': JSON.stringify({ name: 'vue-app' }),
  'apps/vue/tsconfig.json': '{\n  // aliases of this app\n  "compilerOptions": { "paths": { "#ui/*": ["./src/ui/*"], }, },\n}',
  'apps/vue/src/ui/BaseButton.vue': ['<script setup lang="ts">', "import { exclaim } from '#ui/../lib/text';", '</script>', '<template><button>{{ exclaim("go") }}</button></template>'].join('\n'),
  'apps/vue/src/lib/text.ts': 'export function exclaim(s: string) {\n  return s + "!";\n}\n',
  'apps/vue/src/App.vue': [
    '<script setup lang="ts">',
    "import BaseButton from '#ui/BaseButton.vue';",
    '</script>',
    '<template>',
    '  <base-button />',
    '  <BaseButton></BaseButton>',
    '  <base-button-group />',
    '</template>',
  ].join('\n'),
  'apps/vue/src/components.d.ts': ["declare module 'vue' {", '  export interface GlobalComponents {', "    TheFooter: typeof import('./ui/TheFooter.vue')['default']", '  }', '}'].join('\n'),
  'apps/vue/src/auto-imports.d.ts': ['declare global {', "  const isDark: typeof import('./lib/dark').isDark", '}', 'export {}'].join('\n'),
  'apps/vue/src/lib/dark.ts': 'export const isDark = { value: false };\n',
  'apps/vue/src/ui/TheFooter.vue': '<template><footer>{{ isDark.value }}</footer></template>\n',
  'apps/vue/src/Layout.vue': '<template>\n  <TheFooter />\n  <the-footer />\n</template>\n',
  'apps/kit/package.json': JSON.stringify({ name: 'kit' }),
  'apps/kit/src/lib/greet.ts': 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n',
  'apps/kit/src/routes/+page.svelte': ['<script lang="ts">', "  import { greet } from '$lib/greet';", '</script>', '{#if true}<b>{greet("you")}</b>{/if}'].join('\n'),
};

let ws: Workspace;
const ask = (tool: Parameters<typeof runTool>[1], args: object) => runTool(ws, tool, args, new Session()).then((r) => r.text);

beforeAll(async () => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'csyk-cache-'));
  const root = mkdtempSync(join(tmpdir(), 'csyk-components-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  ws = await Workspace.open(root);
}, 60_000);

afterAll(() => ws.close());

describe('Astro, Svelte and Vue components', () => {
  it('finds a component by its file name, and what its frontmatter declares', async () => {
    expect(await ask('find', { query: 'Card' })).toContain('packages/ui/src/Card.astro#Card  component 1');
    expect(await ask('find', { query: 'Btn' })).toContain('packages/ui/src/Btn.vue#Btn  component 1');
    expect(await ask('outline', { path: 'packages/ui/src/Card.astro' })).toMatch(/1-6 component Card\n?$/);
  });

  it('counts a TS function used in component files, through their imports, and not in their plain text', async () => {
    const answer = await ask('refs', { target: 'shout' });
    expect(answer).toMatch(/^packages\/ui\/src\/format\.ts#shout · 5 refs in 2 files · lsp · complete/);
    expect(answer).toContain('packages/ui/src/Btn.vue  2·Btn, 3·label, 6·Btn');
    expect(answer).toContain('packages/ui/src/Card.astro  2·Card, 5·Card');
  });

  it('follows SvelteKit $lib imports', async () => {
    const answer = await ask('refs', { target: 'greet' });
    expect(answer).toMatch(/· 2 refs in 1 file · lsp · complete/);
    expect(answer).toContain('apps/kit/src/routes/+page.svelte  2·+page, 4·+page');
  });

  it("lists a component's uses: by its path, by its package's name and through a re-export", async () => {
    const answer = await ask('refs', { target: 'packages/ui/src/Card.astro#Card' });
    expect(answer).toMatch(/^packages\/ui\/src\/Card\.astro#Card · 6 refs in 3 files · imports\n/);
    expect(answer).toContain('apps/site/src/pages/index.astro  2·pages/index, 4·pages/index, 5·pages/index');
    expect(answer).toContain('apps/site/src/pages/about.astro  2·about, 4·about');
    expect(answer).toContain('packages/ui/src/index.ts  1');
    // Another package's Card may be a use or another component: not complete, and said so.
    expect(answer).toContain('unconfirmed, imported from where CSyk cannot follow: apps/site/src/Elsewhere.astro 2·Elsewhere, 4·Elsewhere');
    expect(answer).not.toContain('complete');
  });

  it("follows a tsconfig's paths, and Vue's kebab-case tags", async () => {
    const answer = await ask('refs', { target: 'apps/vue/src/ui/BaseButton.vue' });
    expect(answer).toMatch(/^apps\/vue\/src\/ui\/BaseButton\.vue#BaseButton · 4 refs in 1 file · imports · complete/);
    expect(answer).toContain('apps/vue/src/App.vue  2·App, 5·App, 6·App');
    expect(await ask('refs', { target: 'exclaim' })).toContain('apps/vue/src/ui/BaseButton.vue  2·BaseButton, 4·BaseButton');
  });

  it('follows global components and auto-imported functions a .d.ts declares', async () => {
    expect(await ask('refs', { target: 'apps/vue/src/ui/TheFooter.vue' })).toMatch(/· 2 refs in 1 file · imports · complete\napps\/vue\/src\/Layout\.vue  2·Layout, 3·Layout/);
    expect(await ask('refs', { target: 'isDark' })).toMatch(/· 1 ref in 1 file · lsp · complete\napps\/vue\/src\/ui\/TheFooter\.vue  1·TheFooter/);
  });

  it('searches code written as it reads as written, when no regex matches it', async () => {
    expect(await ask('grep', { pattern: 'shout(title)' })).toMatch(/^1 hit in 1 place · text, as written: no regex match/);
  });
});
