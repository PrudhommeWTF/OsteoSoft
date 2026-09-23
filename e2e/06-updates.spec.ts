import { test, expect } from '@playwright/test';

import { ADMIN_PASSWORD, ensureLoggedIn } from './helpers/app';

// Parcours 6 : mise a jour depuis l'interface (administrateur).
//
// Le serveur de test est branche sur un FAUX GitHub local qui publie la
// version 99.0.0 (voir e2e/serve-for-e2e.mjs) : aucun appel reseau reel. Un
// faux script root rend le bouton disponible ; rien ne l'execute (pas de
// systemd ici), l'installation reste donc « en cours », ce qui suffit a
// verifier le declenchement et l'affichage du suivi.
//
// Ce fichier passe en dernier : l'etat « en cours » qu'il laisse ne gene aucun
// autre scenario.

test('la cloche signale la nouvelle version et mene a l ecran Mises a jour', async ({ page }) => {
  await ensureLoggedIn(page);

  const notice = page.getByTestId('update-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('aria-label', /99\.0\.0 disponible/);

  await notice.click();
  await page.waitForURL(/\/parametres\?section=mises-a-jour$/);

  await expect(page.getByRole('heading', { name: 'Mises à jour', level: 2 })).toBeVisible();
  await expect(page.getByTestId('update-latest')).toContainText('OsteoSoft 99.0.0');
});

test('les notes de version sont affichees en texte brut (aucun HTML interprete)', async ({ page }) => {
  let dialogOpened = false;
  page.on('dialog', async (dialog) => {
    dialogOpened = true;
    await dialog.dismiss();
  });

  await ensureLoggedIn(page);
  await page.goto('/parametres?section=mises-a-jour');

  const notes = page.locator('.upd-notes');
  await expect(notes).toContainText('Première ligne');
  await expect(notes).toContainText('<script>alert(1)</script>');
  expect(await notes.locator('script').count()).toBe(0);
  expect(dialogOpened).toBe(false);
});

test('installation : mot de passe redemande, puis suivi de la mise a jour', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/parametres?section=mises-a-jour');
  await expect(page.getByTestId('update-latest')).toBeVisible();

  const progress = page.getByTestId('update-progress');
  const password = page.locator('#update-password');
  const installButton = page.getByRole('button', { name: /Installer la version 99\.0\.0/ });

  // Nouvelle tentative (retry CI) : l'installation declenchee au premier essai
  // est toujours « en cours », le formulaire est alors remplace par le suivi.
  if (!(await progress.isVisible())) {
    await expect(installButton).toBeDisabled();

    await password.fill('MauvaisMotDePasse!9');
    await installButton.click();
    await expect(page.locator('.upd-install').getByRole('alert')).toContainText('Mot de passe incorrect');

    await password.fill(ADMIN_PASSWORD);
    await installButton.click();
  }

  await expect(progress).toBeVisible();
  await expect(progress.getByRole('status')).toBeVisible();
  await expect(installButton).toHaveCount(0);
});
