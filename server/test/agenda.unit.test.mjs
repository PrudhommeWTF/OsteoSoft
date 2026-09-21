// Agenda (server/lib/agenda.mjs) : fonctions pures. Les opérations liées à la
// base (préférences, calendriers, chevauchements) sont couvertes par le test de
// fumée agenda.smoke.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUserAgendaPreferences,
  getCalendarColorByIndex,
  getFirstOpeningMinute,
  alignDateToOfficeSlot,
  OFFICE_OPENING_DAY_KEYS
} from '../lib/agenda.mjs';

describe('normalizeUserAgendaPreferences', () => {
  test('applique les valeurs par défaut sur une entrée vide', () => {
    const p = normalizeUserAgendaPreferences(null);
    assert.equal(p.slotDurationMinutes, 15);
    assert.equal(p.displayHeight, 14);
    assert.equal(p.themeMode, 'system');
    assert.equal(p.consultationOrder, 'Antichronologique');
    assert.equal(p.showWeekend, false);
  });

  test('borne la durée de créneau entre 5 et 50', () => {
    assert.equal(normalizeUserAgendaPreferences({ slotDurationMinutes: 1 }).slotDurationMinutes, 5);
    assert.equal(normalizeUserAgendaPreferences({ slotDurationMinutes: 99 }).slotDurationMinutes, 50);
    assert.equal(normalizeUserAgendaPreferences({ slotDurationMinutes: 30 }).slotDurationMinutes, 30);
  });

  test('n accepte que les valeurs d énumération connues', () => {
    assert.equal(normalizeUserAgendaPreferences({ themeMode: 'dark' }).themeMode, 'dark');
    assert.equal(normalizeUserAgendaPreferences({ themeMode: 'neon' }).themeMode, 'system');
    assert.equal(normalizeUserAgendaPreferences({ appointmentColorMode: 'user' }).appointmentColorMode, 'user');
    assert.equal(normalizeUserAgendaPreferences({ appointmentColorMode: 'xxx' }).appointmentColorMode, 'calendar');
  });
});

describe('getCalendarColorByIndex', () => {
  test('boucle sur la palette', () => {
    const c0 = getCalendarColorByIndex(0);
    assert.match(c0, /^#[0-9a-f]{6}$/);
    assert.equal(getCalendarColorByIndex(8), c0, 'la palette (8 couleurs) boucle');
  });
});

describe('getFirstOpeningMinute', () => {
  test('lit la première plage d ouverture du jour', () => {
    const monday = new Date('2024-01-01T00:00:00'); // lundi
    assert.equal(OFFICE_OPENING_DAY_KEYS[(monday.getDay() + 6) % 7], 'monday');
    const minute = getFirstOpeningMinute({ monday: [{ start: '08:30' }] }, monday);
    assert.equal(minute, 8 * 60 + 30);
  });

  test('retombe sur 9h00 si aucune plage', () => {
    const monday = new Date('2024-01-01T00:00:00');
    assert.equal(getFirstOpeningMinute({ monday: [] }, monday), 9 * 60);
    assert.equal(getFirstOpeningMinute({}, monday), 9 * 60);
  });
});

describe('alignDateToOfficeSlot', () => {
  test('aligne une heure sur le créneau inférieur', () => {
    const d = new Date('2024-01-01T09:07:00');
    const aligned = alignDateToOfficeSlot(d, 9 * 60, 15);
    assert.equal(aligned.getHours(), 9);
    assert.equal(aligned.getMinutes(), 0, '09:07 -> 09:00 avec créneaux de 15 min');
  });

  test('aligne sur le créneau suivant plein', () => {
    const d = new Date('2024-01-01T09:20:00');
    const aligned = alignDateToOfficeSlot(d, 9 * 60, 15);
    assert.equal(aligned.getHours(), 9);
    assert.equal(aligned.getMinutes(), 15, '09:20 -> 09:15');
  });

  test('remonte une heure avant l ouverture à la première minute', () => {
    const d = new Date('2024-01-01T07:30:00');
    const aligned = alignDateToOfficeSlot(d, 9 * 60, 15);
    assert.equal(aligned.getHours(), 9);
    assert.equal(aligned.getMinutes(), 0);
  });
});
