// Modèle de permissions (server/lib/access.mjs) : fonctions pures de construction,
// normalisation, fusion et évaluation des grilles de droits. Le cloisonnement lié
// à la base (canUserAccessPatient, périmètres de cabinet) est couvert par les
// tests d'isolation cabinet/consultation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPER_ADMIN_PROFILE_ID,
  ACCESS_DOMAIN_DEFINITIONS,
  buildAccessRights,
  normalizeAccessRights,
  buildAccessRightsForPermissions,
  mergeAccessRights,
  createAccessProfileId,
  hasPermission,
  isApplicationSuperAdmin,
  getAccessibleBillingOfficeIds,
  getScopedBillingOfficeIds
} from '../lib/access.mjs';

describe('Grilles de droits (construction et normalisation)', () => {
  test('buildAccessRights couvre tout le catalogue avec la valeur par défaut', () => {
    const allow = buildAccessRights(true);
    const deny = buildAccessRights(false);
    for (const [domainId, permissionIds] of Object.entries(ACCESS_DOMAIN_DEFINITIONS)) {
      for (const permissionId of permissionIds) {
        assert.equal(allow[domainId][permissionId], true, `${permissionId} accordé`);
        assert.equal(deny[domainId][permissionId], false, `${permissionId} refusé`);
      }
    }
  });

  test('normalizeAccessRights ignore les permissions inconnues et applique le repli', () => {
    const normalized = normalizeAccessRights({
      billing: { 'create-invoice': true, 'permission-fantome': true },
      'domaine-inconnu': { foo: true }
    }, false);
    assert.equal(normalized.billing['create-invoice'], true, 'droit connu conservé');
    assert.equal(normalized.billing['mark-payment'], false, 'droit absent retombe sur le repli');
    assert.equal(normalized.billing['permission-fantome'], undefined, 'droit inconnu écarté');
    assert.equal(normalized['domaine-inconnu'], undefined, 'domaine inconnu écarté');
  });

  test('normalizeAccessRights ignore les valeurs non booléennes', () => {
    const normalized = normalizeAccessRights({ billing: { 'create-invoice': 'oui', 'mark-payment': false } }, false);
    assert.equal(normalized.billing['create-invoice'], false, 'valeur non booléenne retombe sur le repli');
    assert.equal(normalized.billing['mark-payment'], false, 'false explicite conservé');
  });

  test('buildAccessRightsForPermissions active seulement les droits listés', () => {
    const rights = buildAccessRightsForPermissions(['create-invoice', 'read-agenda']);
    assert.equal(rights.billing['create-invoice'], true);
    assert.equal(rights.agenda['read-agenda'], true);
    assert.equal(rights.billing['mark-payment'], false);
  });

  test('mergeAccessRights réalise l union des droits accordés', () => {
    const merged = mergeAccessRights([
      { billing: { 'create-invoice': true } },
      { agenda: { 'read-agenda': true } },
      { billing: { 'create-invoice': false } }
    ]);
    assert.equal(merged.billing['create-invoice'], true, 'un droit accordé une fois reste accordé');
    assert.equal(merged.agenda['read-agenda'], true);
    assert.equal(merged.billing['mark-payment'], false);
  });
});

describe('Évaluation des droits', () => {
  test('hasPermission détecte un droit tous domaines confondus', () => {
    const rights = buildAccessRightsForPermissions(['read-agenda']);
    assert.equal(hasPermission(rights, 'read-agenda'), true);
    assert.equal(hasPermission(rights, 'create-invoice'), false);
    assert.equal(hasPermission(null, 'read-agenda'), false, 'grille absente => aucun droit');
  });

  test('isApplicationSuperAdmin reconnaît le rôle admin et le profil super-admin', () => {
    assert.equal(isApplicationSuperAdmin({ role: 'admin' }), true);
    assert.equal(isApplicationSuperAdmin({ profileId: SUPER_ADMIN_PROFILE_ID }), true);
    assert.equal(isApplicationSuperAdmin({ role: 'user', profileId: 'secretariat' }), false);
    assert.equal(isApplicationSuperAdmin(null), false);
  });
});

describe('Périmètre de facturation par cabinet', () => {
  test('getAccessibleBillingOfficeIds dédoublonne et filtre les identifiants valides', () => {
    assert.deepEqual(
      getAccessibleBillingOfficeIds({ officeIds: [1, 2, 2, 0, -3, '4', null] }).sort((a, b) => a - b),
      [1, 2, 4]
    );
    assert.deepEqual(getAccessibleBillingOfficeIds(null), []);
  });

  test('getScopedBillingOfficeIds restreint au cabinet demandé s il est accessible', () => {
    const access = { officeIds: [1, 2, 3] };
    assert.deepEqual(getScopedBillingOfficeIds(access, 2), [2], 'cabinet accessible => restreint à lui');
    assert.deepEqual(getScopedBillingOfficeIds(access, 9), [], 'cabinet hors périmètre => vide');
    assert.deepEqual(getScopedBillingOfficeIds(access, null).sort((a, b) => a - b), [1, 2, 3], 'aucun cabinet demandé => tout le périmètre');
  });
});

describe('Identifiant de profil', () => {
  test('createAccessProfileId translittère le libellé et reste stable en forme', () => {
    const id = createAccessProfileId('Secrétariat Médical');
    assert.match(id, /^secr-tariat-m-dical-\d+$/, 'slug attendu suivi d un horodatage');
  });

  test('createAccessProfileId retombe sur profile pour un libellé vide', () => {
    assert.match(createAccessProfileId('   '), /^profile-\d+$/);
    assert.match(createAccessProfileId(null), /^profile-\d+$/);
  });
});
