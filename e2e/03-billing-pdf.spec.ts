import { test, expect } from '@playwright/test';
import { ensureLoggedIn, createPatient } from './helpers/app';

// Parcours 3 : facturation d'une consultation et telechargement du PDF.
//
// On cree un patient et une consultation, on facture la consultation depuis
// l'onglet Paiement (numerotation serveur, cf. PR #118), puis on verifie que la
// facture est generee (numero attribue) et que son PDF est telechargeable.

const SUFFIX = Date.now().toString().slice(-6);
const LAST_NAME = `Factu${SUFFIX}`;
const FIRST_NAME = 'Louis';

test.describe.serial('Facturation et PDF', () => {
  test.beforeEach(async ({ page }) => {
    await ensureLoggedIn(page);
  });

  test('facturer une consultation genere une facture numerotee et telechargeable', async ({ page }) => {
    // Patient + acces a une nouvelle consultation.
    await createPatient(page, { lastName: LAST_NAME, firstName: FIRST_NAME, sex: 'Homme' });
    await page.locator('input.pat-search-input').fill(LAST_NAME);
    await page.getByRole('link', { name: new RegExp(LAST_NAME, 'i') }).click();
    await expect(page).toHaveURL(/\/patients\/\d+$/);

    await page.getByRole('link', { name: 'Nouvelle consultation' }).click();
    await expect(page).toHaveURL(/\/consultations\/nouvelle$/);
    await page.locator('.cw-title-input').fill('Consultation a facturer');

    // Onglet Paiement : facturer la consultation.
    await page.getByRole('tab', { name: 'Paiement' }).click();
    await page.getByRole('button', { name: 'Facturer la consultation' }).click();

    // Montant de la prestation, puis generation (la consultation est sauvegardee
    // automatiquement pour obtenir un identifiant, cf. generateInvoice).
    await page.locator('input[formcontrolname="amountHt"]').fill('60');
    await page.getByRole('button', { name: 'Générer la facture acquittée' }).click();

    // La facture est generee : un numero est attribue et le PDF est disponible.
    await expect(page.getByText(/Facture n°/)).toBeVisible();
    const downloadButton = page.getByRole('button', { name: 'Télécharger la facture' });
    await expect(downloadButton).toBeVisible();

    // Le telechargement ouvre le PDF dans un nouvel onglet. La fonction n'ouvre
    // la fenetre qu'apres avoir recupere et decode le document (sinon elle affiche
    // une erreur) : l'ouverture du popup atteste donc que le PDF existe.
    const popupPromise = page.waitForEvent('popup');
    await downloadButton.click();
    const popup = await popupPromise;
    expect(popup).toBeTruthy();
    await expect(page.getByText('Impossible d\'ouvrir le document.')).toBeHidden();
  });
});
