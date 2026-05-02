/**
 * Seed demo data: appointments, consultations, invoices, bank deposits.
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
  'Suivi trimestriel',
  'Controle postural',
];

const PRATICIENS = ['Dr. Claire Martin', 'Dr. Antoine Rousseau', 'Admin'];

// Multiple consultations per patient spread over past years
const CONSULTATION_TEMPLATES = [
  { daysAgo: 730, hour: 9, min: 0, title: 'Premier bilan osteopathique' },
  { daysAgo: 490, hour: 11, min: 0, title: 'Suivi semestriel' },
  { daysAgo: 330, hour: 14, min: 30, title: 'Controle postural' },
  { daysAgo: 180, hour: 10, min: 0, title: 'Consultation douleur aigue' },
  { daysAgo: 90, hour: 15, min: 0, title: 'Bilan osteopathique annuel' },
  { daysAgo: 30, hour: 9, min: 30, title: 'Suivi trimestriel' },
  { daysAgo: 7, hour: 11, min: 30, title: 'Consultation de suivi recente' },
];

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
  // Each patient gets multiple consultations spread over past years
  const toConsult = patients.slice(0, 20);
  const year = new Date().getFullYear();

  // Payment methods weighted to be realistic (more CB, some cheque, some especes)
  const paidPaymentMethods = ['carte', 'carte', 'carte', 'especes', 'especes', 'cheque', 'virement'];
  // Realistic invoice statuses: mostly paid, some unpaid/partial/cancelled
  const invoiceStatusPool = [
    'payee', 'payee', 'payee', 'payee', 'payee', 'payee', 'payee', 'payee', // 8/13 = ~62%
    'impayee', 'impayee',                                                     // 2/13 = ~15%
    'partiellement_payee',                                                    // 1/13 = ~8%
    'annulee', 'annulee',                                                     // 2/13 = ~15%
  ];

  // Collect cheque payments for bank remittances
  const chequesToDeposit = []; // { invoiceId, amountCents, issuedAt }

  for (let i = 0; i < toConsult.length; i++) {
    const patient = toConsult[i];
    const officeId = (i % 2 === 0) ? 1 : 2;
    const praticien = PRATICIENS[i % 2]; // claire ou antoine

    // Determine how many consultations this patient gets (varied, not always all templates)
    const patientTemplates = i % 5 === 0
      ? CONSULTATION_TEMPLATES.slice(-2)  // new patient: last 2 (recent only)
      : i % 3 === 0
        ? CONSULTATION_TEMPLATES          // chronic patient: all 7
        : CONSULTATION_TEMPLATES.slice(2); // regular patient: last 5

    for (let tIdx = 0; tIdx < patientTemplates.length; tIdx++) {
      const tmpl = patientTemplates[tIdx];
      const daysAgo = -(tmpl.daysAgo + (i * 2)); // small offset per patient to avoid duplicate dates

      const cRes = await apiRequest('POST', `/api/patients/${patient.id}/consultations`, {
        startedAt: isoDate(daysAgo, tmpl.hour, tmpl.min),
        officeId,
        practitioner: praticien,
        title: tmpl.title,
        important: tIdx === 0 && i % 4 === 0,
        heightCm: 165 + (i % 20),
        weightKg: 60 + (i % 30),
        evaBefore: 1 + ((i + tIdx) % 7),
        evaAfter: Math.max(0, ((i + tIdx) % 7) - 2),
        profile: i % 5 === 0 ? 'Pediatrique' : 'Adulte',
        reasonItems: [{ label: MOTIFS[(i + tIdx) % MOTIFS.length], type: 'fonctionnel' }],
        motifMainHtml: `<p>${MOTIFS[(i + tIdx) % MOTIFS.length]}</p>`,
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
        continue;
      }

      const invNum = `${year}-DEMO${String(i + 1).padStart(3, '0')}-${String(tIdx + 1).padStart(2, '0')}`;
      const issuedAt = isoDate(daysAgo, tmpl.hour + 1, 0);
      const invStatus = invoiceStatusPool[(i * patientTemplates.length + tIdx) % invoiceStatusPool.length];
      const paymentMethod = invStatus === 'payee' || invStatus === 'partiellement_payee'
        ? paidPaymentMethods[(i + tIdx) % paidPaymentMethods.length]
        : 'cheque';

      const payments = (invStatus === 'payee' || invStatus === 'partiellement_payee')
        ? [{ paymentMethod, currency: 'EUR', amountCents: invStatus === 'partiellement_payee' ? 3500 : 6500, paidAt: issuedAt }]
        : [];

      const iRes = await apiRequest('POST', '/api/billing/invoices', {
        patientId: patient.id,
        consultationId,
        officeId,
        invoiceNumber: invNum,
        amountCents: 6500,
        status: invStatus,
        issuedAt,
        paymentMethod: invStatus === 'payee' || invStatus === 'partiellement_payee' ? paymentMethod : '',
        currency: 'EUR',
        payments,
      }, cookie);

      if (iRes.status === 201 || iRes.status === 200) {
        invoiceCount++;
        const invoiceId = JSON.parse(iRes.body)?.invoiceId;
        // Collect cheques for bank remittances
        if ((invStatus === 'payee' || invStatus === 'partiellement_payee') && paymentMethod === 'cheque' && invoiceId) {
          chequesToDeposit.push({
            invoiceId,
            amountCents: invStatus === 'partiellement_payee' ? 3500 : 6500,
            issuedAt: issuedAt.slice(0, 10),
          });
        }
      } else {
        console.warn(`[seed:demo] Facture echec (${iRes.status}): ${iRes.body.slice(0, 120)}`);
      }
    }
  }

  console.log(`[seed:demo] ${consultationCount} consultations creees`);
  console.log(`[seed:demo] ${invoiceCount} factures creees`);

  // --- REMISES DE CHEQUES (bank deposits) ---
  // Group cheques by calendar week and create one deposit per week per office
  let depositCount = 0;
  if (chequesToDeposit.length > 0) {
    // Group by week
    const weekGroups = new Map();
    for (const c of chequesToDeposit) {
      const d = new Date(c.issuedAt);
      const daysToMonday = (d.getDay() + 6) % 7;
      const monday = new Date(d.getTime() - (daysToMonday * 24 * 60 * 60 * 1000));
      const key = monday.toISOString().slice(0, 10);
      if (!weekGroups.has(key)) {
        weekGroups.set(key, []);
      }
      weekGroups.get(key).push(c);
    }

    for (const [weekStart, items] of weekGroups.entries()) {
      const totalCents = items.reduce((s, c) => s + c.amountCents, 0);
      const dRes = await apiRequest('POST', '/api/billing/deposits', {
        occurredAt: `${weekStart}T10:00:00.000Z`,
        type: 'cheque',
        officeId: 1,
        amount: totalCents / 100,
        currency: 'EUR',
        operationIds: items.map((c) => `invoice-${c.invoiceId}`),
      }, cookie);
      if (dRes.status === 201 || dRes.status === 200) {
        depositCount++;
      } else {
        console.warn(`[seed:demo] Remise echec (${dRes.status}): ${dRes.body.slice(0, 120)}`);
      }
    }
  }

  console.log(`[seed:demo] ${depositCount} remises de banque creees`);
  console.log('[seed:demo] Termine.');
}

main().catch((e) => { console.error(e); process.exit(1); });
