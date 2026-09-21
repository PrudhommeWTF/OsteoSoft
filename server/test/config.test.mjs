// Configuration serveur (server/lib/config.mjs) : lecture de l'environnement,
// valeurs par défaut, et garde de démarrage sur la clé JWT. Fonctions pures,
// testées sans variables globales (environnement injecté).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadServerConfig, assertConfigUsable, DEV_JWT_SECRET } from '../lib/config.mjs';

describe('loadServerConfig, valeurs par défaut', () => {
  test('applique les valeurs par défaut quand l environnement est vide', () => {
    const cfg = loadServerConfig({}, { cwd: '/app' });
    assert.equal(cfg.port, 4199);
    assert.equal(cfg.dataDir, path.resolve('/app', 'server/data'));
    assert.equal(cfg.dbPath, path.resolve('/app', 'server/data', 'osteo.db'));
    assert.equal(cfg.jwtSecret, DEV_JWT_SECRET, 'clé absente => sentinelle de développement');
    assert.equal(cfg.isProduction, false);
    assert.equal(cfg.isDevelopment, false, 'NODE_ENV absent => pas développement (déploiement réel)');
    assert.equal(cfg.allowRemoteSetup, false);
    assert.equal(cfg.requestBodyLimit, '5mb');
    assert.equal(cfg.largeRequestBodyLimit, '200mb');
    assert.equal(cfg.maxPatientDocumentBytes, 15 * 1024 * 1024);
    assert.equal(cfg.trustedProxies, false);
    assert.equal(cfg.sessionRememberMaxAgeMs, 12 * 60 * 60 * 1000);
    assert.equal(cfg.sessionDefaultMaxAgeMs, 2 * 60 * 60 * 1000);
    assert.equal(cfg.sessionRememberTtl, '12h');
    assert.equal(cfg.sessionDefaultTtl, '2h');
    assert.equal(cfg.auditLogRetentionDays, 3650);
    assert.equal(cfg.draftRetentionDays, 7);
  });
});

describe('loadServerConfig, lecture de l environnement', () => {
  test('lit et convertit les variables fournies', () => {
    const cfg = loadServerConfig({
      API_PORT: '8080',
      JWT_SECRET: 'une-cle-solide',
      NODE_ENV: 'production',
      ALLOW_REMOTE_SETUP: 'yes',
      MAX_PATIENT_DOCUMENT_BYTES: '1234',
      AUDIT_LOG_RETENTION_DAYS: '0',
      DRAFT_RETENTION_DAYS: '30'
    });
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.jwtSecret, 'une-cle-solide');
    assert.equal(cfg.isProduction, true);
    assert.equal(cfg.isDevelopment, false);
    assert.equal(cfg.allowRemoteSetup, true);
    assert.equal(cfg.maxPatientDocumentBytes, 1234);
    assert.equal(cfg.auditLogRetentionDays, 0, '0 désactive la purge automatique');
    assert.equal(cfg.draftRetentionDays, 30);
  });

  test('une clé JWT faite d espaces retombe sur la sentinelle', () => {
    assert.equal(loadServerConfig({ JWT_SECRET: '   ' }).jwtSecret, DEV_JWT_SECRET);
  });

  test('TRUST_PROXY est interprété selon ses variantes', () => {
    assert.equal(loadServerConfig({ TRUST_PROXY: 'true' }).trustedProxies, 1);
    assert.equal(loadServerConfig({ TRUST_PROXY: '1' }).trustedProxies, 1);
    assert.equal(loadServerConfig({ TRUST_PROXY: 'loopback' }).trustedProxies, 'loopback');
    assert.equal(loadServerConfig({ TRUST_PROXY: 'autre' }).trustedProxies, false);
    assert.equal(loadServerConfig({}).trustedProxies, false);
  });
});

describe('assertConfigUsable, garde de démarrage', () => {
  test('refuse la sentinelle de développement hors mode développement', () => {
    assert.throws(
      () => assertConfigUsable({ isDevelopment: false, jwtSecret: DEV_JWT_SECRET }),
      /Refusing to start with the public development secret/
    );
  });

  test('accepte une vraie clé en production', () => {
    assert.doesNotThrow(() => assertConfigUsable({ isDevelopment: false, jwtSecret: 'vraie-cle' }));
  });

  test('avertit en développement avec la sentinelle, sans lever', () => {
    const warnings = [];
    assert.doesNotThrow(() => assertConfigUsable(
      { isDevelopment: true, jwtSecret: DEV_JWT_SECRET },
      { onWarn: (m) => warnings.push(m) }
    ));
    assert.equal(warnings.length, 1, 'un avertissement émis');
  });

  test('n avertit pas en développement avec une vraie clé', () => {
    const warnings = [];
    assertConfigUsable({ isDevelopment: true, jwtSecret: 'vraie-cle' }, { onWarn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 0);
  });
});
