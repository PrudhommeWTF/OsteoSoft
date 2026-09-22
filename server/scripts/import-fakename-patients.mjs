// Generation de patients FICTIFS, entierement en local (aucun appel reseau).
//
// Remplace l'ancien import depuis randomuser.me, qui dependait d'un service tiers
// (contraire a la regle "aucun appel sortant vers un tiers") et etait absent du
// depot (le script npm seed:fakename pointait vers un fichier inexistant).
//
// Les noms, coordonnees et adresses sont tires de listes locales et combines au
// hasard : ce sont des donnees inventees, sans lien avec des personnes reelles.
// Ecrit directement dans server/data/osteo.db avec le meme chiffrement au repos
// (AES-256-GCM) que le reste de l'application.
//
// Usage : node server/scripts/import-fakename-patients.mjs [nombre] [--append]
//   nombre   : nombre de patients a generer (defaut 1500)
//   --append : ajoute sans supprimer les patients existants (defaut : remplace)

import crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

const DEFAULT_COUNT = 1500;

const args = process.argv.slice(2);
const countArg = Number(args.find((arg) => /^\d+$/.test(arg)) ?? DEFAULT_COUNT);
const targetCount = Number.isFinite(countArg) && countArg > 0 ? Math.floor(countArg) : DEFAULT_COUNT;
const appendMode = args.includes('--append');

const rawDataKey = process.env.OSTEOSOFT_DATA_KEY;
const dataKey = rawDataKey
  ? Buffer.from(rawDataKey, 'base64')
  : crypto.createHash('sha256').update('dev-only-data-key-change-me').digest();

if (dataKey.length !== 32) {
  throw new Error('OSTEOSOFT_DATA_KEY must decode to exactly 32 bytes (base64).');
}

const dbPath = path.resolve(process.cwd(), 'server/data/osteo.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ── Listes locales (donnees fictives) ────────────────────────────────────────

const FIRST_NAMES_F = [
  'Camille', 'Marie', 'Lea', 'Chloe', 'Manon', 'Sarah', 'Emma', 'Julie', 'Laura', 'Ines',
  'Louise', 'Alice', 'Clara', 'Anais', 'Elise', 'Juliette', 'Nadia', 'Sofia', 'Amelie', 'Celine',
  'Pauline', 'Oceane', 'Margaux', 'Charlotte', 'Lucie', 'Eva', 'Zoe', 'Aurore', 'Fanny', 'Sandra'
];

const FIRST_NAMES_M = [
  'Lucas', 'Hugo', 'Thomas', 'Nathan', 'Louis', 'Gabriel', 'Antoine', 'Maxime', 'Julien', 'Alexandre',
  'Paul', 'Enzo', 'Theo', 'Raphael', 'Adrien', 'Nicolas', 'Quentin', 'Romain', 'Clement', 'Mathis',
  'Baptiste', 'Florian', 'Kevin', 'Damien', 'Sebastien', 'Vincent', 'Guillaume', 'Simon', 'Yanis', 'Karim'
];

const LAST_NAMES = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau',
  'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier',
  'Morel', 'Girard', 'Andre', 'Mercier', 'Blanc', 'Guerin', 'Boyer', 'Garnier', 'Chevalier', 'Francois',
  'Legrand', 'Gauthier', 'Perrin', 'Robin', 'Clement', 'Morin', 'Nicolas', 'Henry', 'Roussel', 'Mathieu'
];

const CITIES = [
  { city: 'Nantes', postal: '44000' },
  { city: 'Rennes', postal: '35000' },
  { city: 'Angers', postal: '49000' },
  { city: 'Le Mans', postal: '72000' },
  { city: 'Tours', postal: '37000' },
  { city: 'Orleans', postal: '45000' },
  { city: 'Poitiers', postal: '86000' },
  { city: 'La Rochelle', postal: '17000' },
  { city: 'Vannes', postal: '56000' },
  { city: 'Laval', postal: '53000' }
];

const STREETS = [
  'rue des Lilas', 'avenue de la Gare', 'rue Victor Hugo', 'impasse des Ormes', 'place du Marche',
  'rue de la Republique', 'allee des Chenes', 'boulevard des Acacias', 'rue Jean Jaures', 'chemin des Vignes'
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function randomPhone() {
  // Mobile fictif : 06/07 suivi de 8 chiffres, format francais.
  const prefix = Math.random() < 0.5 ? '06' : '07';
  let rest = '';
  for (let i = 0; i < 4; i += 1) {
    rest += ` ${pad2(Math.floor(Math.random() * 100))}`;
  }
  return `${prefix}${rest}`;
}

function randomBirthDate() {
  // Adulte fictif : ne entre 1945 et 2007.
  const year = 1945 + Math.floor(Math.random() * 63);
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function randomDateBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const t = Math.floor(start + Math.random() * (end - start));
  return new Date(t).toISOString().slice(0, 10);
}

function encryptSensitiveField(plainText) {
  const text = String(plainText ?? '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function buildProfile() {
  const isFemale = Math.random() < 0.5;
  const firstName = pick(isFemale ? FIRST_NAMES_F : FIRST_NAMES_M);
  const lastName = pick(LAST_NAMES).toUpperCase();
  const fullName = `${lastName} ${firstName}`;
  const sex = isFemale ? 'F' : 'M';
  const phone = randomPhone();
  const place = pick(CITIES);
  const emailUser = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '');

  const medicalRecord = {
    generalRemarks: 'Donnees fictives generees localement (aucune donnee reelle).',
    medicalHistory: '',
    consultationNote: '',
    relatedPeople: '',
    mobilePhone: phone,
    landlinePhone: '',
    email: `${emailUser}@exemple.test`,
    address1: `${1 + Math.floor(Math.random() * 120)} ${pick(STREETS)}`,
    address2: '',
    postalCode: place.postal,
    city: place.city,
    country: 'France',
    maritalStatus: 'Non renseigne',
    childrenCount: 0,
    occupationOrSchool: '',
    hobbies: '',
    primaryDoctor: '',
    socialSecurityNumber: '',
    referredBy: '',
    manualPreference: 'Non renseigne',
    isDeceased: false
  };

  return {
    fullName,
    phone,
    sex,
    birthDate: randomBirthDate(),
    lastVisit: randomDateBetween('2025-01-01', '2026-04-15'),
    medicalRecord
  };
}

const insertPatient = db.prepare(
  `INSERT INTO patients
   (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, last_visit, consent_signed, retention_until)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertMany = db.transaction((profiles) => {
  for (const profile of profiles) {
    insertPatient.run(
      encryptSensitiveField(profile.fullName),
      encryptSensitiveField(profile.phone),
      encryptSensitiveField(JSON.stringify(profile.medicalRecord)),
      profile.sex,
      profile.birthDate,
      profile.lastVisit || null,
      1,
      '2036-12-31'
    );
  }
});

function deleteAllPatients() {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.prepare('DELETE FROM consultations WHERE patient_id IN (SELECT id FROM patients)').run();
    db.prepare('DELETE FROM appointments WHERE patient_id IN (SELECT id FROM patients)').run();
    db.prepare('DELETE FROM invoices WHERE patient_id IN (SELECT id FROM patients)').run();
    db.prepare('DELETE FROM patients').run();
    console.log('[seed] Patients existants et donnees liees supprimes.');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function run() {
  console.log('[seed] Source : generation locale (aucun appel reseau).');
  console.log(`[seed] Nombre cible : ${targetCount}`);
  console.log(`[seed] Mode : ${appendMode ? 'ajout' : 'remplacement'}`);

  if (!appendMode) {
    deleteAllPatients();
  }

  const profiles = [];
  const dedupe = new Set();
  // La cle inclut le telephone (aleatoire) : les collisions sont quasi nulles,
  // une petite garde evite malgre tout une boucle infinie theorique.
  let guard = 0;
  const maxAttempts = targetCount * 20;
  while (profiles.length < targetCount && guard < maxAttempts) {
    guard += 1;
    const profile = buildProfile();
    const key = `${profile.fullName}|${profile.birthDate}|${profile.phone}`;
    if (dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    profiles.push(profile);
  }

  if (profiles.length < targetCount) {
    throw new Error(`Impossible de generer ${targetCount} profils uniques (obtenu ${profiles.length}).`);
  }

  console.log(`[seed] Insertion de ${profiles.length} patients...`);
  insertMany(profiles);
  console.log(`[seed] ${profiles.length} patients fictifs inseres dans ${dbPath}`);
}

try {
  run();
} catch (error) {
  console.error('[seed] Echec :', error?.message ?? error);
  process.exitCode = 1;
} finally {
  db.close();
}
