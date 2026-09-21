import { expect, type Page } from '@playwright/test';

// Constantes et helpers reutilisables par les scenarios end-to-end.
// L'instance de test est amorcee sans cle de chiffrement a saisir (le serveur
// de test fournit OSTEOSOFT_DATA_KEY), donc l'etape de cle est masquee.

export const ADMIN_USERNAME = 'admin';
// Mot de passe conforme au motif exige (minuscule, majuscule, chiffre, special,
// 12 caracteres minimum).
export const ADMIN_PASSWORD = 'Str0ng!Passw0rd';
export const OFFICE_NAME = 'Cabinet de test E2E';

/**
 * Deroule l'assistant d'installation initiale depuis une instance vierge
 * jusqu'a la creation du cabinet et du compte admin. Termine sur /login.
 */
export async function installFreshInstance(
  page: Page,
  options: { officeName?: string; adminPassword?: string } = {}
): Promise<void> {
  const officeName = options.officeName ?? OFFICE_NAME;
  const adminPassword = options.adminPassword ?? ADMIN_PASSWORD;

  await page.goto('/installation');

  // Ecran d'accueil : choisir la creation d'un nouveau cabinet.
  await page.getByRole('button', { name: 'Nouveau cabinet' }).click();

  // Etape 1 : informations obligatoires.
  await page.locator('#setup-name').fill(officeName);
  await page.locator('#setup-admin-password').fill(adminPassword);
  await page.locator('#setup-admin-password-confirmation').fill(adminPassword);

  // Etapes 2 a 5 : valeurs par defaut, on avance jusqu'a la derniere etape.
  for (let i = 0; i < 5; i += 1) {
    await page.getByRole('button', { name: 'Suivant' }).click();
  }

  // Etape 6 : finaliser.
  await page.getByRole('button', { name: "Terminer l'installation" }).click();

  await page.waitForURL('**/login');
}

/**
 * Connexion via l'interface. Termine sur le tableau de bord (/accueil).
 */
export async function login(
  page: Page,
  options: { username?: string; password?: string } = {}
): Promise<void> {
  const username = options.username ?? ADMIN_USERNAME;
  const password = options.password ?? ADMIN_PASSWORD;

  await page.goto('/login');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();

  await page.waitForURL('**/accueil');
  await expect(page).toHaveURL(/\/accueil$/);
}
