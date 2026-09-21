// Tests unitaires du module de chiffrement (server/lib/crypto.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createFieldCrypto } from '../lib/crypto.mjs';

const key = randomBytes(32);
const { encryptSensitiveField, decryptSensitiveField, safeDecryptField, restoreCipherField } =
  createFieldCrypto(() => key);

describe('Chiffrement de champ (crypto.mjs)', () => {
  test('chiffre puis déchiffre (round-trip)', () => {
    const cipher = encryptSensitiveField('Données médicales sensibles');
    assert.notEqual(cipher, 'Données médicales sensibles', 'le chiffré diffère du clair');
    assert.equal(decryptSensitiveField(cipher), 'Données médicales sensibles');
  });

  test('deux chiffrements de la même valeur diffèrent (IV aléatoire)', () => {
    assert.notEqual(encryptSensitiveField('x'), encryptSensitiveField('x'));
  });

  test('le déchiffrement avec une mauvaise clé échoue', () => {
    const cipher = encryptSensitiveField('secret');
    const autre = createFieldCrypto(() => randomBytes(32));
    assert.throws(() => autre.decryptSensitiveField(cipher));
  });

  test('safeDecryptField renvoie l entrée si elle n est pas déchiffrable', () => {
    assert.equal(safeDecryptField('ceci n est pas du ciphertext'), 'ceci n est pas du ciphertext');
    assert.equal(safeDecryptField(null), '');
  });

  test('restoreCipherField est idempotent', () => {
    const cipher = encryptSensitiveField('valeur');
    assert.equal(restoreCipherField(cipher), cipher, 'une valeur déjà chiffrée reste intacte');
    const fromPlain = restoreCipherField('en clair');
    assert.equal(decryptSensitiveField(fromPlain), 'en clair', 'une valeur en clair est chiffrée');
  });

  test('le getter reflète un changement de clé au runtime', () => {
    let k = randomBytes(32);
    const dyn = createFieldCrypto(() => k);
    const c1 = dyn.encryptSensitiveField('a');
    assert.equal(dyn.decryptSensitiveField(c1), 'a');
    k = randomBytes(32); // la clé change au runtime
    assert.throws(() => dyn.decryptSensitiveField(c1), 'un ancien chiffré devient illisible avec la nouvelle clé');
  });
});
