// Import WebOsteo, export « liste patients » : normalisation des lignes et
// rapprochement avec les patients de la base. Donnees fictives uniquement.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  listingDateToKey,
  utf8Len,
  normalizeListingRows,
  createListingMatcher
} from '../lib/webosteo-listing.mjs';

describe('helpers', () => {
  test('listingDateToKey convertit JJ/MM/AAAA en AAAAMMJJ', () => {
    assert.equal(listingDateToKey('05/09/2026'), '20260905');
    assert.equal(listingDateToKey(''), '');
    assert.equal(listingDateToKey('n/a'), '');
  });
  test('utf8Len compte les octets UTF-8 (unite du chiffrement)', () => {
    assert.equal(utf8Len('ABC'), 3);
    assert.equal(utf8Len('Boqué'), 6); // é = 2 octets
  });
});

describe('normalizeListingRows', () => {
  const rows = [
    ['Listing patient généré au : 25/09/2026'],
    ['', 'Nom', 'Prénom', 'Sexe', 'Date de naissance', 'Téléphone portable', 'Téléphone fixe', 'Adresse email', 'Adresse 1', 'Adresse 2', 'Code postal', 'Ville', 'Numéro Sécurité Sociale', 'Créé le'],
    ['', 'MARTIN', 'Alice', 'f', '12/03/1988', '06 11 22 33 44', '', 'alice@example.test', '3 rue A', '', '75001', 'Paris', '', '01/02/2020'],
    ['', '', 'SansNom', 'm', '01/01/2000', '', '', '', '', '', '', '', '', ''] // ligne sans nom -> ignoree
  ];
  test('detecte l en-tete et mappe les colonnes', () => {
    const recs = normalizeListingRows(rows);
    assert.equal(recs.length, 1);
    const r = recs[0];
    assert.equal(r.nom, 'MARTIN');
    assert.equal(r.prenom, 'Alice');
    assert.equal(r.sexe, 'f');
    assert.equal(r.dob, '19880312');
    assert.equal(r.telephone1, '06 11 22 33 44');
    assert.equal(r.email, 'alice@example.test');
    assert.equal(r.code_postal, '75001');
    assert.equal(r.ville, 'Paris');
    assert.equal(r.cree, '20200201');
  });
  test('renvoie [] si pas d en-tete Nom/Prénom', () => {
    assert.deepEqual(normalizeListingRows([['x', 'y'], ['1', '2']]), []);
    assert.deepEqual(normalizeListingRows([]), []);
  });
});

describe('createListingMatcher', () => {
  /** @param {Partial<import('../lib/webosteo-listing.mjs').ListingRecord>} o */
  const rec = (o) => ({ nom: '', prenom: '', sexe: '', dob: '', telephone1: '', telephone2: '', email: '', adresse1: '', adresse2: '', code_postal: '', ville: '', secu: '', cree: '', ...o });
  const enc = (nom, tel = 0, cp = 0, ville = 0, email = 0) => ({ nom: utf8Len(nom), tel, cp, ville, email });

  test('match unique sur prénom + date de naissance + sexe', () => {
    const m = createListingMatcher([rec({ nom: 'DURAND', prenom: 'Bob', sexe: 'm', dob: '19900101' })]);
    const hit = m.match({ prenom: 'bob', sexe: 'M', dob: '19900101', cree: '', encLen: enc('DURAND') });
    assert.equal(hit?.nom, 'DURAND');
    assert.equal(hit?._confidence, 'high');
    assert.equal(m.match({ prenom: 'inconnu', sexe: 'm', dob: '19900101', cree: '', encLen: enc('X') }), null);
  });

  test('une ligne n est attribuee qu a un seul patient (1 pour 1)', () => {
    const m = createListingMatcher([rec({ nom: 'DURAND', prenom: 'Bob', sexe: 'm', dob: '19900101' })]);
    assert.ok(m.match({ prenom: 'bob', sexe: 'm', dob: '19900101', cree: '', encLen: enc('DURAND') }));
    // deuxieme patient meme cle : plus de ligne disponible
    assert.equal(m.match({ prenom: 'bob', sexe: 'm', dob: '19900101', cree: '', encLen: enc('DURAND') }), null);
  });

  test('homonymes departages par la longueur des champs chiffres', () => {
    const m = createListingMatcher([
      rec({ nom: 'LEE', prenom: 'Sam', sexe: 'm', dob: '19801212', telephone1: '0600000000' }),      // nom 3, tel 10
      rec({ nom: 'MERCIER', prenom: 'Sam', sexe: 'm', dob: '19801212', telephone1: '01' })            // nom 7, tel 2
    ]);
    const hit = m.match({ prenom: 'sam', sexe: 'm', dob: '19801212', cree: '', encLen: enc('MERCIER', 2) });
    assert.equal(hit?.nom, 'MERCIER');
    assert.equal(hit?._confidence, 'medium');
  });

  test('homonymes indepartageables : aucun match (pas de devinette)', () => {
    const m = createListingMatcher([
      rec({ nom: 'ABC', prenom: 'Max', sexe: 'm', dob: '19700101' }),
      rec({ nom: 'XYZ', prenom: 'Max', sexe: 'm', dob: '19700101' })
    ]);
    // meme empreinte (nom de 3), pas de date de creation pour departager
    assert.equal(m.match({ prenom: 'max', sexe: 'm', dob: '19700101', cree: '', encLen: enc('???') }), null);
    assert.equal(m.stats.ambiguous, 1);
  });

  test('longueur de nom incoherente : match conserve mais confiance basse', () => {
    const m = createListingMatcher([rec({ nom: 'DURAND', prenom: 'Bob', sexe: 'm', dob: '19900101' })]);
    const hit = m.match({ prenom: 'bob', sexe: 'm', dob: '19900101', cree: '', encLen: enc('XX') });
    assert.equal(hit?.nom, 'DURAND');
    assert.equal(hit?._confidence, 'low');
    assert.equal(m.stats.lengthMismatch, 1);
  });
});
