import { test, expect } from '@playwright/test';
import { installFreshInstance, login, ADMIN_PASSWORD, OFFICE_NAME } from './helpers/app';

// Parcours 1 : installation initiale puis connexion.
//
// L'instance de test demarre vierge. Le premier scenario deroule l'assistant
// d'installation (creation du cabinet et du compte admin), le second se connecte
// avec ce compte. Les deux partagent la meme instance : l'ordre est donc impose
// (describe.serial), l'installation devant preceder la connexion.

test.describe.serial('Installation initiale et connexion', () => {
  test('l installation initiale cree le cabinet et redirige vers la connexion', async ({ page }) => {
    // Instance vierge : la racine doit renvoyer vers l'installation.
    await page.goto('/');
    await expect(page).toHaveURL(/\/installation$/);

    await installFreshInstance(page, { officeName: OFFICE_NAME, adminPassword: ADMIN_PASSWORD });

    // On arrive sur la page de connexion, prete a l'emploi.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
  });

  test('l installation ne peut plus etre relancee une fois le cabinet cree', async ({ page }) => {
    // Le cabinet existe desormais : l'installation redirige vers la connexion.
    await page.goto('/installation');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('la connexion admin mene au tableau de bord', async ({ page }) => {
    await login(page, { password: ADMIN_PASSWORD });

    await expect(page).toHaveURL(/\/accueil$/);
    // Un element de coquille authentifiee doit etre present (navigation laterale).
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('un mot de passe errone refuse la connexion', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('MauvaisMotDePasse!9');
    await page.getByRole('button', { name: 'Se connecter' }).click();

    // On reste sur la page de connexion, aucun acces au tableau de bord.
    await expect(page).toHaveURL(/\/login$/);
  });
});
