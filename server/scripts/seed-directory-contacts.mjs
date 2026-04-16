import path from 'node:path';

import Database from 'better-sqlite3';

const DEFAULT_COUNT = 250;
const args = process.argv.slice(2);

const countArg = args.find((arg) => /^\d+$/.test(arg));
const targetCount = countArg ? Number(countArg) : DEFAULT_COUNT;
const shouldReplace = args.includes('--replace');

if (!Number.isInteger(targetCount) || targetCount <= 0) {
  throw new Error('Le nombre de contacts doit etre un entier positif. Exemple: node server/scripts/seed-directory-contacts.mjs 300');
}

const dbPath = path.resolve(process.cwd(), 'server/data/osteo.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const firstNames = [
  'Camille', 'Theo', 'Lucie', 'Nathan', 'Emma', 'Louis', 'Chloe', 'Hugo', 'Sarah', 'Jules',
  'Lea', 'Noah', 'Manon', 'Luca', 'Ines', 'Raphael', 'Nina', 'Arthur', 'Elsa', 'Tom'
];

const lastNames = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau',
  'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier'
];

const cities = [
  { city: 'Paris', postalCode: '75011' },
  { city: 'Lyon', postalCode: '69003' },
  { city: 'Marseille', postalCode: '13006' },
  { city: 'Toulouse', postalCode: '31000' },
  { city: 'Nantes', postalCode: '44000' },
  { city: 'Lille', postalCode: '59800' },
  { city: 'Bordeaux', postalCode: '33000' },
  { city: 'Strasbourg', postalCode: '67000' },
  { city: 'Rennes', postalCode: '35000' },
  { city: 'Montpellier', postalCode: '34000' }
];

const streets = [
  'rue de la Republique', 'avenue Jean Jaures', 'rue Victor Hugo', 'boulevard Voltaire', 'rue Nationale',
  'rue Pasteur', 'avenue de la Gare', 'rue des Ecoles', 'boulevard de la Liberte', 'rue du Commerce'
];

const personRoles = [
  'Kinesitherapeute', 'Orthophoniste', 'Sage-femme', 'Psychologue', 'Generaliste',
  'Infirmier liberal', 'Podologue', 'Orthoptiste', 'Pediatre', 'Dermatologue'
];

const companyKinds = [
  'Cabinet', 'Clinique', 'Centre Medical', 'Maison de Sante', 'Laboratoire', 'Association'
];

const domains = ['example.fr', 'test-med.fr', 'demo-cabinet.fr'];

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 40);
}

function randomPhone(prefix = '06') {
  const digits = `${prefix}${String(randomInt(0, 99999999)).padStart(8, '0')}`;
  return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)}`;
}

function buildPersonContact() {
  const firstName = pick(firstNames);
  const lastName = pick(lastNames);
  const cityItem = pick(cities);
  const role = pick(personRoles);
  const street = `${randomInt(1, 220)} ${pick(streets)}`;
  const email = `${slugify(`${firstName}.${lastName}`)}@${pick(domains)}`;

  return {
    kind: 'person',
    firstName,
    lastName,
    organization: '',
    role,
    email,
    mobilePhone: randomPhone('06'),
    landlinePhone: randomPhone('01'),
    address1: street,
    address2: randomInt(0, 4) === 0 ? `Batiment ${String.fromCharCode(65 + randomInt(0, 4))}` : '',
    postalCode: cityItem.postalCode,
    city: cityItem.city,
    country: 'France',
    notes: randomInt(0, 5) === 0 ? 'Contact de test genere automatiquement.' : '',
    isActive: randomInt(0, 9) !== 0
  };
}

function buildCompanyContact() {
  const cityItem = pick(cities);
  const base = pick(lastNames);
  const organization = `${pick(companyKinds)} ${base}`;
  const email = `${slugify(organization)}@${pick(domains)}`;

  return {
    kind: 'company',
    firstName: '',
    lastName: '',
    organization,
    role: 'Structure partenaire',
    email,
    mobilePhone: randomPhone('07'),
    landlinePhone: randomPhone('01'),
    address1: `${randomInt(1, 180)} ${pick(streets)}`,
    address2: '',
    postalCode: cityItem.postalCode,
    city: cityItem.city,
    country: 'France',
    notes: randomInt(0, 3) === 0 ? 'Societe de test generee automatiquement.' : '',
    isActive: randomInt(0, 14) !== 0
  };
}

function run() {
  const offices = db
    .prepare('SELECT id, name FROM offices WHERE is_active = 1 ORDER BY display_order ASC, id ASC')
    .all();

  if (offices.length === 0) {
    throw new Error('Aucun cabinet actif trouve. Cree au moins un cabinet avant de lancer le seed repertoire.');
  }

  const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const actorId = firstUser ? Number(firstUser.id) : null;

  const insertContact = db.prepare(
    `INSERT INTO directory_contacts (
       office_id, kind, first_name, last_name, organization, role,
       email, mobile_phone, landline_phone,
       address_line1, address_line2, postal_code, city, country,
       notes, is_active, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const countBefore = Number(db.prepare('SELECT COUNT(*) AS c FROM directory_contacts').get().c ?? 0);

  const transaction = db.transaction(() => {
    if (shouldReplace) {
      db.prepare('DELETE FROM directory_contacts').run();
    }

    for (let i = 0; i < targetCount; i += 1) {
      const office = pick(offices);
      const payload = Math.random() < 0.22 ? buildCompanyContact() : buildPersonContact();

      insertContact.run(
        office.id,
        payload.kind,
        payload.firstName,
        payload.lastName,
        payload.organization,
        payload.role,
        payload.email,
        payload.mobilePhone,
        payload.landlinePhone,
        payload.address1,
        payload.address2,
        payload.postalCode,
        payload.city,
        payload.country,
        payload.notes,
        payload.isActive ? 1 : 0,
        actorId,
        actorId
      );
    }
  });

  transaction();

  const countAfter = Number(db.prepare('SELECT COUNT(*) AS c FROM directory_contacts').get().c ?? 0);
  const byOffice = db
    .prepare(
      `SELECT o.name AS officeName, COUNT(dc.id) AS total
       FROM directory_contacts dc
       INNER JOIN offices o ON o.id = dc.office_id
       GROUP BY o.name
       ORDER BY o.name ASC`
    )
    .all();

  console.log(`[seed:directory] Database: ${dbPath}`);
  console.log(`[seed:directory] Mode: ${shouldReplace ? 'replace' : 'append'}`);
  console.log(`[seed:directory] Count before: ${countBefore}`);
  console.log(`[seed:directory] Inserted: ${targetCount}`);
  console.log(`[seed:directory] Count after: ${countAfter}`);

  for (const row of byOffice) {
    console.log(`  - ${row.officeName}: ${row.total}`);
  }
}

try {
  run();
} catch (error) {
  console.error('[seed:directory] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  db.close();
}
