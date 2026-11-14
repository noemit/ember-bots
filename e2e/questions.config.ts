import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'asyncQuestions*.pw.ts', workers: 1, timeout: 90_000,
  outputDir: '/tmp/ember-questions-playwright',
  use: { baseURL: 'http://127.0.0.1:5297', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'bun run dev:web --host 127.0.0.1 --port 5297 --strictPort', cwd: '..', url: 'http://127.0.0.1:5297', reuseExistingServer: false },
});
