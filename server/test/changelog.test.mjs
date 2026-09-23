// GET /api/changelog (fenetre « Nouveautes ») contre le vrai serveur, avec un
// CHANGELOG.md fictif depose dans son repertoire de travail.
//
// Regression : standard-version titre les versions correctives et les
// preversions en `###` (`### [0.4.1-rc.1]`) et les versions mineures en `##`.
// La route ne decoupait que sur `## ` : les versions `###` disparaissaient.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, createClient } from './helpers/harness.mjs';

const FAKE_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

### [0.4.1-rc.1](https://example.test/compare/v0.4.0...v0.4.1-rc.1) (2026-09-23)


### Corrections de bugs

* **deploy:** redemarrer le service ([#148](https://example.test/issues/148)) ([d996ede](https://example.test/commit/d996ede))

## [0.4.0](https://example.test/compare/v0.3.0...v0.4.0) (2026-09-22)


### Nouvelles fonctionnalités

* **update:** ecran Mises a jour ([#145](https://example.test/issues/145)) ([70fbd13](https://example.test/commit/70fbd13))

### Corrections de bugs

* **auth:** cookies non Secure en HTTP direct ([7c475b0](https://example.test/commit/7c475b0))
`;

let server;

before(async () => {
  server = await startTestServer();
  fs.writeFileSync(path.join(server.dir, 'CHANGELOG.md'), FAKE_CHANGELOG);
});

after(async () => {
  await server?.stop();
});

describe('GET /api/changelog', () => {
  test('les versions correctives et preversions (titre ###) sont listees', async () => {
    const r = await createClient(server.baseUrl).get('/api/changelog');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((/** @type {any} */ e) => e.version), ['0.4.1-rc.1', '0.4.0']);

    const [rc] = r.body;
    assert.equal(rc.date, '2026-09-23');
    assert.deepEqual(rc.sections, [{ label: 'Corrections de bugs', items: ['**deploy:** redemarrer le service'] }]);
  });

  test('les rubriques ### d une version ne sont pas prises pour des versions', async () => {
    const r = await createClient(server.baseUrl).get('/api/changelog');
    const minor = r.body.find((/** @type {any} */ e) => e.version === '0.4.0');
    assert.ok(minor, 'version 0.4.0 presente');
    assert.deepEqual(minor.sections.map((/** @type {any} */ s) => s.label), ['Nouvelles fonctionnalités', 'Corrections de bugs']);
    assert.equal(minor.sections[0].items.length, 1);
  });
});
