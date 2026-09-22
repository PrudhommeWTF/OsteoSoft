import { test, expect } from '@playwright/test';
import { ensureLoggedIn, pickCalendarDay } from './helpers/app';

// Parcours 4 : agenda et rendez-vous.
//
// On cree un rendez-vous prive (sans dependance a un patient) depuis l'agenda,
// et on verifie qu'il est accepte puis affiche dans le calendrier.

const SUFFIX = Date.now().toString().slice(-6);
const REASON = `Reunion ${SUFFIX}`;

test.describe.serial('Agenda et rendez-vous', () => {
  test.beforeEach(async ({ page }) => {
    await ensureLoggedIn(page);
  });

  test('creer un rendez-vous prive l affiche dans le calendrier', async ({ page }) => {
    await page.goto('/agenda');

    await page.getByRole('button', { name: 'Nouveau rendez-vous' }).click();
    await expect(page.locator('#create-appointment-modal-title')).toBeVisible();

    // Rendez-vous prive : evite la dependance a un patient existant.
    await page.locator('#create-private').check();
    await page.locator('#create-private-reason').fill(REASON);

    // Date (selecteur calendrier) et heure : renseignent le creneau (startsAt).
    await pickCalendarDay(page, 'create-slot-date');
    await page.locator('#create-slot-time').fill('10:00');

    // Le motif est marque "(facultatif)" dans l'interface mais le serveur le
    // refuse vide : on le renseigne donc.
    await page.locator('#create-reason').fill('Point equipe');

    await page.getByRole('button', { name: 'Créer le rendez-vous' }).click();

    // La creation est confirmee par le serveur.
    await expect(page.getByText('Rendez-vous créé avec succès.')).toBeVisible();

    // Le rendez-vous (le 15 du mois courant) apparait dans la vue mensuelle.
    // On cible par le libelle visible : bsTooltip deplace l'attribut title vers
    // data-bs-original-title, un selecteur [title=...] ne matcherait plus.
    await page.getByRole('button', { name: 'Mois', exact: true }).click();
    await expect(page.locator('.wc-month-event').first()).toBeVisible();
  });
});
