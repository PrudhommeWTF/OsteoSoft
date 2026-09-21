// Harnais de tests d'API de bout en bout.
//
// Démarre une instance réelle du serveur (server/index.mjs) contre une base
// SQLite TEMPORAIRE et isolée, sans toucher aux données de développement. Le
// serveur résout son dossier de données depuis process.cwd(), donc on le lance
// avec un cwd temporaire : la base est créée dans ce dossier jetable, supprimé
// à l'arrêt. Aucune modification du code applicatif n'est nécessaire.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomBytes, createDecipheriv } from 'node:crypto';
import Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.mjs');

function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// Démarre le serveur sur un port libre, avec une base et une clé jetables.
export async function startTestServer() {
  const dir = mkdtempSync(join(tmpdir(), 'osteosoft-e2e-'));
  const port = await getFreePort();
  const dataKey = randomBytes(32).toString('base64');
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    OSTEOSOFT_DATA_KEY: dataKey,
    JWT_SECRET: randomBytes(48).toString('base64'),
    API_PORT: String(port),
    ALLOW_REMOTE_SETUP: 'false'
  };

  const proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let logs = '';
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Timeout au démarrage du serveur de test.\n' + logs)), 30000);
    const onData = (chunk) => {
      logs += String(chunk);
      if (logs.includes('ready on')) {
        clearTimeout(timer);
        res();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`Le serveur de test s'est arrêté avant d'être prêt (code=${code}).\n` + logs));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dir,
    dataKey,
    dbPath: join(dir, 'server', 'data', 'osteo.db'),
    async stop() {
      try { proc.kill('SIGTERM'); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

// Client HTTP avec bocal à cookies et gestion automatique du double-submit CSRF.
export function createClient(baseUrl) {
  const jar = new Map();

  function absorb(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const first = line.split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
  }

  async function request(method, path, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
    // N'ajoute le jeton CSRF que si l'appelant ne l'a pas fixé explicitement
    // (permet de tester le rejet CSRF en passant un en-tête vide ou faux).
    if (unsafe && jar.has('os_csrf') && !('x-csrf-token' in h)) {
      h['x-csrf-token'] = jar.get('os_csrf');
    }
    if (body !== undefined) h['Content-Type'] = 'application/json';

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    absorb(res);
    const raw = await res.text();
    let json;
    try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
    return { status: res.status, body: json, raw };
  }

  return {
    request,
    cookies: jar,
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, { ...o, body }),
    put: (p, body, o) => request('PUT', p, { ...o, body }),
    patch: (p, body, o) => request('PATCH', p, { ...o, body }),
    del: (p, o) => request('DELETE', p, o),
    login: (username, password) => request('POST', '/api/auth/login', { body: { username, password } })
  };
}

export const DEFAULT_ADMIN_PASSWORD = 'Str0ng!Passw0rd';

// Amorce une instance propre (un cabinet, un admin) et renvoie un client admin authentifié.
export async function setupCleanInstance(baseUrl, opts = {}) {
  const officeName = opts.officeName ?? 'Cabinet Test';
  const adminPassword = opts.adminPassword ?? DEFAULT_ADMIN_PASSWORD;
  const client = createClient(baseUrl);

  const setup = await client.post('/api/setup/office', { name: officeName, adminPassword });
  if (setup.status !== 200 && setup.status !== 201) {
    throw new Error(`setup/office a échoué (${setup.status}): ${setup.raw?.slice(0, 300)}`);
  }
  const login = await client.login('admin', adminPassword);
  if (login.status !== 200) {
    throw new Error(`login admin a échoué (${login.status}): ${login.raw?.slice(0, 300)}`);
  }
  return { client, officeId: setup.body?.officeId ?? null, adminPassword };
}

// Ouvre la base de test en lecture seule (pour vérifier le chiffrement au repos).
export function openTestDb(server) {
  return new Database(server.dbPath, { readonly: true });
}

// Déchiffre une valeur AES-256-GCM produite par encryptSensitiveField (base64 de iv(12) + tag(16) + ciphertext).
export function decryptField(dataKeyBase64, cipherB64) {
  const key = Buffer.from(dataKeyBase64, 'base64');
  const payload = Buffer.from(String(cipherB64), 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
}
