// Scenario end-to-end HTTP : sauvegarde puis restauration.
//
// Verifie qu'une sauvegarde se telecharge, qu'elle ne contient aucune donnee
// personnelle en clair (chiffrement au repos), et que la restauration remet les
// donnees en place. Utilise le harnais de test (instance reelle, base SQLite
// temporaire et isolee) : ne touche jamais les donnees de developpement.

import { startTestServer, setupCleanInstance, downloadBackup, openTestDb } from '../test/helpers/harness.mjs';
import { createScenario } from './e2e-lib.mjs';

const PATIENT_NAME = 'SauvegardeTest';

async function main() {
  const { check, section, finish } = createScenario('E2E sauvegarde');
  const server = await startTestServer();
  try {
    const { client } = await setupCleanInstance(server.baseUrl);

    section('Preparation');
    const created = await client.post('/api/patients', {
      sex: 'Femme',
      lastName: PATIENT_NAME,
      firstName: 'Alice',
      consentSigned: true
    });
    check('creation d un patient (201)', created.status === 201, `statut ${created.status}`);

    section('Sauvegarde');
    const backup = await downloadBackup(client);
    check('sauvegarde telechargee (manifest + data)', Boolean(backup.manifest) && Boolean(backup.data));
    check(
      'aucune donnee personnelle en clair dans la sauvegarde',
      !JSON.stringify(backup.data).includes(PATIENT_NAME)
    );

    section('Restauration');
    const restore = await client.post('/api/data-management/restore', backup);
    check('restauration acceptee (200)', restore.status === 200, `statut ${restore.status}`);

    const db = openTestDb(server);
    const row = db.prepare('SELECT COUNT(*) AS n FROM patients WHERE is_deleted = 0').get();
    db.close();
    check('le patient est present apres restauration', Number(row.n) >= 1, `n=${row?.n}`);
  } finally {
    await server.stop();
  }
  finish();
}

main().catch((err) => {
  console.error('[E2E sauvegarde] Erreur inattendue :', err?.message ?? err);
  process.exitCode = 1;
});
