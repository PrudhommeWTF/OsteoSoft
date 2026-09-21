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

/**
 * Garantit une instance amorcee et une session admin active. Utilisable en tete
 * de chaque scenario : installe le cabinet si l'instance est vierge (une seule
 * fois par instance), puis se connecte. Rend chaque fichier de scenario
 * autonome, y compris execute seul.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/(installation|login|accueil)$/);

  if (/\/installation$/.test(page.url())) {
    await installFreshInstance(page);
  }
  if (!/\/accueil$/.test(page.url())) {
    await login(page);
  }
}

/**
 * Renseigne la date de naissance via le selecteur calendrier (composant maison,
 * pas de saisie texte). On recule de quelques mois pour rester dans le passe,
 * puis on choisit le 15 du mois affiche et on valide.
 */
export async function pickBirthDate(page: Page): Promise<void> {
  await page.locator('#birthDate .os-dp-field').click();
  await expect(page.locator('.os-dp-popup')).toBeVisible();

  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('button', { name: 'Précédent' }).click();
  }

  await page.locator('.os-dp-day:not(.os-dp-day--other)').filter({ hasText: /^15$/ }).first().click();
  await page.getByRole('button', { name: 'Valider' }).click();

  await expect(page.locator('.os-dp-popup')).toBeHidden();
}

/**
 * Cree un patient via l'assistant (5 etapes ; seule l'etape 1 est obligatoire).
 * Termine sur la liste des patients.
 */
export async function createPatient(
  page: Page,
  options: { lastName: string; firstName: string; sex?: 'Femme' | 'Homme' }
): Promise<void> {
  const sex = options.sex ?? 'Femme';

  await page.goto('/patients/nouveau');

  // Etape 1 : identite (obligatoire).
  await page.getByRole('button', { name: sex, exact: true }).click();
  await page.locator('#lastName').fill(options.lastName);
  await page.locator('#firstName').fill(options.firstName);
  await pickBirthDate(page);
  await page.locator('#consentSigned').check();

  // Etapes 2 a 5 : facultatives, on avance jusqu'a la derniere. Apres chaque
  // clic on attend l'entete de l'etape suivante : cela synchronise avec le rendu
  // Angular (un minuteur rafraichit l'indicateur de brouillon chaque seconde) et
  // evite de cliquer pendant un re-rendu. exact:true evite que getByRole('Suivant')
  // attrape les libelles "...suivante" par sous-chaine.
  const nextHeadings = ['Coordonnées', 'Autres informations', 'Antécédents', 'Premiere consultation'];
  for (const heading of nextHeadings) {
    await page.getByRole('button', { name: 'Suivant', exact: true }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Creer le patient' }).click();
  await page.waitForURL('**/patients');
}
