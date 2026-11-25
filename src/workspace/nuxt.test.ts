import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNuxtAutoImport, nuxtComponents } from './nuxt.ts';

const app = (files: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'csyk-nuxt-'));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  return root;
};

describe('nuxtComponents', () => {
  it("names components after their path, as Nuxt does, in Nuxt 4's app/ and Nuxt 3's root", () => {
    const root = app([
      'nuxt.config.ts',
      'app/components/home/HomeChart.vue',
      'app/components/customers/AddModal.vue',
      'app/components/base/button/index.vue',
      'app/components/Map.client.vue',
      'web/nuxt.config.ts',
      'web/components/the-header.vue',
      'docs/components/Stray.vue',
    ]);
    const names = Object.fromEntries(nuxtComponents(root).map((c) => [c.file, c.names]));
    expect(names).toEqual({
      'app/components/home/HomeChart.vue': ['HomeChart', 'LazyHomeChart'],
      'app/components/customers/AddModal.vue': ['CustomersAddModal', 'LazyCustomersAddModal'],
      'app/components/base/button/index.vue': ['BaseButton', 'LazyBaseButton'],
      'app/components/Map.client.vue': ['Map', 'LazyMap'],
      'web/components/the-header.vue': ['TheHeader', 'LazyTheHeader'],
    });
  });

  it('auto-imports what composables/ and utils/ export, at their top or in a folder index', () => {
    const root = app(['nuxt.config.ts', 'app/composables/useCart.ts', 'app/utils/format/index.ts', 'app/utils/format/money.ts', 'server/api/cart.ts']);
    expect(['app/composables/useCart.ts', 'app/utils/format/index.ts', 'app/utils/format/money.ts', 'server/api/cart.ts'].map((f) => isNuxtAutoImport(root, f))).toEqual([true, true, false, false]);
  });
});
