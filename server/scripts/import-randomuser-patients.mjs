import crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

const SOURCE_URL = 'https://randomuser.me/api/?nat=fr&results=';
const DEFAULT_COUNT = 1500;
const RESULTS_PER_REQUEST = 500; // API limit
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;

const countArg = Number(process.argv[2] ?? DEFAULT_COUNT);
const targetCount = Number.isFinite(countArg) && countArg > 0 ? Math.floor(countArg) : DEFAULT_COUNT;

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

db.exec('BEGIN');
db.exec('COMMIT');

function encryptSensitiveField(plainText) {
  const text = String(plainText ?? '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function normalizePhone(rawPhone) {
  if (!rawPhone) return 'Non renseigne';
  const digits = rawPhone.replace(/\D+/g, '');
  if (!digits) return 'Non renseigne';
  if (digits.length === 10) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)}`;
  }
  return rawPhone.replace(/\s+/g, ' ').trim();
}

function parseBirthday(isoDate) {
  try {
    const parsed = new Date(isoDate);
    if (Number.isNaN(parsed.getTime())) return '';
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  } catch {
    return '';
  }
}

function randomDateBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const t = Math.floor(start + Math.random() * (end - start));
  return new Date(t).toISOString().slice(0, 10);
}

function mapSexFromGender(gender) {
  if (gender === 'male') return 'M';
  if (gender === 'female') return 'F';
  return 'Non renseigne';
}

function parseRandomUserProfile(user) {
  const firstName = user.name?.first || 'Prenom';
  const lastName = (user.name?.last || 'Nom').toUpperCase();
  const fullName = `${lastName} ${firstName}`.trim();
  
  const phone = normalizePhone(user.cell || user.phone || '');
  const sex = mapSexFromGender(user.gender);
  const birthDate = parseBirthday(user.dob?.date);
  const email = (user.email || '').toLowerCase();
  
  const medicalRecord = {
    generalRemarks: 'Donnees de test generees via randomuser.me',
    medicalHistory: '',
    consultationNote: '',
    relatedPeople: '',
    email,
    address1: user.location?.street?.name || '',
    address2: `${user.location?.street?.number || ''} ${user.location?.postcode || ''}`.trim(),
    postalCode: String(user.location?.postcode || ''),
    city: user.location?.city || 'France',
    country: user.location?.country || 'France',
    recordAccess: 'Non renseigne',
    isDeceased: false
  };

  return {
    fullName,
    phone,
    sex,
    birthDate: birthDate || null,
    lastVisit: randomDateBetween('2025-01-01', '2026-04-15'),
    medicalRecord
  };
}

async function fetchProfilesBatch(batchSize, retryCount = 0) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    
    const url = `${SOURCE_URL}${batchSize}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Node.js) OsteoSoft/1.0'
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      const delayMs = (retryCount + 1) * 500 + Math.floor(Math.random() * 300);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return fetchProfilesBatch(batchSize, retryCount + 1);
    }
    throw error;
  }
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

async function deleteAllPatients() {
  try {
    // Disable foreign key constraints temporarily
    db.exec('PRAGMA foreign_keys = OFF');
    
    // Delete all related data first (following foreign key dependencies)
    const deleteConsultations = db.prepare('DELETE FROM consultations WHERE patient_id IN (SELECT id FROM patients)');
    const deleteAppointments = db.prepare('DELETE FROM appointments WHERE patient_id IN (SELECT id FROM patients)');
    const deleteInvoices = db.prepare('DELETE FROM invoices WHERE patient_id IN (SELECT id FROM patients)');
    const deletePatients = db.prepare('DELETE FROM patients');
    
    deleteConsultations.run();
    deleteAppointments.run();
    deleteInvoices.run();
    deletePatients.run();
    
    // Re-enable foreign key constraints
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[seed] All existing patients and related data deleted');
  } catch (error) {
    db.exec('PRAGMA foreign_keys = ON');
    throw error;
  }
}

async function run() {
  console.log(`[seed] Source: ${SOURCE_URL}`);
  console.log(`[seed] Target count: ${targetCount}`);

  // Delete all existing patients
  console.log('[seed] Deleting all existing patients...');
  await deleteAllPatients();

  const profiles = [];
  const dedupe = new Set();
  const batches = Math.ceil(targetCount / RESULTS_PER_REQUEST);
  
  for (let batch = 0; batch < batches && profiles.length < targetCount; batch += 1) {
    const remaining = targetCount - profiles.length;
    const batchSize = Math.min(RESULTS_PER_REQUEST, remaining);
    
    try {
      console.log(`[seed] Fetching batch ${batch + 1}/${batches} (${batchSize} results)...`);
      const results = await fetchProfilesBatch(batchSize);
      
      for (const user of results) {
        const profile = parseRandomUserProfile(user);
        const key = `${profile.fullName}|${profile.birthDate}|${profile.phone}`;
        
        if (dedupe.has(key)) {
          continue;
        }
        
        dedupe.add(key);
        profiles.push(profile);
      }
      
      console.log(`[seed] Progress: ${profiles.length}/${targetCount} uniques`);
      
      // Add delay between requests to be respectful
      if (batch < batches - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`[seed] Error fetching batch ${batch + 1}: ${error.message}`);
      throw error;
    }
  }

  if (profiles.length < targetCount) {
    throw new Error(
      `Unable to collect ${targetCount} unique profiles from source (got ${profiles.length})`
    );
  }

  console.log(`[seed] Inserting ${profiles.length} patients...`);
  insertMany(profiles);

  console.log(`[seed] Successfully inserted ${profiles.length} patients in ${dbPath}`);
}

run()
  .catch((error) => {
    console.error('[seed] Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
