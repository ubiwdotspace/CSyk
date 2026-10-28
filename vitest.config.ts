import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The evaluation corpora carry their own test files; they are data, not
    // tests of CSyk.
    exclude: ['**/node_modules/**', 'eval/fixtures/**', 'eval/corpora/**'],
  },
});
