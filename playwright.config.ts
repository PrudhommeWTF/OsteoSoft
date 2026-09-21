import { defineConfig, devices } from '@playwright/test';

// Configuration des tests end-to-end (navigateur reel).
//
// Le serveur de test (e2e/serve-for-e2e.mjs) lance une instance reelle de
// l'API Express qui sert aussi le frontend Angular compile, contre une base
// SQLite temporaire et isolee. Le frontend compile appelle l'API sur le port
// 4199 : on sert donc l'ensemble sur ce port unique (meme origine, pas de
// probleme CORS). Il faut avoir compile le frontend au prealable
// (`npm run build`) ; le script npm `test:e2e` s'en charge.
//
// Les scenarios partagent une seule instance et s'executent en serie (workers
// = 1) : l'installation initiale amorce le cabinet, puis les scenarios suivants
// reutilisent cette instance, comme un vrai cabinet dans le temps.

const PORT = Number(process.env.E2E_API_PORT ?? 4199);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'fr-FR'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: undefined }
    }
  ],
  webServer: {
    command: 'node e2e/serve-for-e2e.mjs',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
