// Scenario end-to-end HTTP : controle d'acces par role.
//
// Verifie qu'un utilisateur non authentifie est refuse, que l'administrateur a
// acces, et que des profils restreints (cabinet-member, assistant, comptabilite)
// obtiennent exactement les droits attendus (200 quand autorise, 403 sinon).
// Utilise le harnais de test (instance reelle, base SQLite temporaire et isolee).

import { startTestServer, setupCleanInstance, createClient, createUser } from '../test/helpers/harness.mjs';
import { createScenario } from './e2e-lib.mjs';

const PASSWORD = 'Str0ng!Passw0rd';

async function main() {
  const { check, section, finish } = createScenario('E2E droits');
  const server = await startTestServer();
  try {
    const { client: admin } = await setupCleanInstance(server.baseUrl);

    // Profils par defaut semes a l'installation. Droits GLOBAUX (aucun cabinet
    // delegue), pour tester la grille de permissions de chaque profil.
    await createUser(admin, { username: 'e2e-cabinet-member', password: PASSWORD, profileId: 'cabinet-member' });
    await createUser(admin, { username: 'e2e-assistant', password: PASSWORD, profileId: 'assistant' });
    await createUser(admin, { username: 'e2e-comptabilite', password: PASSWORD, profileId: 'comptabilite' });

    const anon = createClient(server.baseUrl);
    const cabinetMember = createClient(server.baseUrl);
    const assistant = createClient(server.baseUrl);
    const comptabilite = createClient(server.baseUrl);
    await cabinetMember.login('e2e-cabinet-member', PASSWORD);
    await assistant.login('e2e-assistant', PASSWORD);
    await comptabilite.login('e2e-comptabilite', PASSWORD);

    section('Non authentifie : tout est refuse (401)');
    check('GET /api/patients', (await anon.get('/api/patients')).status === 401);
    check('GET /api/offices', (await anon.get('/api/offices')).status === 401);
    check('POST /api/billing/invoices', (await anon.post('/api/billing/invoices', {})).status === 401);

    section('Administrateur : acces complet');
    check('GET /api/patients (200)', (await admin.get('/api/patients')).status === 200);
    check('GET /api/offices (200)', (await admin.get('/api/offices')).status === 200);
    // Corps manquant : 400 (et non 403) prouve que la verification de droit passe.
    check('POST /api/billing/invoices corps vide (400)', (await admin.post('/api/billing/invoices', {})).status === 400);

    section('cabinet-member : aucun droit global (403)');
    check('GET /api/patients', (await cabinetMember.get('/api/patients')).status === 403);
    check('GET /api/offices', (await cabinetMember.get('/api/offices')).status === 403);
    check('POST /api/billing/invoices', (await cabinetMember.post('/api/billing/invoices', {})).status === 403);

    section('assistant : acces partiel');
    check('GET /api/patients autorise (200)', (await assistant.get('/api/patients')).status === 200);
    check('GET /api/offices refuse (403)', (await assistant.get('/api/offices')).status === 403);
    check('POST /api/billing/invoices refuse (403)', (await assistant.post('/api/billing/invoices', {})).status === 403);

    section('comptabilite : droits de facturation, pas de parametres cabinet');
    check('GET /api/patients autorise (200)', (await comptabilite.get('/api/patients')).status === 200);
    // Droit de facturation present : corps vide donne 400 (et non 403).
    check('POST /api/billing/invoices corps vide (400)', (await comptabilite.post('/api/billing/invoices', {})).status === 400);
    check('GET /api/offices refuse (403)', (await comptabilite.get('/api/offices')).status === 403);
  } finally {
    await server.stop();
  }
  finish();
}

main().catch((err) => {
  console.error('[E2E droits] Erreur inattendue :', err?.message ?? err);
  process.exitCode = 1;
});
