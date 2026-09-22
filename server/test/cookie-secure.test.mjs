// Attribut Secure des cookies de session/CSRF.
//
// Un cookie Secure n'est jamais stocke par le navigateur sur une connexion HTTP.
// En deploiement mono-service accede en HTTP direct (LAN), marquer les cookies
// Secure rendait la connexion impossible (le cookie de session etait ignore).
// L'attribut Secure doit donc suivre le protocole reel de la requete, pas
// NODE_ENV : absent en HTTP, present derriere HTTPS (FORCE_HTTPS=true).

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, setupCleanInstance, DEFAULT_ADMIN_PASSWORD } from './helpers/harness.mjs';

const servers = [];
async function bootProd(extraEnv = {}) {
  const server = await startTestServer({ env: { NODE_ENV: 'production', ...extraEnv } });
  servers.push(server);
  await setupCleanInstance(server.baseUrl); // loopback : autorise meme si ALLOW_REMOTE_SETUP=false
  return server;
}

function setCookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.join('\n');
}

after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

describe('Attribut Secure des cookies', () => {
  test('production + HTTP direct : cookies NON Secure (sinon connexion impossible)', async () => {
    const server = await bootProd();
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    });
    assert.equal(res.status, 200, 'connexion attendue 200');
    const cookies = setCookieHeader(res);
    assert.ok(/os_session=/.test(cookies), 'un cookie de session doit etre pose');
    assert.ok(!/;\s*Secure/i.test(cookies), `les cookies ne doivent pas etre Secure en HTTP. Recu: ${cookies}`);
  });

  test('FORCE_HTTPS=true : cookies Secure (deploiement derriere TLS)', async () => {
    const server = await bootProd({ FORCE_HTTPS: 'true' });
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    });
    assert.equal(res.status, 200);
    const cookies = setCookieHeader(res);
    assert.ok(/;\s*Secure/i.test(cookies), `les cookies doivent etre Secure avec FORCE_HTTPS. Recu: ${cookies}`);
  });
});
