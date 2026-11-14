import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      'ARTEX-0.3.15',
      'Cairn-main',
      'CkSKILLS_v2',
      'deepseek-harness-master',
      'dsh-superagent-prototype-main',
      'pi-main',
      'agent-skills',
    ],
  },
});
