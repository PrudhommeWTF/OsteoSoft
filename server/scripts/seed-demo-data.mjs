/**
 * Seed demo data: appointments, consultations, invoices.
 * Usage: node server/scripts/seed-demo-data.mjs
 */
import http from 'http';

const BASE = { hostname: 'localhost', port: 3000 };

function apiRequest(method, path, data, cookie) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : '';
    const opts = {
      ...BASE, path, method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body || ''),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => resolve({ status: res.statusCode, body: out, cookie: res.headers['set-cookie'] }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function isoDate(daysFromNow, hour = 10, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const MOTIFS = [
  'Suivi lombalgie chronique',
  'Cervicalgie aigue - premier bilan',
  'Douleur epaule droite post-sport',
  'Cephalees de tension recurrentes',
  'Suivi post-natal J45',
  'Tendinite rotulienne',
  'Douleur sacro-iliaque',
  'Consultation bilan global',
  'Dorso-lombalgie - suivi',
  'Sciatique L5-S1',
  'Douleur poignet droit',
  'Torticolis aigu',
];

const TITRES_CONSULTATION = [
  'Premiere consultation',
  'Consultation de suivi',
  'Bilan osteopathique complet',
  'Seance de traitement',
  'Consultation urgente',
];

const PRATICIENS = ['Dr. Claire Martin', 'Dr. Antoine Rousseau', 'Admin'];

async function main() {
  console.log('[seed:demo] Connexion...');
  const login = await apiRequest('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  const cookie = login.cookie?.[0]?.split(';')[0];
  if (!cookie) {
    console.error('[seed:demo] Echec connexion');
    process.exit(1);
  }
  console.log('[seed:demo] Connecte');

  // Fetch patients
  const pRes = await apiRequest('GET', '/api/patients?limit=30&sortBy=id&sortDir=asc', null, cookie);
  const { patients } = JSON.parse(pRes.body);
  if (!patients?.length) {
    console.error('[seed:demo] Aucun patient - lance import-randomuser-patients.mjs 40 d\'abord');
    process.exit(1);
  }
  console.log(`[seed:demo] ${patients.length} patients disponibles`);

  let appointmentCount = 0;
  let consultationCount = 0;
  let invoiceCount = 0;

  // --- RENDEZ-VOUS : semaine passee + semaine en cours + semaine suivante ---
  const apptSlots = [
    // passes (statut Termine)
    { days: -7, hour: 9, min: 0 }, { days: -7, hour: 10, min: 0 }, { days: -7, hour: 11, min: 0 },
    { days: -6, hour: 9, min: 0 }, { days: -6, hour: 14, min: 0 }, { days: -6, hour: 15, min: 0 },
    { days: -5, hour: 9, min: 30 }, { days: -5, hour: 11, min: 0 }, { days: -5, hour: 16, min: 0 },
    { days: -4, hour: 8, min: 0 }, { days: -4, hour: 10, min: 0 }, { days: -4, hour: 14, min: 30 },
    { days: -3, hour: 9, min: 0 }, { days: -3, hour: 10, min: 30 }, { days: -3, hour: 15, min: 0 },
    { days: -2, hour: 9, min: 0 }, { days: -2, hour: 11, min: 0 }, { days: -2, hour: 14, min: 0 },
    { days: -1, hour: 9, min: 0 }, { days: -1, hour: 10, min: 0 }, { days: -1, hour: 11, min: 30 },
    // aujourd'hui
    { days: 0, hour: 9, min: 0 }, { days: 0, hour: 10, min: 0 }, { days: 0, hour: 11, min: 0 },
    { days: 0, hour: 14, min: 0 }, { days: 0, hour: 15, min: 0 },
    // a venir
    { days: 1, hour: 9, min: 0 }, { days: 1, hour: 10, min: 30 }, { days: 1, hour: 14, min: 0 },
    { days: 2, hour: 9, min: 0 }, { days: 2, hour: 10, min: 0 }, { days: 2, hour: 11, min: 0 },
    { days: 3, hour: 9, min: 30 }, { days: 3, hour: 14, min: 0 }, { days: 3, hour: 15, min: 30 },
    { days: 4, hour: 9, min: 0 }, { days: 4, hour: 10, min: 0 },
    { days: 7, hour: 9, min: 0 }, { days: 7, hour: 10, min: 0 }, { days: 7, hour: 14, min: 0 },
    { days: 8, hour: 9, min: 30 }, { days: 8, hour: 11, min: 0 },
  ];

  for (let i = 0; i < apptSlots.length; i++) {
    const slot = apptSlots[i];
    const patient = patients[i % patients.length];
    const status = slot.days < 0 ? 'Termine' : slot.days === 0 ? 'A confirmer' : 'En attente';
    const motif = MOTIFS[i % MOTIFS.length];
    const praticien = PRATICIENS[i % PRATICIENS.length];
    const officeId = (i % 2 === 0) ? 1 : 2;

    const res = await apiRequest('POST', '/api/appointments', {
      patientId: patient.id,
      patientFirstName: patient.fullName?.split(' ')[1] ?? '',
      patientLastName: patient.fullName?.split(' ')[0] ?? '',
      startsAt: isoDate(slot.days, slot.hour, slot.min),
      reason: motif,
      status,
      practitioner: praticien,
      officeId,
      isPrivate: false,
    }, cookie);

    if (res.status === 201 || res.status === 200) {
      appointmentCount++;
    } else {
      console.warn(`[seed:demo] RDV echec (${res.status}): ${res.body.slice(0, 100)}`);
    }
  }
  console.log(`[seed:demo] ${appointmentCount} rendez-vous crees`);

  // --- CONSULTATIONS + FACTURES pour les 20 premiers patients ---
  const toConsult = patients.slice(0, 20);
  for (let i = 0; i < toConsult.length; i++) {
    const patient = toConsult[i];
    const officeId = (i % 2 === 0) ? 1 : 2;
    const praticien = PRATICIENS[i % 2]; // claire ou antoine
    const daysAgo = -(i * 3 + 1); // entre 1 et 60 jours passes

    // Consultation
    const cRes = await apiRequest('POST', `/api/patients/${patient.id}/consultations`, {
      startedAt: isoDate(daysAgo, 10, 0),
      officeId,
      practitioner: praticien,
      title: TITRES_CONSULTATION[i % TITRES_CONSULTATION.length],
      important: i % 7 === 0,
      heightCm: 165 + (i % 20),
      weightKg: 60 + (i % 30),
      evaBefore: 1 + (i % 7),
      evaAfter: Math.max(0, (i % 7) - 2),
      profile: i % 5 === 0 ? 'Pediatrique' : 'Adulte',
      reasonItems: [{ label: MOTIFS[i % MOTIFS.length], type: 'fonctionnel' }],
      motifMainHtml: `<p>${MOTIFS[i % MOTIFS.length]}</p>`,
      testsHtml: '<p>Tests osteopathiques realises.</p>',
      schemaHtml: '',
      treatmentsHtml: '<p>Traitement osteopathique global.</p>',
      remarksHtml: '<p>Revoir dans 3 semaines.</p>',
      consultationDocuments: [],
    }, cookie);

    let consultationId = null;
    if (cRes.status === 201) {
      consultationCount++;
      consultationId = JSON.parse(cRes.body)?.consultation?.id ?? null;
    } else {
      console.warn(`[seed:demo] Consultation echec patient ${patient.id} (${cRes.status}): ${cRes.body.slice(0, 100)}`);
    }

    // Facture associee (60 EUR)
    const year = new Date().getFullYear();
    const invNum = `${year}-DEMO${String(i + 1).padStart(4, '0')}`;
    const issuedAt = isoDate(daysAgo, 11, 0);
    const paymentMethods = ['especes', 'carte', 'virement', 'especes'];
    const paymentMethod = paymentMethods[i % paymentMethods.length];
    const statuses = ['payee', 'payee', 'payee', 'en attente', 'en attente', 'annulee'];
    const invStatus = statuses[i % statuses.length];

    const payments = invStatus === 'payee'
      ? [{ paymentMethod, currency: 'EUR', amountCents: 6000, paidAt: issuedAt }]
      : [];

    const iRes = await apiRequest('POST', '/api/billing/invoices', {
      patientId: patient.id,
      consultationId,
      officeId,
      invoiceNumber: invNum,
      amountCents: 6000,
      status: invStatus,
      issuedAt,
      paymentMethod: invStatus === 'payee' ? paymentMethod : '',
      currency: 'EUR',
      payments,
    }, cookie);

    if (iRes.status === 201 || iRes.status === 200) {
      invoiceCount++;
    } else {
      console.warn(`[seed:demo] Facture echec (${iRes.status}): ${iRes.body.slice(0, 120)}`);
    }
  }

  console.log(`[seed:demo] ${consultationCount} consultations creees`);
  console.log(`[seed:demo] ${invoiceCount} factures creees`);
  console.log('[seed:demo] Termine.');
}

main().catch((e) => { console.error(e); process.exit(1); });
