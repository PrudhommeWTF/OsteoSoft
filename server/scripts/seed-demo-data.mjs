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

// Short motif labels used for reasonItems tags and appointment reasons
const MOTIFS = [
  'Lombalgie chronique', 'Cervicalgie aigue', 'Douleur epaule droite post-sport',
  'Cephalees de tension', 'Suivi post-natal', 'Tendinite rotulienne',
  'Douleur sacro-iliaque', 'Bilan global prevention', 'Dorso-lombalgie bureau',
  'Sciatique L5-S1', 'TMS poignet droit', 'Torticolis aigu',
  'Post-entorse cheville', 'Troubles digestifs fonctionnels', 'Preparation accouchement',
];

const PRATICIENS = ['Dr. Claire Martin', 'Dr. Antoine Rousseau', 'Admin'];

// Valid osteopath time slots (1 hour per session, pause dejeuner 12h-14h)
// Morning: 8h30, 9h30, 10h30, 11h30 | Afternoon: 14h00, 15h00, 16h00, 17h00
const OSTEO_SLOTS = [
  { hour: 8, min: 30 }, { hour: 9, min: 30 }, { hour: 10, min: 30 }, { hour: 11, min: 30 },
  { hour: 14, min: 0 }, { hour: 15, min: 0 }, { hour: 16, min: 0 }, { hour: 17, min: 0 },
];

// Multiple consultations per patient spread over past years
// Hours snap to realistic osteopath slots
const CONSULTATION_TEMPLATES = [
  { daysAgo: 730, hour: 9, min: 30, title: 'Premier bilan osteopathique' },
  { daysAgo: 490, hour: 10, min: 30, title: 'Suivi semestriel' },
  { daysAgo: 330, hour: 14, min: 0, title: 'Controle postural' },
  { daysAgo: 180, hour: 9, min: 30, title: 'Consultation douleur aigue' },
  { daysAgo: 90, hour: 15, min: 0, title: 'Bilan osteopathique annuel' },
  { daysAgo: 30, hour: 8, min: 30, title: 'Suivi trimestriel' },
  { daysAgo: 7, hour: 11, min: 30, title: 'Consultation de suivi recente' },
];

// Rich clinical content by consultation title keyword
const CLINICAL_CONTENT = {
  'Premier bilan': {
    tests: '<p>Bilan postural global en statique et en dynamique. Tests de mobilite rachidienne (flexion, extension, inclinaisons). Palpation des zones de tension primaires. Test de Lasegue negatif. Test de Romberg negatif.</p>',
    treatments: '<p>Traitement osteopathique global. Techniques structurelles sur le rachis lombaire. Normalisation articulaire des sacro-iliaques. Travail fascial sur le diaphragme et les fascias thoraco-lombaires.</p>',
    remarks: '<p>Revoir dans 6 semaines pour premier controle. Conseils posturaux au bureau remis. Exercices d\'auto-mobilisation prescrits : 5 minutes matin et soir.</p>'
  },
  'Suivi': {
    tests: '<p>Reevaluation des mobilites rachidiennes. Comparaison avec bilan initial. Palpation des zones traitees. Evaluation de la douleur : EVA avant/apres seance.</p>',
    treatments: '<p>Techniques de normalisation articulaire cervicale. Techniques myofasciales sur les chaines posterieures. Travail sur les fascias costaux et diaphragmatiques. Mobilisation douce des sacro-iliaques.</p>',
    remarks: '<p>Bonne evolution clinique. Douleurs en nette regression. Revoir dans 2 mois. Maintien des exercices prescrits.</p>'
  },
  'Controle': {
    tests: '<p>Reprise du bilan postural comparatif. Tests de mobilite segmentaire en charge. Evaluation de la symetrie pelvienne. Analyse des appuis plantaires.</p>',
    treatments: '<p>Techniques de regulation tensegritive globale. Ajustements articulaires mineurs. Travail global sur les fascias thoraco-lombaires et cervicaux.</p>',
    remarks: '<p>Progression satisfaisante. Maintien des acquis. Pas de recidive majeure. Prochain controle dans 6 mois.</p>'
  },
  'Bilan': {
    tests: '<p>Evaluation posturale globale (plan frontal et sagittal). Tests de mobilite par etages rachidiens. Analyse de la marche. Palpation du systeme cranio-sacre.</p>',
    treatments: '<p>Traitement osteopathique preventif. Harmonisation du systeme cranio-sacre. Liberation des restrictions fasciales mineures. Conseils ergonomiques et posturaux remis.</p>',
    remarks: '<p>Etat general satisfaisant. Prevention efficace. Revoir dans 6 mois pour controle annuel.</p>'
  },
  'douleur aigue': {
    tests: '<p>Evaluation de la douleur (EVA). Examen neurologique peripherique : non deficitaire. Palpation des structures en tension. Tests de provocation specifiques.</p>',
    treatments: '<p>Techniques douces en phase aigue. Methodes inhibitrices sur les muscles paravertebraux. Normalisation articulaire douce en fin d\'amplitude disponible. Glace recommandee 15 min toutes les 2h.</p>',
    remarks: '<p>Conseils de repos relatif 24-48h. Revoir dans 5 a 7 jours pour controle. Si aggravation ou apparition de signes neurologiques : consultation medicale urgente.</p>'
  },
};

function getClinicalContent(title) {
  const key = Object.keys(CLINICAL_CONTENT).find((k) => title.toLowerCase().includes(k.toLowerCase())) ?? 'Suivi';
  return CLINICAL_CONTENT[key];
}

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
  // Tous les creneaux respectent le rythme reel d'un cabinet d'osteopathie :
  // seances de 1h, matin 8h30/9h30/10h30/11h30, apres-midi 14h/15h/16h/17h, pas de RDV pendant la pause dejeuner.
  const apptSlots = [
    // passes (statut Termine) — 3-5 patients par jour, avec pause dejeuner
    { days: -7, hour: 9, min: 30 }, { days: -7, hour: 10, min: 30 }, { days: -7, hour: 14, min: 0 },
    { days: -6, hour: 8, min: 30 }, { days: -6, hour: 10, min: 30 }, { days: -6, hour: 14, min: 0 }, { days: -6, hour: 15, min: 0 },
    { days: -5, hour: 9, min: 30 }, { days: -5, hour: 11, min: 30 }, { days: -5, hour: 15, min: 0 }, { days: -5, hour: 16, min: 0 },
    { days: -4, hour: 8, min: 30 }, { days: -4, hour: 9, min: 30 }, { days: -4, hour: 14, min: 0 },
    { days: -3, hour: 9, min: 30 }, { days: -3, hour: 10, min: 30 }, { days: -3, hour: 11, min: 30 }, { days: -3, hour: 15, min: 0 },
    { days: -2, hour: 8, min: 30 }, { days: -2, hour: 10, min: 30 }, { days: -2, hour: 14, min: 0 }, { days: -2, hour: 16, min: 0 },
    { days: -1, hour: 9, min: 30 }, { days: -1, hour: 10, min: 30 }, { days: -1, hour: 11, min: 30 },
    // aujourd'hui
    { days: 0, hour: 8, min: 30 }, { days: 0, hour: 9, min: 30 }, { days: 0, hour: 10, min: 30 },
    { days: 0, hour: 14, min: 0 }, { days: 0, hour: 15, min: 0 },
    // a venir (semaine + 1 et + 2)
    { days: 1, hour: 9, min: 30 }, { days: 1, hour: 11, min: 30 }, { days: 1, hour: 14, min: 0 }, { days: 1, hour: 15, min: 0 },
    { days: 2, hour: 8, min: 30 }, { days: 2, hour: 10, min: 30 }, { days: 2, hour: 11, min: 30 },
    { days: 3, hour: 9, min: 30 }, { days: 3, hour: 14, min: 0 }, { days: 3, hour: 16, min: 0 },
    { days: 4, hour: 8, min: 30 }, { days: 4, hour: 9, min: 30 }, { days: 4, hour: 14, min: 0 },
    { days: 7, hour: 9, min: 30 }, { days: 7, hour: 10, min: 30 }, { days: 7, hour: 14, min: 0 }, { days: 7, hour: 15, min: 0 },
    { days: 8, hour: 8, min: 30 }, { days: 8, hour: 11, min: 30 }, { days: 8, hour: 16, min: 0 },
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

      const clinical = getClinicalContent(tmpl.title);
      const motifLabel = MOTIFS[(i + tIdx) % MOTIFS.length];
      const profiles = ['Adulte', 'Adulte', 'Adulte', 'Senior', 'Sportif', 'Perinatalite', 'Enfant'];
      const cRes = await apiRequest('POST', `/api/patients/${patient.id}/consultations`, {
        startedAt: isoDate(daysAgo, tmpl.hour, tmpl.min),
        officeId,
        practitioner: praticien,
        title: tmpl.title,
        important: tIdx === 0 && i % 4 === 0,
        heightCm: 158 + (i % 30),
        weightKg: 52 + (i % 38),
        evaBefore: 2 + ((i + tIdx) % 6),
        evaAfter: Math.max(0, ((i + tIdx) % 6) - 2),
        profile: profiles[i % profiles.length],
        reasonItems: [{ label: motifLabel, type: 'fonctionnel' }],
        motifMainHtml: `<p>${motifLabel}. ${clinical.tests.replace(/<[^>]+>/g, ' ').trim().split('.')[0]}.</p>`,
        testsHtml: clinical.tests,
        schemaHtml: '',
        treatmentsHtml: clinical.treatments,
        remarksHtml: clinical.remarks,
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

      const invNum = `${year}-DEMO${String(i + 1).padStart(3, '0')}T${String(tIdx + 1).padStart(2, '0')}`;
      const issuedAt = isoDate(daysAgo, tmpl.hour + 1, 0);
      const invStatus = invoiceStatusPool[(i * patientTemplates.length + tIdx) % invoiceStatusPool.length];
      const isInvoicePaid = invStatus === 'payee' || invStatus === 'partiellement_payee';
      const paymentMethod = isInvoicePaid
        ? paidPaymentMethods[(i + tIdx) % paidPaymentMethods.length]
        : '';
      const INVOICE_AMOUNT_CENTS = 6500;
      const partialPaymentCents = 3500;

      const payments = isInvoicePaid
        ? [{ paymentMethod, currency: 'EUR', amountCents: invStatus === 'partiellement_payee' ? partialPaymentCents : INVOICE_AMOUNT_CENTS, paidAt: issuedAt }]
        : [];

      const iRes = await apiRequest('POST', '/api/billing/invoices', {
        patientId: patient.id,
        consultationId,
        officeId,
        invoiceNumber: invNum,
        amountCents: INVOICE_AMOUNT_CENTS,
        status: invStatus,
        issuedAt,
        paymentMethod: isInvoicePaid ? paymentMethod : '',
        currency: 'EUR',
        payments,
      }, cookie);

      if (iRes.status === 201 || iRes.status === 200) {
        invoiceCount++;
        const invoiceId = JSON.parse(iRes.body)?.invoiceId;
        // Collect cheques for bank remittances
        if (isInvoicePaid && paymentMethod === 'cheque' && invoiceId) {
          chequesToDeposit.push({
            invoiceId,
            amountCents: invStatus === 'partiellement_payee' ? partialPaymentCents : INVOICE_AMOUNT_CENTS,
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
