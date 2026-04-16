import crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

const SOURCE_URL = 'https://www.fakenamegenerator.com/gen-random-fr-fr.php';
const DEFAULT_COUNT = 15;
const DEFAULT_CONCURRENCY = 6;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 12000;

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

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&eacute;/g, 'e')
    .replace(/&egrave;/g, 'e')
    .replace(/&ecirc;/g, 'e')
    .replace(/&agrave;/g, 'a')
    .replace(/&ccedil;/g, 'c')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(text) {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseBirthday(raw) {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function randomDateBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const t = Math.floor(start + Math.random() * (end - start));
  return new Date(t).toISOString().slice(0, 10);
}

function normalizePhone(rawPhone) {
  const digits = rawPhone.replace(/\D+/g, '');
  if (!digits) return 'Non renseigne';
  if (digits.length === 10) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)}`;
  }
  return rawPhone.replace(/\s+/g, ' ').trim();
}

function parseProfile(html) {
  const nameMatch = html.match(/<div class="address">[\s\S]*?<h3>([^<]+)<\/h3>/i);
  const phoneMatch = html.match(/<dt>\s*Phone\s*<\/dt>\s*<dd>([^<]+)<\/dd>/i);
  const birthdayMatch = html.match(/<dt>\s*Birthday\s*<\/dt>\s*<dd>([^<]+)<\/dd>/i);
  const emailMatch = html.match(/<dt>\s*Email Address\s*<\/dt>[\s\S]*?<dd>([^<\s]+)/i);

  if (!nameMatch || !phoneMatch || !birthdayMatch) {
    throw new Error('Unable to parse fake profile from source HTML');
  }

  const displayName = stripTags(nameMatch[1]);
  const nameParts = displayName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? 'Prenom';
  const lastNameRaw = nameParts.slice(1).join(' ') || 'Nom';
  const lastName = lastNameRaw.toUpperCase();
  const fullName = `${lastName} ${firstName}`.trim();

  const birthdayIso = parseBirthday(stripTags(birthdayMatch[1]));
  const phone = normalizePhone(stripTags(phoneMatch[1]));
  const email = emailMatch ? stripTags(emailMatch[1]).toLowerCase() : '';

  let sex = 'Non renseigne';
  if (/meaning\/boy\//i.test(html)) sex = 'M';
  if (/meaning\/girl\//i.test(html)) sex = 'F';

  const medicalRecord = {
    generalRemarks: 'Donnees de test generees via fakenamegenerator.com',
    medicalHistory: '',
    consultationNote: '',
    relatedPeople: '',
    email,
    address1: '',
    address2: '',
    postalCode: '',
    city: '',
    country: 'France',
    recordAccess: 'Non renseigne',
    isDeceased: false
  };

  return {
    fullName,
    phone,
    sex,
    birthDate: birthdayIso,
    lastVisit: randomDateBetween('2025-01-01', '2026-04-15'),
    medicalRecord
  };
}

async function fetchOneProfile() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(SOURCE_URL, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml'
        }
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      return parseProfile(html);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      const delayMs = attempt * 350 + Math.floor(Math.random() * 300);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Unexpected fetch loop exit');
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
      profile.birthDate || null,
      profile.lastVisit || null,
      1,
      '2036-12-31'
    );
  }
});

async function run() {
  console.log(`[seed] Source: ${SOURCE_URL}`);
  console.log(`[seed] Target count: ${targetCount}`);

  const profiles = [];
  const dedupe = new Set();
  const concurrency = DEFAULT_CONCURRENCY;
  const maxAttempts = targetCount * 40;
  let attempts = 0;
  let failed = 0;

  while (profiles.length < targetCount && attempts < maxAttempts) {
    const remaining = targetCount - profiles.length;
    const batchSize = Math.min(concurrency, remaining);
    const batch = Array.from({ length: batchSize }, () => fetchOneProfile());
    const results = await Promise.allSettled(batch);

    for (const result of results) {
      attempts += 1;
      if (result.status !== 'fulfilled') {
        failed += 1;
        continue;
      }

      const profile = result.value;
      const key = `${profile.fullName}|${profile.birthDate}|${profile.phone}`;
      if (dedupe.has(key)) continue;

      dedupe.add(key);
      profiles.push(profile);
    }

    if (attempts % 120 === 0 || profiles.length === targetCount) {
      console.log(
        `[seed] Progress: ${profiles.length}/${targetCount} uniques (attempts: ${attempts}, failed: ${failed})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (profiles.length < targetCount) {
    throw new Error(
      `Unable to collect ${targetCount} unique profiles from source (got ${profiles.length}, attempts ${attempts}, failed ${failed})`
    );
  }

  insertMany(profiles);

  console.log(`[seed] Inserted ${profiles.length} patients in ${dbPath}`);
}

run()
  .catch((error) => {
    console.error('[seed] Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
