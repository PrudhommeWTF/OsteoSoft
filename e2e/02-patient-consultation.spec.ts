import { test, expect } from '@playwright/test';
import { ensureLoggedIn, createPatient } from './helpers/app';

// Parcours 2 : creation d'un patient puis d'une consultation.
//
// Coeur metier du logiciel. Le premier scenario cree un patient via l'assistant
// et verifie qu'il apparait dans la liste. Le second ouvre ce patient et cree une
// consultation, puis verifie qu'elle est bien rattachee au dossier.
//
// L'instance est partagee : le patient cree au premier scenario est reutilise au
// second (describe.serial). Un suffixe unique evite les collisions entre executions.

const SUFFIX = Date.now().toString().slice(-6);
const LAST_NAME = `Test${SUFFIX}`;
const FIRST_NAME = 'Camille';

test.describe.serial('Creation patient et consultation', () => {
  test.beforeEach(async ({ page }) => {
    await ensureLoggedIn(page);
  });

  test('creer un patient l ajoute a la liste', async ({ page }) => {
    await createPatient(page, { lastName: LAST_NAME, firstName: FIRST_NAME, sex: 'Femme' });

    await expect(page).toHaveURL(/\/patients$/);

    // Recherche par nom pour eviter la pagination, puis le patient doit apparaitre.
    await page.locator('input.pat-search-input').fill(LAST_NAME);
    await expect(page.getByRole('link', { name: new RegExp(LAST_NAME, 'i') })).toBeVisible();
  });

  test('creer une consultation la rattache au dossier patient', async ({ page }) => {
    // Ouvrir le dossier du patient cree au scenario precedent.
    await page.goto('/patients');
    await page.locator('input.pat-search-input').fill(LAST_NAME);
    await page.getByRole('link', { name: new RegExp(LAST_NAME, 'i') }).click();
    await expect(page).toHaveURL(/\/patients\/\d+$/);

    // Le dossier n'a pas encore de consultation.
    await expect(page.getByText('Aucune consultation enregistrée')).toBeVisible();

    // Nouvelle consultation : les champs obligatoires (date/heure) sont pre-remplis.
    await page.getByRole('link', { name: 'Nouvelle consultation' }).click();
    await expect(page).toHaveURL(/\/consultations\/nouvelle$/);

    await page.locator('.cw-title-input').fill('Consultation de controle');
    await page.getByRole('button', { name: 'Créer la consultation' }).click();

    // Retour au dossier patient, la consultation apparait.
    await expect(page).toHaveURL(/\/patients\/\d+$/);
    await expect(page.getByText('Aucune consultation enregistrée')).toBeHidden();
    await expect(page.locator('.pd-consult-card').first()).toBeVisible();
  });
});
