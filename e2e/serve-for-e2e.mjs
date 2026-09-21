// Lanceur du serveur pour les tests end-to-end Playwright.
//
// Demarre une instance reelle de server/index.mjs (API + frontend Angular
// compile servi par la meme instance) contre une base SQLite TEMPORAIRE et
// isolee, sans jamais toucher aux donnees de developpement. Le serveur resout
// son dossier de donnees depuis process.cwd() : on le lance donc avec un cwd
// jetable, supprime a l'arret. Aucune modification du code applicatif n'est
// necessaire (meme approche que le harnais des tests d'API).
//
// Le frontend compile (environment.ts) appelle http://localhost:4199/api : le
// serveur ecoute donc sur ce port fixe pour que l'interface atteigne l'API.
// Playwright attend que ce port reponde avant de lancer les scenarios, puis
// envoie SIGTERM a ce processus a la fin : on nettoie alors l'enfant et le
// dossier temporaire.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.mjs');
const STATIC_DIR = join(REPO_ROOT, 'dist', 'OsteoSoft', 'browser');
const PORT = Number(process.env.E2E_API_PORT ?? 4199);

if (!existsSync(join(STATIC_DIR, 'index.html'))) {
  console.error(
    `[e2e] Frontend compile introuvable dans ${STATIC_DIR}.\n`
    + '[e2e] Lancez "npm run build" (ou "npm run e2e") avant les tests end-to-end.'
  );
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'osteosoft-pw-'));

const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: dataDir,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    OSTEOSOFT_DATA_KEY: randomBytes(32).toString('base64'),
    JWT_SECRET: randomBytes(48).toString('base64'),
    API_PORT: String(PORT),
    OSTEOSOFT_STATIC_DIR: STATIC_DIR,
    ALLOW_REMOTE_SETUP: 'false'
  },
  stdio: ['ignore', 'inherit', 'inherit']
});

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { child.kill('SIGTERM'); } catch { /* deja arrete */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}
process.on('exit', cleanup);

child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
