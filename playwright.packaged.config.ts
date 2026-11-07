import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/packaged',
  testDir: './e2e', testMatch: '**/*.packaged.ts', workers: 1, timeout: 90_000,
  use: { trace: 'retain-on-failure' },
});
