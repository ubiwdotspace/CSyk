import { describe, expect, it } from 'vitest';
import { componentOf, maskComponent } from './embedded.ts';
import { extractSymbols } from './parse.ts';

// The masked text's code, line by line, blank lines left out and spaces run together: what the
// parser reads (columns are checked on their own).
const kept = (file: string, text: string) =>
  maskComponent(file, text)
    .split('\n')
    .map((line, n) => [n + 1, line.trim().replace(/ +/g, ' ')] as const)
    .filter(([, line]) => line !== '');

describe('maskComponent', () => {
  it('keeps an Astro frontmatter, template expressions and component tags, at their lines and columns', () => {
    const text = [
      '---',
      "import { shout } from './format';",
      "const title = 'Hi';",
      '---',
      '<!-- shout in a comment -->',
      '<h2 class="shout">{shout(title)}</h2>',
      '<Card title={title} />',
      '<p>shout, as plain text</p>',
      '<style>.shout { color: red }</style>',
      '<script>document.title = shout(document.title);</script>',
    ].join('\n');
    const masked = maskComponent('a.astro', text);
    expect(masked.length).toBe(text.length);
    expect(masked.split('\n').map((l) => l.length)).toEqual(text.split('\n').map((l) => l.length));
    expect(kept('a.astro', text)).toEqual([
      [2, "import { shout } from './format';"],
      [3, "const title = 'Hi';"],
      [4, ';'],
      [6, ';shout(title);'],
      [7, ';Card; ;title;'],
      [10, ';document.title = shout(document.title);;'],
    ]);
    // `shout(title)` sits where it is written.
    expect(masked.split('\n')[5]?.indexOf('shout')).toBe((text.split('\n')[5] ?? '').indexOf('{shout') + 1);
  });

  it("keeps Svelte scripts and expressions, without a block's keyword", () => {
    const text = [
      '<script lang="ts">',
      "  import { greet } from '$lib/greet';",
      '</script>',
      '{#if ok}<b>{greet()}</b>{:else if other}x{/if}',
      '<button on:click={() => greet()}>go</button>',
    ].join('\n');
    expect(kept('a.svelte', text)).toEqual([
      [1, ';'],
      [2, "import { greet } from '$lib/greet';"],
      [3, ';'],
      [4, '; ok; ;greet(); ; other; ; ;'],
      [5, ';() => greet();'],
    ]);
  });

  it('keeps Vue scripts, {{ }} and bound attributes, not plain ones', () => {
    const text = [
      '<script setup lang="ts">',
      "import { shout } from './format';",
      '</script>',
      '<template>',
      '  <button class="shout" @click="shout(\'x\')" :title="shout(label)">{{ shout(label) }}</button>',
      '  <MyCard v-if="ok" />',
      '</template>',
      '<script type="application/ld+json">{ "shout": 1 }</script>',
    ].join('\n');
    expect(kept('a.vue', text)).toEqual([
      [1, ';'],
      [2, "import { shout } from './format';"],
      [3, ';'],
      [5, ";shout('x'); ;shout(label); ; shout(label) ;"],
      [6, ';MyCard; ;ok;'],
    ]);
  });
});

describe('componentOf', () => {
  it('names a component after its file, as it is imported, and a page as a route', () => {
    expect(componentOf('src/components/Badge.astro')).toEqual({ name: 'Badge', kind: 'component' });
    expect(componentOf('src/components/my-button.vue')).toEqual({ name: 'MyButton', kind: 'component' });
    expect(componentOf('src/routes/+page.svelte')).toEqual({ name: '+page', kind: 'route' });
    expect(componentOf('src/pages/blog/[slug].astro')).toEqual({ name: '[slug]', kind: 'route' });
    expect(componentOf('src/pages/index.astro')).toEqual({ name: 'pages/index', kind: 'route' });
  });
});

describe('extractSymbols of a component file', () => {
  it('gives the component, with what its frontmatter declares as its own', async () => {
    const text = ['---', 'interface Props { title: string }', 'const { title } = Astro.props;', 'function loud(s: string) { return s + "!"; }', '---', '<h1>{loud(title)}</h1>'].join('\n');
    const symbols = await extractSymbols('src/Card.astro', text);
    expect(symbols.map((s) => [s.id, s.kind, s.range, s.parent ?? null])).toEqual([
      ['src/Card.astro#Card', 'component', [1, 6], null],
      ['src/Card.astro#Props', 'interface', [2, 2], null],
      ['src/Card.astro#Props.title', 'field', [2, 2], 'src/Card.astro#Props'],
      ['src/Card.astro#title', 'const', [3, 3], 'src/Card.astro#Card'],
      ['src/Card.astro#loud', 'function', [4, 4], 'src/Card.astro#Card'],
    ]);
    expect(symbols[0]?.signature).toBe('interface Props { title: string }');
  });
});
