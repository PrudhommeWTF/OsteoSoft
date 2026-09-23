// Mise a jour depuis l'interface (routes /api/system/update*), de bout en bout
// contre le vrai serveur, branche sur un FAUX GitHub local (OSTEOSOFT_GITHUB_API) :
// aucun appel reseau reel. Verifie : verification de version par canal, reserve
// admin, confirmation par mot de passe, refus de retour en arriere, depot du
// declencheur lu par le script root, interrupteurs d'arret.
//
// heavyOperationLimiter limite a 5 POST par fenetre et par IP : les scenarios
// POST sont repartis sur plusieurs instances.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import {
  startTestServer,
  setupCleanInstance,
  createClient,
  DEFAULT_ADMIN_PASSWORD
} from './helpers/harness.mjs';

const require = createRequire(import.meta.url);
const APP_VERSION = require('../../package.json').version;

// ── Faux GitHub ─────────────────────────────────────────────────────────────
const fakeGithub = {
  latest: /** @type {any} */ ({ tag_name: 'v9.9.9', name: 'v9.9.9', body: 'Notes 9.9.9', html_url: 'https://example.test/v9.9.9', prerelease: false }),
  list: /** @type {any[]} */ ([
    { tag_name: 'v9.9.9', prerelease: false },
    { tag_name: 'v10.0.0-rc.1', prerelease: true }
  ]),
  requests: 0
};
/** @type {http.Server} */
let ghServer;
let ghBase = '';

// Script root factice : sa seule presence rend la mise a jour « possible ».
const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osteosoft-helper-'));
const helperPath = path.join(helperDir, 'osteosoft-self-update.sh');

before(async () => {
  fs.writeFileSync(helperPath, '#!/bin/sh\n');
  ghServer = http.createServer((req, res) => {
    fakeGithub.requests += 1;
    const url = String(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (url.endsWith('/releases/latest')) {
      res.end(JSON.stringify(fakeGithub.latest));
      return;
    }
    if (url.includes('/releases?per_page=30')) {
      res.end(JSON.stringify(fakeGithub.list));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => ghServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (ghServer.address());
  ghBase = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => ghServer.close(() => resolve(undefined)));
  fs.rmSync(helperDir, { recursive: true, force: true });
});

/** @param {Record<string, string>} [extraEnv] */
async function boot(extraEnv = {}) {
  const server = await startTestServer({
    env: { OSTEOSOFT_GITHUB_API: ghBase, OSTEOSOFT_SELF_UPDATE_HELPER: helperPath, ...extraEnv }
  });
  const { client } = await setupCleanInstance(server.baseUrl);
  const dataDir = path.join(server.dir, 'server', 'data');
  return { server, admin: client, dataDir };
}

describe('Mise a jour : verification et declenchement', () => {
  /** @type {Awaited<ReturnType<typeof boot>>} */
  let ctx;

  before(async () => {
    fakeGithub.latest = { tag_name: 'v9.9.9', name: 'v9.9.9', body: 'Notes 9.9.9', html_url: 'https://example.test/v9.9.9', prerelease: false };
    ctx = await boot();
  });
  after(async () => {
    await ctx?.server.stop();
  });

  test('reserve aux administrateurs (401 sans session)', async () => {
    const anon = createClient(ctx.server.baseUrl);
    assert.equal((await anon.get('/api/system/update')).status, 401);
    assert.equal((await anon.post('/api/system/update', { password: 'x' })).status, 401);
  });

  test('canal stable : version disponible signalee', async () => {
    const r = await ctx.admin.get('/api/system/update');
    assert.equal(r.status, 200);
    assert.equal(r.body.current, APP_VERSION);
    assert.equal(r.body.channel, 'latest');
    assert.equal(r.body.selfUpdate, true, 'script root present');
    assert.equal(r.body.latestTag, 'v9.9.9');
    assert.equal(r.body.updateAvailable, true);
  });

  test('canal preversions : la preversion la plus haute est proposee', async () => {
    const put = await ctx.admin.put('/api/system/update/channel', { channel: 'prerelease' });
    assert.equal(put.status, 200);
    assert.equal(put.body.channel, 'prerelease');
    const r = await ctx.admin.get('/api/system/update');
    assert.equal(r.body.channel, 'prerelease');
    assert.equal(r.body.latestTag, 'v10.0.0-rc.1');
    assert.equal(r.body.prerelease, true);

    assert.equal((await ctx.admin.put('/api/system/update/channel', { channel: 'nimporte' })).status, 400);
    assert.equal((await ctx.admin.put('/api/system/update/channel', { channel: 'latest' })).status, 200);
  });

  test('mot de passe requis, puis refuse s il est faux (aucun declencheur)', async () => {
    assert.equal((await ctx.admin.post('/api/system/update', {})).status, 400);
    const wrong = await ctx.admin.post('/api/system/update', { password: 'MauvaisMotDePasse!9' });
    assert.equal(wrong.status, 403);
    assert.equal(fs.existsSync(path.join(ctx.dataDir, '.update-trigger')), false);
  });

  test('bon mot de passe : declencheur depose avec le tag, statut running', async () => {
    const r = await ctx.admin.post('/api/system/update', { password: DEFAULT_ADMIN_PASSWORD });
    assert.equal(r.status, 202, r.raw);
    assert.equal(r.body.tag, 'v9.9.9');
    assert.equal(fs.readFileSync(path.join(ctx.dataDir, '.update-trigger'), 'utf-8'), 'tag=v9.9.9\n');

    const status = await ctx.admin.get('/api/system/update/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.state, 'running');
    assert.equal(status.body.current, APP_VERSION);
  });

  test('une mise a jour deja en cours : refus', async () => {
    const r = await ctx.admin.post('/api/system/update', { password: DEFAULT_ADMIN_PASSWORD });
    assert.equal(r.status, 409);
  });
});

describe('Mise a jour : garde-fous', () => {
  /** @type {Awaited<ReturnType<typeof boot>>} */
  let ctx;

  before(async () => {
    ctx = await boot();
  });
  after(async () => {
    await ctx?.server.stop();
    fakeGithub.latest = { tag_name: 'v9.9.9', name: 'v9.9.9', body: '', html_url: '', prerelease: false };
  });

  test('jamais de retour en arriere : release anterieure refusee', async () => {
    fakeGithub.latest = { tag_name: 'v0.0.1', name: 'v0.0.1', body: '', html_url: '', prerelease: false };
    const check = await ctx.admin.get('/api/system/update');
    assert.equal(check.body.updateAvailable, false);

    const r = await ctx.admin.post('/api/system/update', { password: DEFAULT_ADMIN_PASSWORD });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /Déjà à jour/);
    assert.equal(fs.existsSync(path.join(ctx.dataDir, '.update-trigger')), false);
  });

  test('script root absent : bouton refuse, consigne de mise a jour manuelle', async () => {
    fakeGithub.latest = { tag_name: 'v9.9.9', name: 'v9.9.9', body: '', html_url: '', prerelease: false };
    fs.renameSync(helperPath, `${helperPath}.off`);
    try {
      const check = await ctx.admin.get('/api/system/update');
      assert.equal(check.body.selfUpdate, false);
      assert.equal(check.body.selfUpdateReason, 'missing');

      const r = await ctx.admin.post('/api/system/update', { password: DEFAULT_ADMIN_PASSWORD });
      assert.equal(r.status, 409);
      assert.match(r.body.message, /install\.sh/);
    } finally {
      fs.renameSync(`${helperPath}.off`, helperPath);
    }
  });
});

describe('Mise a jour : verification desactivable (UPDATE_CHECK=false)', () => {
  /** @type {Awaited<ReturnType<typeof boot>>} */
  let ctx;

  before(async () => {
    ctx = await boot({ UPDATE_CHECK: 'false' });
  });
  after(async () => {
    await ctx?.server.stop();
  });

  test('aucun appel a GitHub, et le bouton est refuse', async () => {
    const before = fakeGithub.requests;
    const r = await ctx.admin.get('/api/system/update');
    assert.equal(r.status, 200);
    assert.equal(r.body.checkEnabled, false);
    assert.equal(r.body.latestTag, undefined);

    const post = await ctx.admin.post('/api/system/update', { password: DEFAULT_ADMIN_PASSWORD });
    assert.equal(post.status, 409);
    assert.equal(fakeGithub.requests, before, 'aucune requete sortante vers GitHub');
  });
});
