// En-tetes CSP servis par l'API.
//
// En deploiement mono-service accede en HTTP direct (LAN, sans TLS), la
// directive upgrade-insecure-requests (ajoutee par defaut par helmet) ferait
// echouer le chargement du JS/CSS (upgrade vers un HTTPS inexistant), d'ou une
// page blanche. Elle doit donc etre absente par defaut. (Ce cas echappe aux
// tests navigateur car les navigateurs exemptent localhost de cet upgrade.)

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/harness.mjs';

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server?.stop();
});

describe('En-tetes CSP', () => {
  test('CSP presente, sans upgrade-insecure-requests par defaut', async () => {
    const res = await fetch(`${server.baseUrl}/api/setup/status`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.length > 0, 'une CSP doit etre presente');
    assert.ok(
      !/upgrade-insecure-requests/i.test(csp),
      `upgrade-insecure-requests ne doit pas etre presente par defaut. CSP recue: ${csp}`
    );
    // Sanity : nos directives sont bien la.
    assert.ok(/script-src 'self'/.test(csp), 'script-src self attendu');
    assert.ok(/connect-src 'self'/.test(csp), 'connect-src self attendu');
  });
});
