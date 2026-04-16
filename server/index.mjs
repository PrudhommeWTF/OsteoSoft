import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import argon2 from 'argon2';
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT ?? 3000);
const dataDir = path.resolve(process.cwd(), 'server/data');
const dbPath = path.resolve(dataDir, 'osteo.db');
const jwtSecret = process.env.JWT_SECRET ?? 'dev-only-jwt-secret-change-me';

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('secure_delete = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'practitioner',
    is_active INTEGER NOT NULL DEFAULT 1,
    office_id INTEGER,
    last_name TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    mobile_phone TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'France',
    siret TEXT NOT NULL DEFAULT '',
    adeli_code TEXT NOT NULL DEFAULT '',
    rpps_code TEXT NOT NULL DEFAULT '',
    ape_naf_code TEXT NOT NULL DEFAULT '',
    name_suffix_text TEXT NOT NULL DEFAULT '',
    letter_header TEXT NOT NULL DEFAULT '',
    letter_footer TEXT NOT NULL DEFAULT '',
    signature_text TEXT NOT NULL DEFAULT '',
    color_hex TEXT NOT NULL DEFAULT '#4d92d1',
    bank_name TEXT NOT NULL DEFAULT '',
    iban TEXT NOT NULL DEFAULT '',
    retrocession_percent REAL NOT NULL DEFAULT 0,
    retrocession_recipient TEXT NOT NULL DEFAULT '',
    default_agenda_view TEXT NOT NULL DEFAULT 'Semaine',
    visible_calendars TEXT NOT NULL DEFAULT 'Tous les calendriers',
    default_service TEXT NOT NULL DEFAULT 'Aucune prestation',
    invoice_mentions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS access_profiles (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    rights_json TEXT NOT NULL,
    immutable INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cipher_full_name TEXT NOT NULL,
    cipher_phone TEXT NOT NULL,
    cipher_medical_notes TEXT NOT NULL,
    sex TEXT NOT NULL DEFAULT 'Non renseigne',
    birth_date TEXT,
    last_visit TEXT,
    consent_signed INTEGER NOT NULL DEFAULT 1,
    retention_until TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    starts_at TEXT NOT NULL,
    reason_cipher TEXT NOT NULL,
    status TEXT NOT NULL,
    consultation_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    invoice_number TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    notes_cipher TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    office_id INTEGER,
    label TEXT NOT NULL,
    amount_ht_cents INTEGER NOT NULL DEFAULT 0,
    vat_rate REAL NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    office_id INTEGER,
    label TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS offices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    default_session_duration_minutes INTEGER NOT NULL DEFAULT 60,
    country TEXT NOT NULL DEFAULT 'France',
    devise TEXT NOT NULL DEFAULT 'EUR',
    invoice_number_format TEXT NOT NULL DEFAULT 'AAAA-XXXXXX',
    invoice_numbering_configuration TEXT NOT NULL DEFAULT 'Numérotation globale au cabinet',
    invoice_show_insurance_fields INTEGER NOT NULL DEFAULT 0,
    invoice_hide_vat_mention INTEGER NOT NULL DEFAULT 0,
    address_line1 TEXT,
    address_line2 TEXT,
    postal_code TEXT,
    city TEXT,
    phone_mobile TEXT,
    phone_landline TEXT,
    phone_fax TEXT,
    email TEXT,
    website TEXT,
    vat_number TEXT,
    logo_data TEXT,
    opening_hours_json TEXT NOT NULL DEFAULT '{"monday":[],"tuesday":[],"wednesday":[],"thursday":[],"friday":[],"saturday":[],"sunday":[]}',
    is_active INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_offices (
    user_id INTEGER NOT NULL,
    office_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, office_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_preference (
    user_id INTEGER PRIMARY KEY,
    slot_duration_minutes INTEGER NOT NULL DEFAULT 15,
    display_height INTEGER NOT NULL DEFAULT 14,
    pdf_display_mode TEXT NOT NULL DEFAULT 'browser',
    consultation_order TEXT NOT NULL DEFAULT 'Antichronologique',
    group_consultations_by_year_from INTEGER NOT NULL DEFAULT 10,
    patient_auto_save_frequency TEXT NOT NULL DEFAULT 'Toutes les 2 minutes',
    show_weekend INTEGER NOT NULL DEFAULT 0,
    show_patient_sex INTEGER NOT NULL DEFAULT 1,
    show_patient_mobile_phone INTEGER NOT NULL DEFAULT 1,
    show_patient_landline_phone INTEGER NOT NULL DEFAULT 0,
    show_appointment_comment INTEGER NOT NULL DEFAULT 1,
    patient_remarks_display TEXT NOT NULL DEFAULT 'hidden',
    appointment_color_mode TEXT NOT NULL DEFAULT 'calendar',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS local_calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color_hex TEXT NOT NULL DEFAULT '#4d92d1',
    is_visible_to_all INTEGER NOT NULL DEFAULT 1,
    visible_user_ids TEXT NOT NULL DEFAULT '[]',
    office_id INTEGER,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS antecedent_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS patient_drafts (
    user_id INTEGER NOT NULL,
    flow_key TEXT NOT NULL,
    draft_json TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, flow_key),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    practitioner TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    important INTEGER NOT NULL DEFAULT 0,
    height_cm REAL,
    weight_kg REAL,
    eva_before INTEGER NOT NULL DEFAULT 0,
    eva_after INTEGER NOT NULL DEFAULT 0,
    profile TEXT NOT NULL DEFAULT 'Adulte',
    motif_main_cipher TEXT,
    tests_cipher TEXT,
    schema_cipher TEXT,
    treatments_cipher TEXT,
    remarks_cipher TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS directory_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    office_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'person',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    organization TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    mobile_phone TEXT NOT NULL DEFAULT '',
    landline_phone TEXT NOT NULL DEFAULT '',
    address_line1 TEXT NOT NULL DEFAULT '',
    address_line2 TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'France',
    notes TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    updated_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
  );
`);

const rawDataKey = process.env.OSTEOSOFT_DATA_KEY;
let dataKey;

if (rawDataKey) {
  dataKey = Buffer.from(rawDataKey, 'base64');
} else {
  // Dev fallback key. Do not use in production.
  dataKey = crypto.createHash('sha256').update('dev-only-data-key-change-me').digest();
}

if (dataKey.length !== 32) {
  throw new Error('OSTEOSOFT_DATA_KEY must decode to exactly 32 bytes (base64).');
}

function encryptSensitiveField(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptSensitiveField(cipherText) {
  const payload = Buffer.from(cipherText, 'base64');
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, username: user.username }, jwtSecret, {
    expiresIn: '12h'
  });
}

const ACCESS_DOMAIN_DEFINITIONS = {
  'patient-record': [
    'read-patient-record',
    'create-patient-record',
    'delete-patient-record',
    'export-patient-record',
    'create-consultation',
    'read-consultation-detail',
    'choose-consultation-author',
    'read-protected-patient-record',
    'protect-patient-record',
    'invoice-consultation',
    'cancel-invoice'
  ],
  'patients-list': ['read-patient-list', 'search-patient-list', 'export-patient-list'],
  agenda: ['read-agenda', 'create-appointment', 'edit-appointment', 'delete-appointment', 'export-agenda'],
  billing: ['read-billing-kpis', 'create-invoice', 'mark-payment', 'export-billing'],
  statistics: ['read-dashboard', 'read-advanced-statistics', 'export-statistics'],
  'contact-directory': ['read-directory', 'create-directory-contact', 'edit-directory-contact', 'delete-directory-contact', 'export-directory']
};

function buildAccessRights(defaultValue = false) {
  return Object.entries(ACCESS_DOMAIN_DEFINITIONS).reduce((acc, [domainId, permissionIds]) => {
    acc[domainId] = permissionIds.reduce((permissions, permissionId) => {
      permissions[permissionId] = defaultValue;
      return permissions;
    }, {});
    return acc;
  }, {});
}

function normalizeAccessRights(rawRights, fallbackValue = false) {
  const source = rawRights && typeof rawRights === 'object' ? rawRights : {};

  return Object.entries(ACCESS_DOMAIN_DEFINITIONS).reduce((acc, [domainId, permissionIds]) => {
    const sourceDomain = source[domainId] && typeof source[domainId] === 'object' ? source[domainId] : {};

    acc[domainId] = permissionIds.reduce((permissions, permissionId) => {
      if (sourceDomain[permissionId] === true || sourceDomain[permissionId] === false) {
        permissions[permissionId] = sourceDomain[permissionId];
      } else {
        permissions[permissionId] = fallbackValue;
      }
      return permissions;
    }, {});

    return acc;
  }, {});
}

function buildAccessRightsForPermissions(enabledPermissionIds) {
  const enabled = new Set(enabledPermissionIds);
  const rights = buildAccessRights(false);

  for (const domainRights of Object.values(rights)) {
    for (const permissionId of Object.keys(domainRights)) {
      if (enabled.has(permissionId)) {
        domainRights[permissionId] = true;
      }
    }
  }

  return rights;
}

function createAccessProfileId(label) {
  const base = String(label ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return `${base || 'profile'}-${Date.now()}`;
}

function writeAuditLog(userId, action, entity, entityId, metadata = null) {
  db.prepare(
    'INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(userId ?? null, action, entity, entityId ?? null, metadata ? JSON.stringify(metadata) : null);
}

function getConfigValue(key, fallback) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (!row) {
    return fallback;
  }

  const value = String(row.value ?? '').trim();
  return value || fallback;
}

function getConfigBoolean(key, fallback) {
  const raw = getConfigValue(key, fallback ? '1' : '0');
  return raw === '1';
}

function getConfigInteger(key, fallback) {
  const raw = Number(getConfigValue(key, String(fallback)));
  if (!Number.isInteger(raw)) {
    return fallback;
  }

  return raw;
}

function normalizeUserAgendaPreferences(rawValue) {
  const source = rawValue && typeof rawValue === 'object' ? rawValue : {};

  const slotDurationMinutes = Number.isInteger(source.slotDurationMinutes)
    ? Math.min(Math.max(source.slotDurationMinutes, 5), 50)
    : 15;

  const displayHeight = Number.isInteger(source.displayHeight)
    ? Math.min(Math.max(source.displayHeight, 14), 35)
    : 14;

  const pdfDisplayMode = ['browser', 'download'].includes(source.pdfDisplayMode)
    ? source.pdfDisplayMode
    : 'browser';

  const consultationOrder = ['Chronologique', 'Antichronologique'].includes(source.consultationOrder)
    ? source.consultationOrder
    : 'Antichronologique';

  const groupConsultationsByYearFrom = Number.isInteger(source.groupConsultationsByYearFrom)
    ? Math.min(Math.max(source.groupConsultationsByYearFrom, 0), 200)
    : 10;

  const patientAutoSaveFrequency = ['Jamais', 'Toutes les 2 minutes', 'Toutes les 5 minutes', 'Toutes les 10 minutes'].includes(source.patientAutoSaveFrequency)
    ? source.patientAutoSaveFrequency
    : 'Toutes les 2 minutes';

  const patientRemarksDisplay = ['hidden', 'edit', 'readonly'].includes(source.patientRemarksDisplay)
    ? source.patientRemarksDisplay
    : 'hidden';

  const appointmentColorMode = ['calendar', 'user'].includes(source.appointmentColorMode)
    ? source.appointmentColorMode
    : 'calendar';

  return {
    slotDurationMinutes,
    displayHeight,
    pdfDisplayMode,
    consultationOrder,
    groupConsultationsByYearFrom,
    patientAutoSaveFrequency,
    showWeekend: Boolean(source.showWeekend),
    showPatientSex: Boolean(source.showPatientSex),
    showPatientMobilePhone: Boolean(source.showPatientMobilePhone),
    showPatientLandlinePhone: Boolean(source.showPatientLandlinePhone),
    showAppointmentComment: Boolean(source.showAppointmentComment),
    patientRemarksDisplay,
    appointmentColorMode
  };
}

function readUserAgendaPreferences(userId) {
  const row = db
    .prepare(
          `SELECT slot_duration_minutes, display_height, pdf_display_mode,
            consultation_order, group_consultations_by_year_from, patient_auto_save_frequency,
              show_weekend, show_patient_sex, show_patient_mobile_phone,
              show_patient_landline_phone, show_appointment_comment,
              patient_remarks_display, appointment_color_mode
       FROM user_preference
       WHERE user_id = ?`
    )
    .get(userId);

  if (!row) {
    return {
      slotDurationMinutes: getConfigInteger('agenda_slot_duration_minutes', 15),
      displayHeight: getConfigInteger('agenda_display_height', 14),
      pdfDisplayMode: getConfigValue('settings_pdf_display_mode', 'browser'),
      consultationOrder: getConfigValue('settings_consultation_order', 'Antichronologique'),
      groupConsultationsByYearFrom: getConfigInteger('settings_group_consultations_by_year_from', 10),
      patientAutoSaveFrequency: getConfigValue('settings_patient_auto_save_frequency', 'Toutes les 2 minutes'),
      showWeekend: getConfigBoolean('agenda_show_weekend', false),
      showPatientSex: getConfigBoolean('agenda_show_patient_sex', true),
      showPatientMobilePhone: getConfigBoolean('agenda_show_patient_mobile_phone', true),
      showPatientLandlinePhone: getConfigBoolean('agenda_show_patient_landline_phone', false),
      showAppointmentComment: getConfigBoolean('agenda_show_appointment_comment', true),
      patientRemarksDisplay: getConfigValue('agenda_patient_remarks_display', 'hidden'),
      appointmentColorMode: getConfigValue('agenda_appointment_color_mode', 'calendar')
    };
  }

  return normalizeUserAgendaPreferences({
    slotDurationMinutes: Number(row.slot_duration_minutes),
    displayHeight: Number(row.display_height),
    pdfDisplayMode: row.pdf_display_mode,
    consultationOrder: row.consultation_order,
    groupConsultationsByYearFrom: Number(row.group_consultations_by_year_from),
    patientAutoSaveFrequency: row.patient_auto_save_frequency,
    showWeekend: Number(row.show_weekend) === 1,
    showPatientSex: Number(row.show_patient_sex) === 1,
    showPatientMobilePhone: Number(row.show_patient_mobile_phone) === 1,
    showPatientLandlinePhone: Number(row.show_patient_landline_phone) === 1,
    showAppointmentComment: Number(row.show_appointment_comment) === 1,
    patientRemarksDisplay: row.patient_remarks_display,
    appointmentColorMode: row.appointment_color_mode
  });
}

function saveUserAgendaPreferences(userId, payload) {
  const preferences = normalizeUserAgendaPreferences(payload);

  db.prepare(
    `INSERT INTO user_preference (
      user_id,
      slot_duration_minutes,
      display_height,
      pdf_display_mode,
      consultation_order,
      group_consultations_by_year_from,
      patient_auto_save_frequency,
      show_weekend,
      show_patient_sex,
      show_patient_mobile_phone,
      show_patient_landline_phone,
      show_appointment_comment,
      patient_remarks_display,
      appointment_color_mode,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id)
    DO UPDATE SET
      slot_duration_minutes = excluded.slot_duration_minutes,
      display_height = excluded.display_height,
      pdf_display_mode = excluded.pdf_display_mode,
      consultation_order = excluded.consultation_order,
      group_consultations_by_year_from = excluded.group_consultations_by_year_from,
      patient_auto_save_frequency = excluded.patient_auto_save_frequency,
      show_weekend = excluded.show_weekend,
      show_patient_sex = excluded.show_patient_sex,
      show_patient_mobile_phone = excluded.show_patient_mobile_phone,
      show_patient_landline_phone = excluded.show_patient_landline_phone,
      show_appointment_comment = excluded.show_appointment_comment,
      patient_remarks_display = excluded.patient_remarks_display,
      appointment_color_mode = excluded.appointment_color_mode,
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    userId,
    preferences.slotDurationMinutes,
    preferences.displayHeight,
    preferences.pdfDisplayMode,
    preferences.consultationOrder,
    preferences.groupConsultationsByYearFrom,
    preferences.patientAutoSaveFrequency,
    preferences.showWeekend ? 1 : 0,
    preferences.showPatientSex ? 1 : 0,
    preferences.showPatientMobilePhone ? 1 : 0,
    preferences.showPatientLandlinePhone ? 1 : 0,
    preferences.showAppointmentComment ? 1 : 0,
    preferences.patientRemarksDisplay,
    preferences.appointmentColorMode
  );

  return readUserAgendaPreferences(userId);
}

function readGeneralSettings() {
  return {
    backupReminderFrequency: getConfigValue('settings_backup_reminder_frequency', 'Toutes les semaines')
  };
}

function normalizeColorHex(value, fallback = '#4d92d1') {
  const raw = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

function parseVisibleUserIds(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return [...new Set(parsed.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
  } catch {
    return [];
  }
}

const OFFICE_OPENING_DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const OFFICE_OPENING_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function createDefaultOfficeOpeningHours() {
  return {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: []
  };
}

function normalizeOfficeOpeningHours(rawOpeningHours) {
  const normalized = createDefaultOfficeOpeningHours();

  if (!rawOpeningHours || typeof rawOpeningHours !== 'object') {
    return normalized;
  }

  for (const day of OFFICE_OPENING_DAY_KEYS) {
    const ranges = Array.isArray(rawOpeningHours[day]) ? rawOpeningHours[day] : [];

    normalized[day] = ranges
      .map((range) => {
        if (!range || typeof range !== 'object') {
          return null;
        }

        const start = String(range.start ?? '').trim();
        const end = String(range.end ?? '').trim();
        if (!OFFICE_OPENING_TIME_PATTERN.test(start) || !OFFICE_OPENING_TIME_PATTERN.test(end)) {
          return null;
        }

        if (start >= end) {
          return null;
        }

        return { start, end };
      })
      .filter(Boolean);
  }

  return normalized;
}

function parseOfficeOpeningHours(rawJson) {
  if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
    return createDefaultOfficeOpeningHours();
  }

  try {
    return normalizeOfficeOpeningHours(JSON.parse(rawJson));
  } catch {
    return createDefaultOfficeOpeningHours();
  }
}

function normalizeOfficeDefaultSessionDurationMinutes(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    return 60;
  }

  return Math.min(Math.max(parsed, 15), 90);
}

function normalizeOfficeDevise(rawValue) {
  const value = String(rawValue ?? '').trim().toUpperCase();
  return ['EUR', 'USD', 'CHF', 'GBP', 'CAD'].includes(value) ? value : 'EUR';
}

function normalizeOfficeInvoiceNumberFormat(rawValue) {
  const value = String(rawValue ?? '').trim();
  return [
    'AAAA-XXXXXX',
    'AAAAMM-XXXXXX',
    'AAAAMMJJ-XXXXXX',
    'AAAAMM-XXXX : RAZ mensuelle (déconseillé)',
    'AAAA-XXXX : RAZ annuel'
  ].includes(value)
    ? value
    : 'AAAA-XXXXXX';
}

function normalizeOfficeInvoiceNumberingConfiguration(rawValue) {
  const value = String(rawValue ?? '').trim();
  return value === 'Numérotation par praticien' ? value : 'Numérotation globale au cabinet';
}

function readOfficeServiceTypes(officeId) {
  return db
    .prepare(
      `SELECT id, label, amount_ht_cents, vat_rate, display_order
       FROM service_types
       WHERE office_id = ?
       ORDER BY display_order ASC, id ASC`
    )
    .all(officeId)
    .map((row) => ({
      id: Number(row.id),
      label: String(row.label ?? '').trim(),
      amountHt: Number(row.amount_ht_cents ?? 0) / 100,
      vatRate: Number(row.vat_rate ?? 0),
      displayOrder: Number(row.display_order ?? 0)
    }));
}

function readOfficePaymentMethods(officeId) {
  return db
    .prepare(
      `SELECT id, label, is_active, display_order
       FROM payment_methods
       WHERE office_id = ?
       ORDER BY display_order ASC, id ASC`
    )
    .all(officeId)
    .map((row) => ({
      id: Number(row.id),
      label: String(row.label ?? '').trim(),
      isActive: Number(row.is_active) === 1,
      displayOrder: Number(row.display_order ?? 0)
    }));
}

function normalizeOfficeServiceTypesPayload(rawServiceTypes) {
  if (!Array.isArray(rawServiceTypes)) {
    return [];
  }

  return rawServiceTypes
    .map((item, index) => {
      const id = item?.id != null ? Number(item.id) : null;
      const label = String(item?.label ?? '').trim();
      if (!label) {
        return null;
      }

      return {
        id: Number.isInteger(id) && id > 0 ? id : null,
        label,
        amountHtCents: Math.max(0, Math.round((Number(item?.amountHt) || 0) * 100)),
        vatRate: Math.min(Math.max(Number(item?.vatRate) || 0, 0), 100),
        displayOrder: index + 1
      };
    })
    .filter(Boolean);
}

function normalizeOfficePaymentMethodsPayload(rawPaymentMethods) {
  if (!Array.isArray(rawPaymentMethods)) {
    return [];
  }

  return rawPaymentMethods
    .map((item, index) => {
      const id = item?.id != null ? Number(item.id) : null;
      const label = String(item?.label ?? '').trim();
      if (!label) {
        return null;
      }

      return {
        id: Number.isInteger(id) && id > 0 ? id : null,
        label,
        isActive: Boolean(item?.isActive),
        displayOrder: index + 1
      };
    })
    .filter(Boolean);
}

function replaceOfficeBusinessSettings(officeId, serviceTypes, paymentMethods) {
  const normalizedOfficeId = Number(officeId);
  if (!Number.isInteger(normalizedOfficeId) || normalizedOfficeId <= 0) {
    return;
  }

  const normalizedServiceTypes = normalizeOfficeServiceTypesPayload(serviceTypes);
  const normalizedPaymentMethods = normalizeOfficePaymentMethodsPayload(paymentMethods);

  const transaction = db.transaction(() => {
    const upsertServiceType = db.prepare(
      `INSERT INTO service_types (id, office_id, label, amount_ht_cents, vat_rate, display_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET office_id = excluded.office_id,
                     label = excluded.label,
                     amount_ht_cents = excluded.amount_ht_cents,
                     vat_rate = excluded.vat_rate,
                     display_order = excluded.display_order`
    );
    const insertServiceType = db.prepare(
      `INSERT INTO service_types (office_id, label, amount_ht_cents, vat_rate, display_order)
       VALUES (?, ?, ?, ?, ?)`
    );
    const keepServiceTypeIds = [];

    for (const item of normalizedServiceTypes) {
      if (item.id) {
        upsertServiceType.run(item.id, normalizedOfficeId, item.label, item.amountHtCents, item.vatRate, item.displayOrder);
        keepServiceTypeIds.push(item.id);
      } else {
        const result = insertServiceType.run(normalizedOfficeId, item.label, item.amountHtCents, item.vatRate, item.displayOrder);
        keepServiceTypeIds.push(Number(result.lastInsertRowid));
      }
    }

    if (keepServiceTypeIds.length > 0) {
      const placeholders = keepServiceTypeIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM service_types WHERE office_id = ? AND id NOT IN (${placeholders})`).run(normalizedOfficeId, ...keepServiceTypeIds);
    } else {
      db.prepare('DELETE FROM service_types WHERE office_id = ?').run(normalizedOfficeId);
    }

    const upsertPaymentMethod = db.prepare(
      `INSERT INTO payment_methods (id, office_id, label, is_active, display_order)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET office_id = excluded.office_id,
                     label = excluded.label,
                     is_active = excluded.is_active,
                     display_order = excluded.display_order`
    );
    const insertPaymentMethod = db.prepare(
      `INSERT INTO payment_methods (office_id, label, is_active, display_order)
       VALUES (?, ?, ?, ?)`
    );
    const keepPaymentMethodIds = [];

    for (const item of normalizedPaymentMethods) {
      if (item.id) {
        upsertPaymentMethod.run(item.id, normalizedOfficeId, item.label, item.isActive ? 1 : 0, item.displayOrder);
        keepPaymentMethodIds.push(item.id);
      } else {
        const result = insertPaymentMethod.run(normalizedOfficeId, item.label, item.isActive ? 1 : 0, item.displayOrder);
        keepPaymentMethodIds.push(Number(result.lastInsertRowid));
      }
    }

    if (keepPaymentMethodIds.length > 0) {
      const placeholders = keepPaymentMethodIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM payment_methods WHERE office_id = ? AND id NOT IN (${placeholders})`).run(normalizedOfficeId, ...keepPaymentMethodIds);
    } else {
      db.prepare('DELETE FROM payment_methods WHERE office_id = ?').run(normalizedOfficeId);
    }
  });

  transaction();
}

function mapOfficeRow(row) {
  const { openingHoursJson, ...officeFields } = row;
  const officeId = Number(officeFields.id);
  return {
    ...officeFields,
    defaultSessionDurationMinutes: normalizeOfficeDefaultSessionDurationMinutes(officeFields.defaultSessionDurationMinutes),
    country: String(officeFields.country ?? '').trim() || 'France',
    devise: normalizeOfficeDevise(officeFields.devise),
    invoiceNumberFormat: normalizeOfficeInvoiceNumberFormat(officeFields.invoiceNumberFormat),
    numberingConfiguration: normalizeOfficeInvoiceNumberingConfiguration(officeFields.invoiceNumberingConfiguration),
    alwaysShowSocialSecurityAndMutuelle: Boolean(officeFields.invoiceShowInsuranceFields),
    hideVatMention: Boolean(officeFields.invoiceHideVatMention),
    serviceTypes: Number.isInteger(officeId) && officeId > 0 ? readOfficeServiceTypes(officeId) : [],
    paymentMethods: Number.isInteger(officeId) && officeId > 0 ? readOfficePaymentMethods(officeId) : [],
    isActive: Boolean(officeFields.isActive),
    openingHours: parseOfficeOpeningHours(openingHoursJson)
  };
}

function readAgendaSettings(userId = null, officeId = null) {
  const settings = {
    dayStartHour: getConfigInteger('agenda_day_start_hour', 8),
    dayEndHour: getConfigInteger('agenda_day_end_hour', 20),
    lunchStartHour: getConfigInteger('agenda_lunch_start_hour', 12),
    lunchEndHour: getConfigInteger('agenda_lunch_end_hour', 13),
    defaultSessionDurationMinutes: getConfigInteger('agenda_default_session_duration_minutes', 60),
    slotDurationMinutes: getConfigInteger('agenda_slot_duration_minutes', 15),
    displayHeight: getConfigInteger('agenda_display_height', 14),
    autoConsultationType: true,
    showWeekend: false,
    showPatientSex: true,
    showPatientMobilePhone: true,
    showPatientLandlinePhone: false,
    showAppointmentComment: true,
    patientRemarksDisplay: 'hidden',
    appointmentColorMode: 'calendar'
  };

  if (Number.isInteger(Number(userId)) && Number(userId) > 0) {
    Object.assign(settings, readUserAgendaPreferences(Number(userId)));
  } else {
    settings.showWeekend = getConfigBoolean('agenda_show_weekend', false);
    settings.showPatientSex = getConfigBoolean('agenda_show_patient_sex', true);
    settings.showPatientMobilePhone = getConfigBoolean('agenda_show_patient_mobile_phone', true);
    settings.showPatientLandlinePhone = getConfigBoolean('agenda_show_patient_landline_phone', false);
    settings.showAppointmentComment = getConfigBoolean('agenda_show_appointment_comment', true);
    settings.patientRemarksDisplay = getConfigValue('agenda_patient_remarks_display', 'hidden');
    settings.appointmentColorMode = getConfigValue('agenda_appointment_color_mode', 'calendar');
  }

  settings.dayStartHour = Math.min(Math.max(settings.dayStartHour, 0), 23);
  settings.dayEndHour = Math.min(Math.max(settings.dayEndHour, settings.dayStartHour + 1), 24);
  settings.lunchStartHour = Math.min(Math.max(settings.lunchStartHour, settings.dayStartHour), settings.dayEndHour);
  settings.lunchEndHour = Math.min(Math.max(settings.lunchEndHour, settings.lunchStartHour + 1), settings.dayEndHour);
  settings.defaultSessionDurationMinutes = Math.min(Math.max(settings.defaultSessionDurationMinutes, 15), 90);
  settings.slotDurationMinutes = Math.min(Math.max(settings.slotDurationMinutes, 5), 50);
  settings.displayHeight = Math.min(Math.max(settings.displayHeight, 14), 35);

  const normalizedOfficeId = Number(officeId);
  if (Number.isInteger(normalizedOfficeId) && normalizedOfficeId > 0) {
    const officeRow = db.prepare('SELECT default_session_duration_minutes AS defaultSessionDurationMinutes FROM offices WHERE id = ?').get(normalizedOfficeId);
    if (officeRow) {
      settings.defaultSessionDurationMinutes = normalizeOfficeDefaultSessionDurationMinutes(officeRow.defaultSessionDurationMinutes);
    }
  }

  if (!['hidden', 'edit', 'readonly'].includes(settings.patientRemarksDisplay)) {
    settings.patientRemarksDisplay = 'hidden';
  }

  if (!['calendar', 'user'].includes(settings.appointmentColorMode)) {
    settings.appointmentColorMode = 'calendar';
  }

  const users = db.prepare('SELECT id, username FROM users WHERE is_active = 1').all();
  const usernameById = new Map(users.map((user) => [Number(user.id), user.username]));

  const localCalendars = db
    .prepare(
      `SELECT id, name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order
       FROM local_calendars
       ORDER BY display_order ASC, id ASC`
    )
    .all()
    .map((row) => {
      const visibleUserIds = parseVisibleUserIds(row.visible_user_ids);
      return {
        id: Number(row.id),
        name: String(row.name ?? '').trim(),
        description: String(row.description ?? '').trim(),
        colorHex: normalizeColorHex(row.color_hex),
        visibility: row.is_visible_to_all ? 'all' : 'selected',
        visibleUserIds,
        visibleUsernames: visibleUserIds.map((id) => usernameById.get(id)).filter(Boolean),
        officeId: row.office_id != null ? Number(row.office_id) : null,
        displayOrder: Number(row.display_order ?? 0)
      };
    });

  return {
    settings,
    localCalendars
  };
}

function getCalendarColorByIndex(index) {
  const palette = ['#4d92d1', '#2d9d78', '#e67e22', '#8e44ad', '#c0392b', '#16a085', '#34495e', '#f39c12'];
  return palette[index % palette.length];
}

function normalizeOfficeIds(officeIds, fallbackOfficeId = null) {
  const normalized = [...new Set((Array.isArray(officeIds) ? officeIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];

  if (normalized.length > 0) {
    return normalized;
  }

  const fallback = Number(fallbackOfficeId);
  if (Number.isInteger(fallback) && fallback > 0) {
    return [fallback];
  }

  return [];
}

function syncUserOffices(userId, officeIds) {
  const normalized = normalizeOfficeIds(officeIds);
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM user_offices WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO user_offices (user_id, office_id) VALUES (?, ?)');
    for (const officeId of normalized) {
      insert.run(userId, officeId);
    }
  });

  replace();
}

function getUserOfficeIds(userId) {
  const rows = db
    .prepare('SELECT office_id FROM user_offices WHERE user_id = ? ORDER BY office_id ASC')
    .all(userId);

  const ids = rows
    .map((row) => Number(row.office_id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length > 0) {
    return ids;
  }

  const legacy = db.prepare('SELECT office_id FROM users WHERE id = ?').get(userId);
  const legacyOfficeId = Number(legacy?.office_id);
  return Number.isInteger(legacyOfficeId) && legacyOfficeId > 0 ? [legacyOfficeId] : [];
}

function getUserOfficeOptions(userId) {
  return db
    .prepare(
      `SELECT o.id, o.name
       FROM user_offices uo
       INNER JOIN offices o ON o.id = uo.office_id
       WHERE uo.user_id = ?
       ORDER BY lower(o.name) ASC`
    )
    .all(userId)
    .map((row) => ({ id: Number(row.id), name: String(row.name ?? '').trim() }));
}

function getScopedOfficeOptions(userAccess, isAdmin) {
  if (isAdmin) {
    return db
      .prepare('SELECT id, name FROM offices WHERE is_active = 1 ORDER BY lower(name) ASC, id ASC')
      .all()
      .map((row) => ({ id: Number(row.id), name: String(row.name ?? '').trim() }));
  }

  return Array.isArray(userAccess?.offices) ? userAccess.offices : [];
}

function mapDirectoryContactRow(row) {
  const firstName = String(row.first_name ?? '').trim();
  const lastName = String(row.last_name ?? '').trim();
  const organization = String(row.organization ?? '').trim();
  const displayName = `${lastName} ${firstName}`.trim() || organization || 'Contact';

  return {
    id: Number(row.id),
    officeId: Number(row.office_id),
    officeName: String(row.office_name ?? '').trim(),
    kind: row.kind === 'company' ? 'company' : 'person',
    firstName,
    lastName,
    organization,
    displayName,
    role: String(row.role ?? '').trim(),
    email: String(row.email ?? '').trim(),
    mobilePhone: String(row.mobile_phone ?? '').trim(),
    landlinePhone: String(row.landline_phone ?? '').trim(),
    address1: String(row.address_line1 ?? '').trim(),
    address2: String(row.address_line2 ?? '').trim(),
    postalCode: String(row.postal_code ?? '').trim(),
    city: String(row.city ?? '').trim(),
    country: String(row.country ?? 'France').trim() || 'France',
    notes: String(row.notes ?? '').trim(),
    isActive: Number(row.is_active) === 1,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  };
}

function getAccessibleCalendarIdsForUser(userId, officeIdFilter = null) {
  const userOfficeIds = new Set(getUserOfficeIds(userId));
  const filterOfficeId = Number(officeIdFilter);
  const hasOfficeFilter = Number.isInteger(filterOfficeId) && filterOfficeId > 0;

  const rows = db
    .prepare(
      `SELECT id, office_id, is_visible_to_all, visible_user_ids
       FROM local_calendars`
    )
    .all();

  const ids = [];
  for (const row of rows) {
    const calendarId = Number(row.id);
    if (!Number.isInteger(calendarId) || calendarId <= 0) {
      continue;
    }

    const calendarOfficeId = row.office_id != null ? Number(row.office_id) : null;
    if (!Number.isInteger(calendarOfficeId) || Number(calendarOfficeId) <= 0) {
      continue;
    }

    if (hasOfficeFilter && calendarOfficeId !== filterOfficeId) {
      continue;
    }

    if (calendarOfficeId != null && userOfficeIds.size > 0 && !userOfficeIds.has(calendarOfficeId)) {
      continue;
    }

    const isVisibleToAll = Number(row.is_visible_to_all) === 1;
    const visibleUserIds = parseVisibleUserIds(row.visible_user_ids);
    const visibleToUser = isVisibleToAll || visibleUserIds.includes(userId);
    if (!visibleToUser) {
      continue;
    }

    ids.push(calendarId);
  }

  return ids;
}

function getDefaultCalendarIdForUser(userId) {
  const ids = getAccessibleCalendarIdsForUser(userId, null);
  return ids.length > 0 ? ids[0] : null;
}

function createLocalCalendarFromOffice(officeId, officeName) {
  const trimmedName = String(officeName ?? '').trim();
  if (!trimmedName) {
    return;
  }

  const existing = db
    .prepare('SELECT id FROM local_calendars WHERE office_id = ? LIMIT 1')
    .get(officeId);

  if (existing) {
    return;
  }

  const maxOrder = db.prepare('SELECT MAX(display_order) AS maxOrder FROM local_calendars').get();
  const displayOrder = Number(maxOrder?.maxOrder ?? 0) + 1;

  db.prepare(
    `INSERT INTO local_calendars (name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order)
     VALUES (?, ?, ?, 1, '[]', ?, ?)`
  ).run(trimmedName, `Agenda du cabinet ${trimmedName}`, getCalendarColorByIndex(displayOrder - 1), officeId, displayOrder);
}

function ensureDefaultLocalCalendars() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM local_calendars').get();
  if (Number(count?.count ?? 0) > 0) {
    return;
  }

  const offices = db.prepare('SELECT id, name FROM offices ORDER BY display_order ASC, id ASC').all();
  if (offices.length > 0) {
    offices.forEach((office, index) => {
      db.prepare(
        `INSERT INTO local_calendars (name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order)
         VALUES (?, ?, ?, 1, '[]', ?, ?)`
      ).run(
        String(office.name ?? '').trim(),
        `Agenda du cabinet ${String(office.name ?? '').trim()}`,
        getCalendarColorByIndex(index),
        Number(office.id),
        index + 1
      );
    });
    return;
  }

  // A local calendar must belong to an office. If no office exists yet,
  // calendars will be created when the first office is created.
}

function buildDataBackupSnapshot() {
  const appName = db.prepare('SELECT value FROM config WHERE key = ?').get('app_name')?.value ?? 'OsteoSoft';
  const appVersion = db.prepare('SELECT value FROM config WHERE key = ?').get('version')?.value ?? '0.0.2';

  return {
    meta: {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      appName,
      appVersion
    },
    data: {
      accessProfiles: db.prepare(
        `SELECT id, label, description, rights_json, immutable, created_at, updated_at
         FROM access_profiles
         ORDER BY created_at ASC, id ASC`
      ).all(),
      users: db.prepare(
        `SELECT id, username, password_hash, role, profile_id, is_active,
                office_id, last_name, first_name, email, mobile_phone, country,
                siret, adeli_code, rpps_code, ape_naf_code, name_suffix_text,
                letter_header, letter_footer, signature_text, color_hex,
                bank_name, iban, retrocession_percent, retrocession_recipient,
                default_agenda_view, visible_calendars, default_service, invoice_mentions,
                created_at
         FROM users
         ORDER BY id ASC`
      ).all(),
      userOffices: db.prepare(
        `SELECT user_id, office_id, created_at
         FROM user_offices
         ORDER BY user_id ASC, office_id ASC`
      ).all(),
      patients: db.prepare(
        `SELECT id, cipher_full_name, cipher_phone, cipher_medical_notes, sex,
                birth_date, last_visit, consent_signed, retention_until,
                is_deleted, created_at, updated_at
         FROM patients
         ORDER BY id ASC`
      ).all(),
      appointments: db.prepare(
        `SELECT id, patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id, created_at
         FROM appointments
         ORDER BY id ASC`
      ).all(),
      invoices: db.prepare(
        `SELECT id, patient_id, invoice_number, amount_cents, status,
                issued_at, due_at, notes_cipher, created_at
         FROM invoices
         ORDER BY id ASC`
      ).all(),
      consultations: db.prepare(
        `SELECT id, patient_id, started_at, practitioner, title, important,
                height_cm, weight_kg, eva_before, eva_after, profile,
                motif_main_cipher, tests_cipher, schema_cipher, treatments_cipher,
                remarks_cipher, created_at
         FROM consultations
         ORDER BY id ASC`
      ).all(),
      antecedentTypes: db.prepare(
        `SELECT id, label, created_at
         FROM antecedent_types
         ORDER BY id ASC`
      ).all(),
      serviceTypes: db.prepare(
        `SELECT id, office_id, label, amount_ht_cents, vat_rate, display_order, created_at
         FROM service_types
         ORDER BY display_order ASC, id ASC`
      ).all(),
      paymentMethods: db.prepare(
        `SELECT id, office_id, label, is_active, display_order, created_at
         FROM payment_methods
         ORDER BY display_order ASC, id ASC`
      ).all(),
      localCalendars: db.prepare(
        `SELECT id, name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order, created_at, updated_at
         FROM local_calendars
         ORDER BY display_order ASC, id ASC`
      ).all(),
      directoryContacts: db.prepare(
        `SELECT id, office_id, kind, first_name, last_name, organization, role,
                email, mobile_phone, landline_phone,
                address_line1, address_line2, postal_code, city, country,
                notes, is_active, created_by, updated_by, created_at, updated_at
         FROM directory_contacts
         ORDER BY id ASC`
      ).all(),
      config: db.prepare('SELECT key, value FROM config ORDER BY key ASC').all(),
      patientDrafts: db.prepare(
        `SELECT user_id, flow_key, draft_json, step, updated_at
         FROM patient_drafts
         ORDER BY user_id ASC, flow_key ASC`
      ).all(),
      auditLogs: db.prepare(
        `SELECT id, user_id, action, entity, entity_id, metadata, created_at
         FROM audit_logs
         ORDER BY id ASC`
      ).all()
    }
  };
}

function restoreDataBackupSnapshot(backupPayload) {
  const backup = backupPayload?.data;
  if (!backup || typeof backup !== 'object') {
    throw new Error('Format de sauvegarde invalide');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM audit_logs').run();
    db.prepare('DELETE FROM patient_drafts').run();
    db.prepare('DELETE FROM consultations').run();
    db.prepare('DELETE FROM appointments').run();
    db.prepare('DELETE FROM invoices').run();
    db.prepare('DELETE FROM patients').run();
    db.prepare('DELETE FROM user_offices').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM access_profiles').run();
    db.prepare('DELETE FROM antecedent_types').run();
    db.prepare('DELETE FROM service_types').run();
    db.prepare('DELETE FROM payment_methods').run();
    db.prepare('DELETE FROM local_calendars').run();
    db.prepare('DELETE FROM directory_contacts').run();
    db.prepare('DELETE FROM config').run();

    const insertAccessProfile = db.prepare(
      `INSERT INTO access_profiles (id, label, description, rights_json, immutable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertUser = db.prepare(
      `INSERT INTO users (
         id, username, password_hash, role, profile_id, is_active,
         office_id, last_name, first_name, email, mobile_phone, country,
         siret, adeli_code, rpps_code, ape_naf_code, name_suffix_text,
         letter_header, letter_footer, signature_text, color_hex,
         bank_name, iban, retrocession_percent, retrocession_recipient,
         default_agenda_view, visible_calendars, default_service, invoice_mentions,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertPatient = db.prepare(
      `INSERT INTO patients (
         id, cipher_full_name, cipher_phone, cipher_medical_notes, sex,
         birth_date, last_visit, consent_signed, retention_until,
         is_deleted, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertUserOffice = db.prepare(
      `INSERT INTO user_offices (user_id, office_id, created_at)
       VALUES (?, ?, ?)`
    );
    const insertAppointment = db.prepare(
      `INSERT INTO appointments (id, patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertInvoice = db.prepare(
      `INSERT INTO invoices (id, patient_id, invoice_number, amount_cents, status, issued_at, due_at, notes_cipher, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertConsultation = db.prepare(
      `INSERT INTO consultations (
         id, patient_id, started_at, practitioner, title, important,
         height_cm, weight_kg, eva_before, eva_after, profile,
         motif_main_cipher, tests_cipher, schema_cipher, treatments_cipher,
         remarks_cipher, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAntecedentType = db.prepare(
      `INSERT INTO antecedent_types (id, label, created_at)
       VALUES (?, ?, ?)`
    );
    const insertServiceType = db.prepare(
      `INSERT INTO service_types (id, office_id, label, amount_ht_cents, vat_rate, display_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertPaymentMethod = db.prepare(
      `INSERT INTO payment_methods (id, office_id, label, is_active, display_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertLocalCalendar = db.prepare(
      `INSERT INTO local_calendars (id, name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertDirectoryContact = db.prepare(
      `INSERT INTO directory_contacts (
         id, office_id, kind, first_name, last_name, organization, role,
         email, mobile_phone, landline_phone,
         address_line1, address_line2, postal_code, city, country,
         notes, is_active, created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertConfig = db.prepare(
      'INSERT INTO config (key, value) VALUES (?, ?)'
    );
    const insertPatientDraft = db.prepare(
      `INSERT INTO patient_drafts (user_id, flow_key, draft_json, step, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertAuditLog = db.prepare(
      `INSERT INTO audit_logs (id, user_id, action, entity, entity_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const row of Array.isArray(backup.accessProfiles) ? backup.accessProfiles : []) {
      insertAccessProfile.run(
        row.id,
        row.label,
        row.description ?? '',
        row.rights_json,
        Number(row.immutable) ? 1 : 0,
        row.created_at ?? new Date().toISOString(),
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.users) ? backup.users : []) {
      let officeId = row.office_id != null ? Number(row.office_id) : null;

      if ((!Number.isInteger(officeId) || officeId <= 0) && typeof row.cabinet_name === 'string' && row.cabinet_name.trim()) {
        const office = db.prepare('SELECT id FROM offices WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1').get(row.cabinet_name);
        officeId = office ? Number(office.id) : null;
      }

      if (!Number.isInteger(officeId) || officeId <= 0) {
        officeId = null;
      }

      insertUser.run(
        Number(row.id),
        row.username,
        row.password_hash,
        row.role ?? 'practitioner',
        row.profile_id ?? 'super-admin',
        Number(row.is_active) ? 1 : 0,
        officeId,
        row.last_name ?? '',
        row.first_name ?? '',
        row.email ?? '',
        row.mobile_phone ?? '',
        row.country ?? 'France',
        row.siret ?? '',
        row.adeli_code ?? '',
        row.rpps_code ?? '',
        row.ape_naf_code ?? '',
        row.name_suffix_text ?? '',
        row.letter_header ?? '',
        row.letter_footer ?? '',
        row.signature_text ?? '',
        row.color_hex ?? '#4d92d1',
        row.bank_name ?? '',
        row.iban ?? '',
        Number(row.retrocession_percent) || 0,
        row.retrocession_recipient ?? '',
        row.default_agenda_view ?? 'Semaine',
        row.visible_calendars ?? 'Tous les calendriers',
        row.default_service ?? 'Aucune prestation',
        row.invoice_mentions ?? '',
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.userOffices) ? backup.userOffices : []) {
      insertUserOffice.run(
        Number(row.user_id),
        Number(row.office_id),
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.config) ? backup.config : []) {
      insertConfig.run(row.key, row.value ?? '');
    }

    for (const row of Array.isArray(backup.antecedentTypes) ? backup.antecedentTypes : []) {
      insertAntecedentType.run(Number(row.id), row.label, row.created_at ?? new Date().toISOString());
    }

    for (const row of Array.isArray(backup.serviceTypes) ? backup.serviceTypes : []) {
      insertServiceType.run(
        Number(row.id),
        row.office_id != null ? Number(row.office_id) : null,
        String(row.label ?? ''),
        Number(row.amount_ht_cents) || 0,
        Number(row.vat_rate) || 0,
        Number(row.display_order) || 0,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.paymentMethods) ? backup.paymentMethods : []) {
      insertPaymentMethod.run(
        Number(row.id),
        row.office_id != null ? Number(row.office_id) : null,
        String(row.label ?? ''),
        Number(row.is_active) ? 1 : 0,
        Number(row.display_order) || 0,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.localCalendars) ? backup.localCalendars : []) {
      insertLocalCalendar.run(
        Number(row.id),
        String(row.name ?? '').trim() || 'Calendrier',
        String(row.description ?? ''),
        normalizeColorHex(row.color_hex),
        Number(row.is_visible_to_all) ? 1 : 0,
        typeof row.visible_user_ids === 'string' ? row.visible_user_ids : '[]',
        row.office_id != null ? Number(row.office_id) : null,
        Number(row.display_order) || 0,
        row.created_at ?? new Date().toISOString(),
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.directoryContacts) ? backup.directoryContacts : []) {
      insertDirectoryContact.run(
        Number(row.id),
        Number(row.office_id),
        row.kind === 'company' ? 'company' : 'person',
        String(row.first_name ?? ''),
        String(row.last_name ?? ''),
        String(row.organization ?? ''),
        String(row.role ?? ''),
        String(row.email ?? ''),
        String(row.mobile_phone ?? ''),
        String(row.landline_phone ?? ''),
        String(row.address_line1 ?? ''),
        String(row.address_line2 ?? ''),
        String(row.postal_code ?? ''),
        String(row.city ?? ''),
        String(row.country ?? 'France'),
        String(row.notes ?? ''),
        Number(row.is_active) ? 1 : 0,
        row.created_by != null ? Number(row.created_by) : null,
        row.updated_by != null ? Number(row.updated_by) : null,
        row.created_at ?? new Date().toISOString(),
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.patients) ? backup.patients : []) {
      insertPatient.run(
        Number(row.id),
        row.cipher_full_name,
        row.cipher_phone,
        row.cipher_medical_notes,
        row.sex ?? 'Non renseigne',
        row.birth_date ?? null,
        row.last_visit ?? null,
        Number(row.consent_signed) ? 1 : 0,
        row.retention_until ?? null,
        Number(row.is_deleted) ? 1 : 0,
        row.created_at ?? new Date().toISOString(),
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.appointments) ? backup.appointments : []) {
      insertAppointment.run(
        Number(row.id),
        Number(row.patient_id),
        row.starts_at,
        row.reason_cipher,
        row.status,
        row.local_calendar_id != null ? Number(row.local_calendar_id) : null,
        row.consultation_id != null ? Number(row.consultation_id) : null,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.invoices) ? backup.invoices : []) {
      insertInvoice.run(
        Number(row.id),
        Number(row.patient_id),
        row.invoice_number,
        Number(row.amount_cents) || 0,
        row.status,
        row.issued_at,
        row.due_at,
        row.notes_cipher,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.consultations) ? backup.consultations : []) {
      insertConsultation.run(
        Number(row.id),
        Number(row.patient_id),
        row.started_at ?? new Date().toISOString(),
        row.practitioner ?? '',
        row.title ?? '',
        Number(row.important) ? 1 : 0,
        row.height_cm ?? null,
        row.weight_kg ?? null,
        Number(row.eva_before) || 0,
        Number(row.eva_after) || 0,
        row.profile ?? 'Adulte',
        row.motif_main_cipher ?? null,
        row.tests_cipher ?? null,
        row.schema_cipher ?? null,
        row.treatments_cipher ?? null,
        row.remarks_cipher ?? null,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.patientDrafts) ? backup.patientDrafts : []) {
      insertPatientDraft.run(
        Number(row.user_id),
        row.flow_key,
        row.draft_json,
        Number(row.step) || 1,
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.auditLogs) ? backup.auditLogs : []) {
      insertAuditLog.run(
        Number(row.id),
        row.user_id != null ? Number(row.user_id) : null,
        row.action,
        row.entity,
        row.entity_id ?? null,
        row.metadata ?? null,
        row.created_at ?? new Date().toISOString()
      );
    }
  });

  db.pragma('foreign_keys = OFF');
  try {
    transaction();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function tableExists(tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row?.name);
}

function migrateUserPreferenceTable() {
  const legacyTable = 'user_agenda_preferences';
  const targetTable = 'user_preference';
  const hasLegacyTable = tableExists(legacyTable);
  const hasTargetTable = tableExists(targetTable);

  if (!hasLegacyTable) {
    return;
  }

  if (!hasTargetTable) {
    db.exec(`ALTER TABLE ${legacyTable} RENAME TO ${targetTable}`);
    return;
  }

  const legacyColumns = new Set(
    db.prepare(`PRAGMA table_info(${legacyTable})`).all().map((column) => column.name)
  );

  const columnExpr = (columnName, fallbackExpr) =>
    legacyColumns.has(columnName) ? columnName : fallbackExpr;

  db.prepare(
    `INSERT OR IGNORE INTO user_preference (
      user_id,
      slot_duration_minutes,
      display_height,
      pdf_display_mode,
      consultation_order,
      group_consultations_by_year_from,
      patient_auto_save_frequency,
      show_weekend,
      show_patient_sex,
      show_patient_mobile_phone,
      show_patient_landline_phone,
      show_appointment_comment,
      patient_remarks_display,
      appointment_color_mode
    )
    SELECT
      ${columnExpr('user_id', 'NULL')},
      ${columnExpr('slot_duration_minutes', '15')},
      ${columnExpr('display_height', '14')},
      ${columnExpr('pdf_display_mode', "'browser'")},
      ${columnExpr('consultation_order', "'Antichronologique'")},
      ${columnExpr('group_consultations_by_year_from', '10')},
      ${columnExpr('patient_auto_save_frequency', "'Toutes les 2 minutes'")},
      ${columnExpr('show_weekend', '0')},
      ${columnExpr('show_patient_sex', '1')},
      ${columnExpr('show_patient_mobile_phone', '1')},
      ${columnExpr('show_patient_landline_phone', '0')},
      ${columnExpr('show_appointment_comment', '1')},
      ${columnExpr('patient_remarks_display', "'hidden'")},
      ${columnExpr('appointment_color_mode', "'calendar'")}
    FROM user_agenda_preferences`
  ).run();

  db.exec(`DROP TABLE ${legacyTable}`);
}

function migrateUsersOfficeForeignKey() {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const hasOfficeId = columns.some((column) => column.name === 'office_id');
  const hasCabinetName = columns.some((column) => column.name === 'cabinet_name');
  const hasCreatedAt = columns.some((column) => column.name === 'created_at');

  if (!hasOfficeId && !hasCabinetName) {
    return;
  }

  const foreignKeys = db.prepare('PRAGMA foreign_key_list(users)').all();
  const hasOfficeForeignKey = foreignKeys.some((fk) => fk.from === 'office_id' && fk.table === 'offices');

  if (hasOfficeId && hasOfficeForeignKey && !hasCabinetName) {
    return;
  }

  const officeIdExpressions = [];
  if (hasOfficeId) {
    officeIdExpressions.push('u.office_id');
  }
  if (hasCabinetName) {
    officeIdExpressions.push(`(
      SELECT o.id
      FROM offices o
      WHERE lower(trim(o.name)) = lower(trim(coalesce(u.cabinet_name, '')))
      LIMIT 1
    )`);
  }

  const officeIdExpr = officeIdExpressions.length > 0 ? `coalesce(${officeIdExpressions.join(', ')})` : 'NULL';
  const createdAtExpr = hasCreatedAt ? 'u.created_at' : 'CURRENT_TIMESTAMP';

  const migration = db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'practitioner',
        is_active INTEGER NOT NULL DEFAULT 1,
        profile_id TEXT NOT NULL DEFAULT 'super-admin',
        office_id INTEGER,
        last_name TEXT NOT NULL DEFAULT '',
        first_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        mobile_phone TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT 'France',
        siret TEXT NOT NULL DEFAULT '',
        adeli_code TEXT NOT NULL DEFAULT '',
        rpps_code TEXT NOT NULL DEFAULT '',
        ape_naf_code TEXT NOT NULL DEFAULT '',
        name_suffix_text TEXT NOT NULL DEFAULT '',
        letter_header TEXT NOT NULL DEFAULT '',
        letter_footer TEXT NOT NULL DEFAULT '',
        signature_text TEXT NOT NULL DEFAULT '',
        color_hex TEXT NOT NULL DEFAULT '#4d92d1',
        bank_name TEXT NOT NULL DEFAULT '',
        iban TEXT NOT NULL DEFAULT '',
        retrocession_percent REAL NOT NULL DEFAULT 0,
        retrocession_recipient TEXT NOT NULL DEFAULT '',
        default_agenda_view TEXT NOT NULL DEFAULT 'Semaine',
        visible_calendars TEXT NOT NULL DEFAULT 'Tous les calendriers',
        default_service TEXT NOT NULL DEFAULT 'Aucune prestation',
        invoice_mentions TEXT NOT NULL DEFAULT '',
        include_free_consultations INTEGER NOT NULL DEFAULT 1,
        show_consultation_hour INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL
      )
    `);

    db.exec(`
      INSERT INTO users_new (
        id, username, password_hash, role, is_active, profile_id, office_id,
        last_name, first_name, email, mobile_phone, country,
        siret, adeli_code, rpps_code, ape_naf_code, name_suffix_text,
        letter_header, letter_footer, signature_text, color_hex,
        bank_name, iban, retrocession_percent, retrocession_recipient,
        default_agenda_view, visible_calendars, default_service, invoice_mentions,
        include_free_consultations, show_consultation_hour,
        created_at
      )
      SELECT
        u.id,
        u.username,
        u.password_hash,
        coalesce(u.role, 'practitioner'),
        coalesce(u.is_active, 1),
        coalesce(nullif(trim(u.profile_id), ''), 'super-admin'),
        ${officeIdExpr},
        coalesce(u.last_name, ''),
        coalesce(u.first_name, ''),
        coalesce(u.email, ''),
        coalesce(u.mobile_phone, ''),
        coalesce(nullif(trim(u.country), ''), 'France'),
        coalesce(u.siret, ''),
        coalesce(u.adeli_code, ''),
        coalesce(u.rpps_code, ''),
        coalesce(u.ape_naf_code, ''),
        coalesce(u.name_suffix_text, ''),
        coalesce(u.letter_header, ''),
        coalesce(u.letter_footer, ''),
        coalesce(u.signature_text, ''),
        coalesce(nullif(trim(u.color_hex), ''), '#4d92d1'),
        coalesce(u.bank_name, ''),
        coalesce(u.iban, ''),
        coalesce(u.retrocession_percent, 0),
        coalesce(u.retrocession_recipient, ''),
        coalesce(nullif(trim(u.default_agenda_view), ''), 'Semaine'),
        coalesce(nullif(trim(u.visible_calendars), ''), 'Tous les calendriers'),
        coalesce(nullif(trim(u.default_service), ''), 'Aucune prestation'),
        coalesce(u.invoice_mentions, ''),
        1,
        1,
        ${createdAtExpr}
      FROM users u
    `);

    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  });

  db.pragma('foreign_keys = OFF');
  try {
    migration();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureUserOfficeLinks() {
  const users = db.prepare('SELECT id, office_id FROM users').all();

  for (const user of users) {
    const userId = Number(user.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      continue;
    }

    const linkedCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM user_offices WHERE user_id = ?').get(userId)?.count ?? 0
    );

    if (linkedCount > 0) {
      continue;
    }

    const officeId = Number(user.office_id);
    if (Number.isInteger(officeId) && officeId > 0) {
      db.prepare('INSERT OR IGNORE INTO user_offices (user_id, office_id) VALUES (?, ?)').run(userId, officeId);
    }
  }
}

function normalizeLegacySeedPatients() {
  // Keep this migration strictly scoped to known demo data to avoid touching real patient records.
  const seedProfiles = new Map([
    ['Claire Dubois', { name: 'DUBOIS Claire', sex: 'F' }],
    ['DUBOIS Claire', { name: 'DUBOIS Claire', sex: 'F' }],
    ['Yanis Martin', { name: 'MARTIN Yanis', sex: 'M' }],
    ['MARTIN Yanis', { name: 'MARTIN Yanis', sex: 'M' }],
    ['Nora Kacem', { name: 'KACEM Nora', sex: 'F' }],
    ['KACEME Nora', { name: 'KACEM Nora', sex: 'F' }],
    ['KACEM Nora', { name: 'KACEM Nora', sex: 'F' }],
    ['Lucas Bernard', { name: 'BERNARD Lucas', sex: 'M' }],
    ['BERNARD Lucas', { name: 'BERNARD Lucas', sex: 'M' }],
    ['Eva Morel', { name: 'MOREL Eva', sex: 'F' }],
    ['MOREL Eva', { name: 'MOREL Eva', sex: 'F' }],
    ['Mathis Giraud', { name: 'GIRAUD Mathis', sex: 'M' }],
    ['GIRAUD Mathis', { name: 'GIRAUD Mathis', sex: 'M' }],
    ['Selma Farhat', { name: 'FARHAT Selma', sex: 'F' }],
    ['FARHAT Selma', { name: 'FARHAT Selma', sex: 'F' }],
    ['Noe Lambert', { name: 'LAMBERT Noe', sex: 'M' }],
    ['LAMBERT Noe', { name: 'LAMBERT Noe', sex: 'M' }],
    ['Karim Ouali', { name: 'OUALI Karim', sex: 'M' }],
    ['OUALI Karim', { name: 'OUALI Karim', sex: 'M' }],
    ['Lea Roche', { name: 'ROCHE Lea', sex: 'F' }],
    ['ROCHE Lea', { name: 'ROCHE Lea', sex: 'F' }],
    ['Pierre Joly', { name: 'JOLY Pierre', sex: 'M' }],
    ['JOLY Pierre', { name: 'JOLY Pierre', sex: 'M' }],
    ['Ines Parent', { name: 'PARENT Ines', sex: 'F' }],
    ['PARENT Ines', { name: 'PARENT Ines', sex: 'F' }],
    ['Sofia Belkadi', { name: 'BELKADI Sofia', sex: 'F' }],
    ['BELKADI Sofia', { name: 'BELKADI Sofia', sex: 'F' }]
  ]);

  const updateName = db.prepare(
    `UPDATE patients
     SET cipher_full_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );

  const updateSex = db.prepare(
    `UPDATE patients
     SET sex = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );

  const updateNotes = db.prepare(
    `UPDATE patients
     SET cipher_medical_notes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );

  const normalizeLegacyNotes = (notesRaw, phoneRaw) => {
    const fallbackRemarks = String(notesRaw ?? '').trim();
    let parsedNotes = {};

    try {
      const candidate = JSON.parse(notesRaw);
      parsedNotes = candidate && typeof candidate === 'object' ? candidate : {};
    } catch {
      parsedNotes = {};
    }

    const mobilePhone = String(parsedNotes.mobilePhone ?? '').trim() || (phoneRaw !== 'Non renseigne' ? phoneRaw : '');
    const landlinePhone = String(parsedNotes.landlinePhone ?? '').trim();

    return {
      generalRemarks: String(parsedNotes.generalRemarks ?? fallbackRemarks).trim(),
      medicalHistory: String(parsedNotes.medicalHistory ?? '').trim(),
      consultationNote: String(parsedNotes.consultationNote ?? '').trim(),
      relatedPeople: formatRelatedPeople(parseRelatedPeople(String(parsedNotes.relatedPeople ?? ''))),
      mobilePhone,
      landlinePhone,
      email: String(parsedNotes.email ?? '').trim(),
      address1: String(parsedNotes.address1 ?? '').trim(),
      address2: String(parsedNotes.address2 ?? '').trim(),
      postalCode: String(parsedNotes.postalCode ?? '').trim(),
      city: String(parsedNotes.city ?? '').trim(),
      country: String(parsedNotes.country ?? '').trim() || 'France',
      isDeceased: Boolean(parsedNotes.isDeceased)
    };
  };

  const migrate = db.transaction(() => {
    const rows = db.prepare('SELECT id, cipher_full_name, cipher_phone, cipher_medical_notes, sex FROM patients WHERE is_deleted = 0').all();

    for (const row of rows) {
      let currentName;
      let currentPhone;
      let currentNotes;
      try {
        currentName = decryptSensitiveField(row.cipher_full_name);
        currentPhone = decryptSensitiveField(row.cipher_phone);
        currentNotes = decryptSensitiveField(row.cipher_medical_notes);
      } catch {
        continue;
      }

      const profile = seedProfiles.get(currentName);
      if (profile) {
        if (profile.name !== currentName) {
          updateName.run(encryptSensitiveField(profile.name), row.id);
        }

        if (row.sex !== profile.sex) {
          updateSex.run(profile.sex, row.id);
        }
      }

      const normalizedNotes = normalizeLegacyNotes(currentNotes, currentPhone);
      const normalizedNotesJson = JSON.stringify(normalizedNotes);

      if (normalizedNotesJson !== currentNotes) {
        updateNotes.run(encryptSensitiveField(normalizedNotesJson), row.id);
      }
    }
  });

  migrate();
}

async function ensureSeedData() {
  migrateUserPreferenceTable();

  ensureColumn('users', 'profile_id', "profile_id TEXT NOT NULL DEFAULT 'super-admin'");
  ensureColumn('users', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'office_id', 'office_id INTEGER');
  ensureColumn('users', 'last_name', "last_name TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'first_name', "first_name TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'email', "email TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'mobile_phone', "mobile_phone TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'country', "country TEXT NOT NULL DEFAULT 'France'");
  ensureColumn('users', 'siret', "siret TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'adeli_code', "adeli_code TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'rpps_code', "rpps_code TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'ape_naf_code', "ape_naf_code TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'name_suffix_text', "name_suffix_text TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'letter_header', "letter_header TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'letter_footer', "letter_footer TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'signature_text', "signature_text TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'color_hex', "color_hex TEXT NOT NULL DEFAULT '#4d92d1'");
  ensureColumn('users', 'bank_name', "bank_name TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'iban', "iban TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'retrocession_percent', 'retrocession_percent REAL NOT NULL DEFAULT 0');
  ensureColumn('users', 'retrocession_recipient', "retrocession_recipient TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'default_agenda_view', "default_agenda_view TEXT NOT NULL DEFAULT 'Semaine'");
  ensureColumn('users', 'visible_calendars', "visible_calendars TEXT NOT NULL DEFAULT 'Tous les calendriers'");
  ensureColumn('users', 'default_service', "default_service TEXT NOT NULL DEFAULT 'Aucune prestation'");
  ensureColumn('users', 'invoice_mentions', "invoice_mentions TEXT NOT NULL DEFAULT ''");
  ensureColumn('appointments', 'local_calendar_id', 'local_calendar_id INTEGER');
  ensureColumn('appointments', 'consultation_id', 'consultation_id INTEGER');
  ensureColumn('local_calendars', 'description', "description TEXT NOT NULL DEFAULT ''");
  ensureColumn('local_calendars', 'color_hex', "color_hex TEXT NOT NULL DEFAULT '#4d92d1'");
  ensureColumn('local_calendars', 'is_visible_to_all', 'is_visible_to_all INTEGER NOT NULL DEFAULT 1');
  ensureColumn('local_calendars', 'visible_user_ids', "visible_user_ids TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('local_calendars', 'office_id', 'office_id INTEGER');
  ensureColumn('local_calendars', 'display_order', 'display_order INTEGER NOT NULL DEFAULT 0');
  ensureColumn('local_calendars', 'updated_at', 'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');
  ensureColumn('offices', 'default_session_duration_minutes', 'default_session_duration_minutes INTEGER NOT NULL DEFAULT 60');
  ensureColumn('offices', 'country', "country TEXT NOT NULL DEFAULT 'France'");
  ensureColumn('offices', 'devise', "devise TEXT NOT NULL DEFAULT 'EUR'");
  ensureColumn('offices', 'invoice_number_format', "invoice_number_format TEXT NOT NULL DEFAULT 'AAAA-XXXXXX'");
  ensureColumn('offices', 'invoice_numbering_configuration', "invoice_numbering_configuration TEXT NOT NULL DEFAULT 'Numérotation globale au cabinet'");
  ensureColumn('offices', 'invoice_show_insurance_fields', 'invoice_show_insurance_fields INTEGER NOT NULL DEFAULT 0');
  ensureColumn('offices', 'invoice_hide_vat_mention', 'invoice_hide_vat_mention INTEGER NOT NULL DEFAULT 0');
  ensureColumn('offices', 'opening_hours_json', `opening_hours_json TEXT NOT NULL DEFAULT '{"monday":[],"tuesday":[],"wednesday":[],"thursday":[],"friday":[],"saturday":[],"sunday":[]}'`);
  ensureColumn('service_types', 'office_id', 'office_id INTEGER');
  ensureColumn('payment_methods', 'office_id', 'office_id INTEGER');
  ensureColumn('user_preference', 'slot_duration_minutes', 'slot_duration_minutes INTEGER NOT NULL DEFAULT 15');
  ensureColumn('user_preference', 'display_height', 'display_height INTEGER NOT NULL DEFAULT 14');

  const fallbackOffice = db.prepare('SELECT id FROM offices ORDER BY display_order ASC, id ASC LIMIT 1').get();
  const defaultOfficeCountry = getConfigValue('settings_general_country', 'France');
  const defaultOfficeDevise = normalizeOfficeDevise(getConfigValue('settings_general_devise', 'EUR'));
  const defaultOfficeInvoiceNumberFormat = normalizeOfficeInvoiceNumberFormat(
    getConfigValue('settings_invoice_number_format', 'AAAA-XXXXXX')
  );
  const defaultOfficeInvoiceNumberingConfiguration = normalizeOfficeInvoiceNumberingConfiguration(
    getConfigValue('settings_invoice_numbering_configuration', 'Numérotation globale au cabinet')
  );
  const defaultOfficeInvoiceShowInsuranceFields = getConfigBoolean('settings_invoice_show_insurance_fields', false) ? 1 : 0;
  const defaultOfficeInvoiceHideVatMention = getConfigBoolean('settings_invoice_hide_vat_mention', false) ? 1 : 0;
  db.prepare(
    `UPDATE offices
     SET country = CASE WHEN country IS NULL OR trim(country) = '' THEN ? ELSE country END,
         devise = CASE WHEN devise IN ('EUR', 'USD', 'CHF', 'GBP', 'CAD') THEN devise ELSE ? END,
         invoice_number_format = CASE WHEN trim(coalesce(invoice_number_format, '')) = '' THEN ? ELSE invoice_number_format END,
         invoice_numbering_configuration = CASE WHEN trim(coalesce(invoice_numbering_configuration, '')) = '' THEN ? ELSE invoice_numbering_configuration END,
         invoice_show_insurance_fields = CASE WHEN invoice_show_insurance_fields IN (0, 1) THEN invoice_show_insurance_fields ELSE ? END,
         invoice_hide_vat_mention = CASE WHEN invoice_hide_vat_mention IN (0, 1) THEN invoice_hide_vat_mention ELSE ? END`
  ).run(
    defaultOfficeCountry,
    defaultOfficeDevise,
    defaultOfficeInvoiceNumberFormat,
    defaultOfficeInvoiceNumberingConfiguration,
    defaultOfficeInvoiceShowInsuranceFields,
    defaultOfficeInvoiceHideVatMention
  );

  if (fallbackOffice?.id) {
    db.prepare('UPDATE local_calendars SET office_id = ? WHERE office_id IS NULL').run(Number(fallbackOffice.id));
    db.prepare('UPDATE service_types SET office_id = ? WHERE office_id IS NULL').run(Number(fallbackOffice.id));
    db.prepare('UPDATE payment_methods SET office_id = ? WHERE office_id IS NULL').run(Number(fallbackOffice.id));
  }

  ensureColumn('user_preference', 'pdf_display_mode', "pdf_display_mode TEXT NOT NULL DEFAULT 'browser'");
  ensureColumn('user_preference', 'consultation_order', "consultation_order TEXT NOT NULL DEFAULT 'Antichronologique'");
  ensureColumn('user_preference', 'group_consultations_by_year_from', 'group_consultations_by_year_from INTEGER NOT NULL DEFAULT 10');
  ensureColumn('user_preference', 'patient_auto_save_frequency', "patient_auto_save_frequency TEXT NOT NULL DEFAULT 'Toutes les 2 minutes'");

  const defaultConsultationOrder = getConfigValue('settings_consultation_order', 'Antichronologique');
  const defaultGroupConsultationsByYearFrom = getConfigInteger('settings_group_consultations_by_year_from', 10);
  const defaultPatientAutoSaveFrequency = getConfigValue('settings_patient_auto_save_frequency', 'Toutes les 2 minutes');

  db.prepare(`
    INSERT OR IGNORE INTO user_preference (
      user_id,
      slot_duration_minutes,
      display_height,
      pdf_display_mode,
      consultation_order,
      group_consultations_by_year_from,
      patient_auto_save_frequency,
      show_weekend,
      show_patient_sex,
      show_patient_mobile_phone,
      show_patient_landline_phone,
      show_appointment_comment,
      patient_remarks_display,
      appointment_color_mode
    )
    SELECT id,
           15,
           14,
          'browser',
          ?,
          ?,
          ?,
           CASE WHEN role = 'admin' THEN 1 ELSE 0 END,
           1,
           1,
           0,
           1,
           'hidden',
           'calendar'
    FROM users
  `).run(defaultConsultationOrder, defaultGroupConsultationsByYearFrom, defaultPatientAutoSaveFrequency);

  db.prepare(`
    UPDATE user_preference
    SET
      slot_duration_minutes = CASE
        WHEN slot_duration_minutes BETWEEN 5 AND 50 THEN slot_duration_minutes
        ELSE 15
      END,
      display_height = CASE
        WHEN display_height BETWEEN 14 AND 35 THEN display_height
        ELSE 14
      END,
      pdf_display_mode = CASE
        WHEN pdf_display_mode IN ('browser', 'download') THEN pdf_display_mode
        ELSE 'browser'
      END,
      consultation_order = CASE
        WHEN consultation_order IN ('Chronologique', 'Antichronologique') THEN consultation_order
        ELSE 'Antichronologique'
      END,
      group_consultations_by_year_from = CASE
        WHEN group_consultations_by_year_from BETWEEN 0 AND 200 THEN group_consultations_by_year_from
        ELSE 10
      END,
      patient_auto_save_frequency = CASE
        WHEN patient_auto_save_frequency IN ('Jamais', 'Toutes les 2 minutes', 'Toutes les 5 minutes', 'Toutes les 10 minutes') THEN patient_auto_save_frequency
        ELSE 'Toutes les 2 minutes'
      END,
      show_weekend = CASE WHEN show_weekend = 1 THEN 1 ELSE 0 END,
      show_patient_sex = CASE WHEN show_patient_sex = 1 THEN 1 ELSE 0 END,
      show_patient_mobile_phone = CASE WHEN show_patient_mobile_phone = 1 THEN 1 ELSE 0 END,
      show_patient_landline_phone = CASE WHEN show_patient_landline_phone = 1 THEN 1 ELSE 0 END,
      show_appointment_comment = CASE WHEN show_appointment_comment = 1 THEN 1 ELSE 0 END,
      patient_remarks_display = CASE
        WHEN patient_remarks_display IN ('hidden', 'edit', 'readonly') THEN patient_remarks_display
        ELSE 'hidden'
      END,
      appointment_color_mode = CASE
        WHEN appointment_color_mode IN ('calendar', 'user') THEN appointment_color_mode
        ELSE 'calendar'
      END
  `).run();
  migrateUsersOfficeForeignKey();
  ensureUserOfficeLinks();
  ensureColumn('patients', 'sex', "sex TEXT NOT NULL DEFAULT 'Non renseigne'");
  ensureColumn('patients', 'birth_date', 'birth_date TEXT');
  normalizeLegacySeedPatients();
  ensureDefaultLocalCalendars();

  const superAdminProfileId = 'super-admin';
  const superAdminRightsJson = JSON.stringify(buildAccessRights(true));

  const existingSuperAdminProfile = db
    .prepare('SELECT id, rights_json FROM access_profiles WHERE id = ?')
    .get(superAdminProfileId);

  if (!existingSuperAdminProfile) {
    db.prepare(
      `INSERT INTO access_profiles (id, label, description, rights_json, immutable)
       VALUES (?, ?, ?, ?, 1)`
    ).run(
      superAdminProfileId,
      'Super Administrateur',
      'Profil système avec tous les droits activés par défaut.',
      superAdminRightsJson
    );
  } else {
    let parsedRights;
    try {
      parsedRights = JSON.parse(existingSuperAdminProfile.rights_json);
    } catch {
      parsedRights = {};
    }

    const normalizedRights = normalizeAccessRights(parsedRights, true);
    db.prepare(
      `UPDATE access_profiles
       SET label = ?,
           description = ?,
           rights_json = ?,
           immutable = 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      'Super Administrateur',
      'Profil système avec tous les droits activés par défaut.',
      JSON.stringify(normalizedRights),
      superAdminProfileId
    );
  }

  const defaultAccessProfiles = [
    {
      id: 'assistant',
      label: 'Assistant',
      description: 'Accueil patient, consultation simple et agenda.',
      immutable: 0,
      rights: buildAccessRightsForPermissions([
        'read-patient-record',
        'create-consultation',
        'read-consultation-detail',
        'read-patient-list',
        'search-patient-list',
        'read-agenda',
        'create-appointment',
        'edit-appointment'
      ])
    },
    {
      id: 'secretariat',
      label: 'Secrétariat',
      description: 'Gestion administrative des patients et du planning.',
      immutable: 0,
      rights: buildAccessRightsForPermissions([
        'read-patient-record',
        'create-patient-record',
        'read-patient-list',
        'search-patient-list',
        'export-patient-list',
        'read-agenda',
        'create-appointment',
        'edit-appointment',
        'delete-appointment',
        'read-directory',
        'create-directory-contact',
        'edit-directory-contact',
        'export-directory'
      ])
    },
    {
      id: 'comptabilite',
      label: 'Comptabilité',
      description: 'Suivi financier, facturation et exports comptables.',
      immutable: 0,
      rights: buildAccessRightsForPermissions([
        'read-billing-kpis',
        'create-invoice',
        'mark-payment',
        'export-billing',
        'invoice-consultation',
        'cancel-invoice',
        'read-patient-list',
        'search-patient-list'
      ])
    }
  ];

  const upsertAccessProfile = db.prepare(
    `INSERT INTO access_profiles (id, label, description, rights_json, immutable, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id)
     DO UPDATE SET label = excluded.label,
                   description = excluded.description,
                   rights_json = excluded.rights_json,
                   immutable = excluded.immutable,
                   updated_at = CURRENT_TIMESTAMP`
  );

  for (const profile of defaultAccessProfiles) {
    upsertAccessProfile.run(
      profile.id,
      profile.label,
      profile.description,
      JSON.stringify(profile.rights),
      profile.immutable
    );
  }

  db.prepare(
    `UPDATE users
     SET profile_id = ?
     WHERE profile_id IS NULL OR trim(profile_id) = ''`
  ).run(superAdminProfileId);

  const defaultAntecedentTypes = [
    'Psychologie',
    'Traitement medical',
    'Hospitalisation',
    'Chirurgie',
    'Allergie',
    'Accident',
    'Pathologie chronique',
    'Antecedent familial'
  ];

  const upsertAntecedentType = db.prepare(
    'INSERT OR IGNORE INTO antecedent_types (label) VALUES (?)'
  );

  const seedAntecedentTypes = db.transaction((labels) => {
    for (const label of labels) {
      upsertAntecedentType.run(label);
    }
  });

  seedAntecedentTypes(defaultAntecedentTypes);

  const existingConfig = db.prepare('SELECT value FROM config WHERE key = ?').get('app_name');

  if (!existingConfig) {
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('app_name', 'OsteoSoft');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('version', '0.0.2');
  }

  const defaultSettingConfig = [
    ['settings_pdf_display_mode', 'browser'],
    ['settings_backup_reminder_frequency', 'Toutes les semaines'],
    ['settings_consultation_order', 'Antichronologique'],
    ['settings_group_consultations_by_year_from', '10'],
    ['settings_patient_auto_save_frequency', 'Toutes les 2 minutes'],
    ['settings_include_free_consultations', '1'],
    ['settings_show_consultation_hour', '1']
  ];

  for (const [key, value] of defaultSettingConfig) {
    db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, value);
  }

  const officesForBusinessSettings = db.prepare('SELECT id FROM offices ORDER BY display_order ASC, id ASC').all();
  const seedServiceType = db.prepare(
    `INSERT INTO service_types (office_id, label, amount_ht_cents, vat_rate, display_order)
     VALUES (?, ?, ?, ?, ?)`
  );
  const seedPaymentMethod = db.prepare(
    `INSERT INTO payment_methods (office_id, label, is_active, display_order)
     VALUES (?, ?, ?, ?)`
  );

  const defaultServiceTypes = [
    ['Consultation ostéopathique', 6000, 0, 1],
    ['Consultation pédiatrique', 5500, 0, 2],
    ['Consultation d\'urgence', 7500, 0, 3]
  ];

  const defaultPaymentMethods = [
    ['Carte bancaire', 1, 1],
    ['Espèces', 1, 2],
    ['Chèque', 1, 3],
    ['Virement', 1, 4]
  ];

  for (const office of officesForBusinessSettings) {
    const officeId = Number(office.id);
    if (!Number.isInteger(officeId) || officeId <= 0) {
      continue;
    }

    const officeServiceTypeCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM service_types WHERE office_id = ?').get(officeId)?.count ?? 0
    );
    if (officeServiceTypeCount === 0) {
      for (const [label, amountHtCents, vatRate, displayOrder] of defaultServiceTypes) {
        seedServiceType.run(officeId, label, amountHtCents, vatRate, displayOrder);
      }
    }

    const officePaymentMethodCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM payment_methods WHERE office_id = ?').get(officeId)?.count ?? 0
    );
    if (officePaymentMethodCount === 0) {
      for (const [label, isActive, displayOrder] of defaultPaymentMethods) {
        seedPaymentMethod.run(officeId, label, isActive, displayOrder);
      }
    }
  }

  const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');

  if (!existingAdmin) {
    const passwordHash = await argon2.hash('admin', {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      'admin',
      passwordHash,
      'admin'
    );
  }

  db.prepare('UPDATE users SET profile_id = ? WHERE username = ?').run(superAdminProfileId, 'admin');

  const testUsers = [
    {
      username: 'assistant',
      password: 'assistant',
      role: 'assistant',
      profileId: 'assistant'
    },
    {
      username: 'secretariat',
      password: 'secretariat',
      role: 'secretariat',
      profileId: 'secretariat'
    },
    {
      username: 'compta',
      password: 'compta',
      role: 'comptabilite',
      profileId: 'comptabilite'
    }
  ];

  const existingUsers = db.prepare('SELECT id, username FROM users').all();
  const existingByUsername = new Map(existingUsers.map((row) => [row.username, row]));

  for (const userSeed of testUsers) {
    const existing = existingByUsername.get(userSeed.username);
    if (!existing) {
      const passwordHash = await argon2.hash(userSeed.password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16,
        timeCost: 3,
        parallelism: 1
      });

      db.prepare(
        'INSERT INTO users (username, password_hash, role, profile_id) VALUES (?, ?, ?, ?)'
      ).run(userSeed.username, passwordHash, userSeed.role, userSeed.profileId);
    } else {
      db.prepare('UPDATE users SET role = ?, profile_id = ? WHERE id = ?').run(
        userSeed.role,
        userSeed.profileId,
        existing.id
      );
    }
  }

  const patientCount = db.prepare('SELECT COUNT(*) as count FROM patients').get().count;

  if (patientCount === 0) {
    const insertPatient = db.prepare(
      `INSERT INTO patients
       (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, last_visit, consent_signed, retention_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const inserted = [
      {
        name: 'DUBOIS Claire',
        phone: '06 44 81 00 23',
        notes: 'Lombalgie chronique. Exercices domiciliaires recommandes.',
        sex: 'F',
        birthDate: '1988-06-14',
        visit: '2026-04-08'
      },
      {
        name: 'MARTIN Yanis',
        phone: '06 81 17 94 52',
        notes: 'Suivi sportif: genou droit.',
        sex: 'M',
        birthDate: '1995-02-03',
        visit: '2026-04-12'
      },
      {
        name: 'KACEM Nora',
        phone: '07 62 50 02 18',
        notes: 'Cervicalgies posturales.',
        sex: 'F',
        birthDate: '1979-11-25',
        visit: '2026-04-14'
      }
    ].map((patient) =>
      insertPatient.run(
        encryptSensitiveField(patient.name),
        encryptSensitiveField(patient.phone),
        encryptSensitiveField(patient.notes),
        patient.sex,
        patient.birthDate,
        patient.visit,
        1,
        '2031-12-31'
      ).lastInsertRowid
    );

    const insertAppointment = db.prepare(
      'INSERT INTO appointments (patient_id, starts_at, reason_cipher, status) VALUES (?, ?, ?, ?)'
    );

    insertAppointment.run(
      inserted[0],
      '2026-04-15T08:30:00.000Z',
      encryptSensitiveField('Lombalgie'),
      'A confirmer'
    );
    insertAppointment.run(
      inserted[1],
      '2026-04-15T09:15:00.000Z',
      encryptSensitiveField('Suivi sportif'),
      'En attente'
    );
    insertAppointment.run(
      inserted[2],
      '2026-04-15T10:00:00.000Z',
      encryptSensitiveField('Douleur cervicale'),
      'Termine'
    );

    const insertInvoice = db.prepare(
      `INSERT INTO invoices
       (patient_id, invoice_number, amount_cents, status, issued_at, due_at, notes_cipher)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    insertInvoice.run(
      inserted[0],
      'FAC-2026-0415-001',
      7000,
      'payee',
      '2026-04-03',
      '2026-04-03',
      encryptSensitiveField('Consultation osteopathie')
    );
    insertInvoice.run(
      inserted[1],
      'FAC-2026-0415-002',
      6500,
      'impayee',
      '2026-04-12',
      '2026-04-22',
      encryptSensitiveField('Seance de suivi')
    );
  }

  const activePatientCount = db
    .prepare('SELECT COUNT(*) as count FROM patients WHERE is_deleted = 0')
    .get().count;

  if (activePatientCount < 12) {
    const additionalPatients = [
      {
        name: 'BERNARD Lucas',
        phone: '06 83 11 03 88',
        notes: 'Suivi postural.',
        sex: 'M',
        birthDate: '1991-08-10',
        visit: '2026-03-20',
        startsAt: '2026-03-20T15:30:00.000Z',
        reason: 'Suivi postural',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-001',
        amountCents: 6200,
        invoiceStatus: 'payee',
        dueAt: '2026-03-25'
      },
      {
        name: 'MOREL Eva',
        phone: '07 45 21 99 70',
        notes: 'Douleur thoracique fonctionnelle.',
        sex: 'F',
        birthDate: '1982-03-04',
        visit: '2026-03-28',
        startsAt: '2026-03-28T09:45:00.000Z',
        reason: 'Douleur thoracique',
        status: 'A confirmer',
        invoiceNumber: 'FAC-2026-DASH-002',
        amountCents: 6800,
        invoiceStatus: 'impayee',
        dueAt: '2026-04-10'
      },
      {
        name: 'GIRAUD Mathis',
        phone: '07 57 03 26 41',
        notes: 'Entorse cheville en reprise.',
        sex: 'M',
        birthDate: '2000-01-17',
        visit: '2026-02-14',
        startsAt: '2026-02-14T11:15:00.000Z',
        reason: 'Entorse cheville',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-003',
        amountCents: 6000,
        invoiceStatus: 'payee',
        dueAt: '2026-02-18'
      },
      {
        name: 'FARHAT Selma',
        phone: '06 91 12 42 21',
        notes: 'Migraine cervico-genique.',
        sex: 'F',
        birthDate: '1973-09-30',
        visit: '2026-01-23',
        startsAt: '2026-01-23T08:15:00.000Z',
        reason: 'Migraine',
        status: 'En attente',
        invoiceNumber: 'FAC-2026-DASH-004',
        amountCents: 7200,
        invoiceStatus: 'impayee',
        dueAt: '2026-02-02'
      },
      {
        name: 'LAMBERT Noe',
        phone: '06 99 62 15 13',
        notes: 'Suivi scoliose.',
        sex: 'M',
        birthDate: '2008-12-11',
        visit: '2025-12-17',
        startsAt: '2025-12-17T16:00:00.000Z',
        reason: 'Suivi scoliose',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-005',
        amountCents: 5800,
        invoiceStatus: 'payee',
        dueAt: '2025-12-20'
      },
      {
        name: 'OUALI Karim',
        phone: '07 82 12 80 72',
        notes: 'Lombalgie aigue.',
        sex: 'M',
        birthDate: '1986-07-22',
        visit: '2025-11-04',
        startsAt: '2025-11-04T10:30:00.000Z',
        reason: 'Lombalgie',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-006',
        amountCents: 7000,
        invoiceStatus: 'impayee',
        dueAt: '2025-11-12'
      },
      {
        name: 'ROCHE Lea',
        phone: '06 59 61 18 33',
        notes: 'Consultation preventive.',
        sex: 'F',
        birthDate: '1999-10-09',
        visit: '2025-10-19',
        startsAt: '2025-10-19T13:20:00.000Z',
        reason: 'Consultation preventive',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-007',
        amountCents: 6400,
        invoiceStatus: 'payee',
        dueAt: '2025-10-24'
      },
      {
        name: 'JOLY Pierre',
        phone: '06 25 44 80 56',
        notes: 'Tensions dorsales.',
        sex: 'M',
        birthDate: '1968-05-27',
        visit: '2025-09-07',
        startsAt: '2025-09-07T09:00:00.000Z',
        reason: 'Tensions dorsales',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-008',
        amountCents: 7600,
        invoiceStatus: 'impayee',
        dueAt: '2025-09-18'
      },
      {
        name: 'PARENT Ines',
        phone: '07 66 88 73 19',
        notes: 'Suivi postpartum.',
        sex: 'F',
        birthDate: '1993-04-02',
        visit: '2025-08-12',
        startsAt: '2025-08-12T14:15:00.000Z',
        reason: 'Suivi postpartum',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-009',
        amountCents: 6900,
        invoiceStatus: 'payee',
        dueAt: '2025-08-20'
      },
      {
        name: 'BELKADI Sofia',
        phone: '06 77 08 15 91',
        notes: 'Douleurs de hanche.',
        sex: 'F',
        birthDate: '1959-01-19',
        visit: '2025-07-01',
        startsAt: '2025-07-01T08:40:00.000Z',
        reason: 'Douleurs de hanche',
        status: 'Termine',
        invoiceNumber: 'FAC-2026-DASH-010',
        amountCents: 7300,
        invoiceStatus: 'impayee',
        dueAt: '2025-07-12'
      }
    ];

    const slotsToFill = Math.min(12 - activePatientCount, additionalPatients.length);
    const insertPatient = db.prepare(
      `INSERT INTO patients
       (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, last_visit, consent_signed, retention_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAppointment = db.prepare(
      'INSERT INTO appointments (patient_id, starts_at, reason_cipher, status) VALUES (?, ?, ?, ?)'
    );
    const insertInvoice = db.prepare(
      `INSERT INTO invoices
       (patient_id, invoice_number, amount_cents, status, issued_at, due_at, notes_cipher)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const patient of additionalPatients.slice(0, slotsToFill)) {
      const insertedPatientId = insertPatient.run(
        encryptSensitiveField(patient.name),
        encryptSensitiveField(patient.phone),
        encryptSensitiveField(patient.notes),
        patient.sex,
        patient.birthDate,
        patient.visit,
        1,
        '2031-12-31'
      ).lastInsertRowid;

      insertAppointment.run(
        insertedPatientId,
        patient.startsAt,
        encryptSensitiveField(patient.reason),
        patient.status
      );

      insertInvoice.run(
        insertedPatientId,
        patient.invoiceNumber,
        patient.amountCents,
        patient.invoiceStatus,
        patient.visit,
        patient.dueAt,
        encryptSensitiveField(patient.reason)
      );
    }
  }
}

function formatDateFr(value) {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(value));
}

function getAgeRangeFromBirthDate(birthDate) {
  if (!birthDate) {
    return 'Non renseigne';
  }

  const date = new Date(birthDate);
  if (Number.isNaN(date.getTime())) {
    return 'Non renseigne';
  }

  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) {
    age -= 1;
  }

  if (age < 18) {
    return '0-17';
  }
  if (age < 30) {
    return '18-29';
  }
  if (age < 45) {
    return '30-44';
  }
  if (age < 60) {
    return '45-59';
  }
  return '60+';
}

function getAgeFromBirthDate(birthDate) {
  if (!birthDate) {
    return null;
  }

  const date = new Date(birthDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) {
    age -= 1;
  }

  return age >= 0 ? age : null;
}

function extractAntecedentCategories(medicalHistoryRaw) {
  const raw = String(medicalHistoryRaw ?? '').trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => (typeof item?.category === 'string' ? item.category.trim() : ''))
      .filter((category) => category.length > 0)
      .slice(0, 200);
  } catch {
    return [];
  }
}

function normalizePersonNameKey(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseRelatedPeople(raw) {
  const seen = new Set();
  const names = [];

  for (const part of String(raw ?? '').split(',')) {
    const normalizedLabel = String(part).trim().replace(/\s+/g, ' ');
    if (!normalizedLabel) continue;

    const key = normalizePersonNameKey(normalizedLabel);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    names.push(normalizedLabel);
  }

  return names;
}

function formatRelatedPeople(names) {
  return parseRelatedPeople(names.join(', ')).join(', ');
}

function normalizeManualPreference(value) {
  const raw = String(value ?? '').trim();
  if (raw === 'Droitier' || raw === 'Gaucher') {
    return raw;
  }
  return 'Non renseigne';
}

function synchronizeBidirectionalRelatedPeople({
  targetPatientId,
  targetCurrentFullName,
  targetPreviousFullName,
  previousRelatedPeople,
  nextRelatedPeople
}) {
  const targetKey = normalizePersonNameKey(targetCurrentFullName);
  if (!targetKey) {
    return;
  }

  const targetPreviousKey = normalizePersonNameKey(targetPreviousFullName);
  const previousNames = parseRelatedPeople(previousRelatedPeople);
  const nextNames = parseRelatedPeople(nextRelatedPeople);
  const previousSet = new Set(previousNames.map((name) => normalizePersonNameKey(name)));
  const nextSet = new Set(nextNames.map((name) => normalizePersonNameKey(name)));

  const namesToAdd = nextNames.filter((name) => !previousSet.has(normalizePersonNameKey(name)));
  const namesToRemove = previousNames.filter((name) => !nextSet.has(normalizePersonNameKey(name)));

  const rows = db
    .prepare(
      `SELECT id, cipher_full_name, cipher_medical_notes
       FROM patients
       WHERE is_deleted = 0 AND id != ?`
    )
    .all(targetPatientId);

  const byName = new Map();
  const byId = new Map();

  for (const row of rows) {
    let fullName;
    let notes;

    try {
      fullName = decryptSensitiveField(row.cipher_full_name);
      notes = JSON.parse(decryptSensitiveField(row.cipher_medical_notes)) ?? {};
    } catch {
      continue;
    }

    const key = normalizePersonNameKey(fullName);
    if (!key) continue;

    if (!byName.has(key)) {
      byName.set(key, []);
    }
    byName.get(key).push({ id: row.id, notes });
    byId.set(row.id, { key, notes });
  }

  const modified = new Map();

  const ensureRow = (rowId) => {
    if (modified.has(rowId)) return modified.get(rowId);
    const source = byId.get(rowId);
    if (!source) return null;
    const clonedNotes = { ...source.notes };
    modified.set(rowId, clonedNotes);
    return clonedNotes;
  };

  for (const name of namesToAdd) {
    const rowsForName = byName.get(normalizePersonNameKey(name)) ?? [];
    for (const row of rowsForName) {
      const notes = ensureRow(row.id);
      if (!notes) continue;
      const linkedNames = parseRelatedPeople(notes.relatedPeople ?? '');
      if (!linkedNames.some((entry) => normalizePersonNameKey(entry) === targetKey)) {
        linkedNames.push(targetCurrentFullName);
      }
      notes.relatedPeople = formatRelatedPeople(linkedNames);
    }
  }

  for (const name of namesToRemove) {
    const rowsForName = byName.get(normalizePersonNameKey(name)) ?? [];
    for (const row of rowsForName) {
      const notes = ensureRow(row.id);
      if (!notes) continue;
      const linkedNames = parseRelatedPeople(notes.relatedPeople ?? '').filter(
        (entry) => normalizePersonNameKey(entry) !== targetKey
      );
      notes.relatedPeople = formatRelatedPeople(linkedNames);
    }
  }

  const previousBackReferenceWasDifferent = targetPreviousKey && targetPreviousKey !== targetKey;
  if (previousBackReferenceWasDifferent) {
    for (const row of rows) {
      const notes = ensureRow(row.id);
      if (!notes) continue;

      const linkedNames = parseRelatedPeople(notes.relatedPeople ?? '');
      let changed = false;

      for (let idx = 0; idx < linkedNames.length; idx += 1) {
        if (normalizePersonNameKey(linkedNames[idx]) === targetPreviousKey) {
          linkedNames[idx] = targetCurrentFullName;
          changed = true;
        }
      }

      if (changed) {
        notes.relatedPeople = formatRelatedPeople(linkedNames);
      }
    }
  }

  const updateNotes = db.prepare(
    `UPDATE patients
     SET cipher_medical_notes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );

  for (const [rowId, notes] of modified.entries()) {
    updateNotes.run(encryptSensitiveField(JSON.stringify(notes)), rowId);
  }
}

function getDefaultCalendarForUser(userId) {
  const accessibleCalendarIds = getAccessibleCalendarIdsForUser(userId, null);
  if (!accessibleCalendarIds.length) {
    return null;
  }

  const placeholders = accessibleCalendarIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT id, office_id
       FROM local_calendars
       WHERE id IN (${placeholders})
       ORDER BY display_order ASC, id ASC
       LIMIT 1`
    )
    .get(...accessibleCalendarIds);

  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    officeId: row.office_id != null ? Number(row.office_id) : null
  };
}

function getFirstOpeningMinute(openingHours, date) {
  const dayKey = OFFICE_OPENING_DAY_KEYS[(date.getDay() + 6) % 7];
  const ranges = Array.isArray(openingHours?.[dayKey]) ? openingHours[dayKey] : [];
  if (!ranges.length) {
    return 9 * 60;
  }

  const start = String(ranges[0]?.start ?? '').trim();
  const [hoursRaw, minutesRaw] = start.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return 9 * 60;
  }
  return Math.min(Math.max((hours * 60) + minutes, 0), 23 * 60 + 59);
}

function alignDateToOfficeSlot(date, firstOpeningMinute, slotDurationMinutes) {
  const aligned = new Date(date);
  const targetMinutes = (aligned.getHours() * 60) + aligned.getMinutes();
  const boundedTarget = Math.max(targetMinutes, firstOpeningMinute);
  const offset = boundedTarget - firstOpeningMinute;
  const slotIndex = Math.floor(offset / slotDurationMinutes);
  const alignedMinutes = firstOpeningMinute + (slotIndex * slotDurationMinutes);

  aligned.setHours(Math.floor(alignedMinutes / 60), alignedMinutes % 60, 0, 0);
  return aligned;
}

function findOverlappingAppointmentForPatient(patientId, localCalendarId, startsAtIso, durationMinutes) {
  const startDate = new Date(startsAtIso);
  if (Number.isNaN(startDate.getTime())) {
    return null;
  }
  const endDate = new Date(startDate.getTime() + (durationMinutes * 60 * 1000));

  const rows = db
    .prepare(
      `SELECT id, starts_at
       FROM appointments
       WHERE patient_id = ?
         AND ((local_calendar_id IS NULL AND ? IS NULL) OR local_calendar_id = ?)
       ORDER BY datetime(starts_at) ASC, id ASC`
    )
    .all(patientId, localCalendarId, localCalendarId);

  for (const row of rows) {
    const currentStart = new Date(row.starts_at);
    if (Number.isNaN(currentStart.getTime())) {
      continue;
    }
    const currentEnd = new Date(currentStart.getTime() + (durationMinutes * 60 * 1000));
    if (currentStart < endDate && currentEnd > startDate) {
      return Number(row.id);
    }
  }

  return null;
}

function insertConsultationFromNote(patientId, consultationNoteRaw, options = {}) {
  const raw = String(consultationNoteRaw ?? '').trim();
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  const hasContent =
    String(data.title ?? '').trim() ||
    String(data.motifMainHtml ?? '').trim() ||
    String(data.testsHtml ?? '').trim() ||
    String(data.schemaHtml ?? '').trim() ||
    String(data.treatmentsHtml ?? '').trim() ||
    String(data.remarksHtml ?? '').trim();

  if (!hasContent) return null;

  const userId = Number(options.userId);
  const linkStrategy = options.linkStrategy === 'create-new' ? 'create-new' : 'attach-existing';

  let localCalendarId = null;
  let slotDurationMinutes = 60;
  let alignedStartIso = String(data.startedAt ?? new Date().toISOString());

  if (Number.isInteger(userId) && userId > 0) {
    const defaultCalendar = getDefaultCalendarForUser(userId);
    if (defaultCalendar) {
      localCalendarId = defaultCalendar.id;
      if (defaultCalendar.officeId != null) {
        const office = db
          .prepare(
            `SELECT default_session_duration_minutes AS durationMinutes, opening_hours_json AS openingHoursJson
             FROM offices
             WHERE id = ?`
          )
          .get(defaultCalendar.officeId);

        slotDurationMinutes = normalizeOfficeDefaultSessionDurationMinutes(office?.durationMinutes);

        const sourceDate = new Date(String(data.startedAt ?? new Date().toISOString()));
        if (!Number.isNaN(sourceDate.getTime())) {
          const openingHours = parseOfficeOpeningHours(office?.openingHoursJson);
          const firstOpeningMinute = getFirstOpeningMinute(openingHours, sourceDate);
          const alignedDate = alignDateToOfficeSlot(sourceDate, firstOpeningMinute, slotDurationMinutes);
          alignedStartIso = alignedDate.toISOString();
        }
      }
    }
  }

  try {
    const createdConsultation = db.prepare(`
      INSERT INTO consultations
        (patient_id, started_at, practitioner, title, important, height_cm, weight_kg,
         eva_before, eva_after, profile,
         motif_main_cipher, tests_cipher, schema_cipher, treatments_cipher, remarks_cipher)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      patientId,
      alignedStartIso,
      String(data.practitioner ?? '').trim(),
      String(data.title ?? '').trim(),
      data.important ? 1 : 0,
      typeof data.heightCm === 'number' ? data.heightCm : null,
      typeof data.weightKg === 'number' ? data.weightKg : null,
      typeof data.evaBefore === 'number' ? data.evaBefore : 0,
      typeof data.evaAfter === 'number' ? data.evaAfter : 0,
      String(data.profile ?? 'Adulte').trim() || 'Adulte',
      data.motifMainHtml ? encryptSensitiveField(data.motifMainHtml) : null,
      data.testsHtml ? encryptSensitiveField(data.testsHtml) : null,
      data.schemaHtml ? encryptSensitiveField(data.schemaHtml) : null,
      data.treatmentsHtml ? encryptSensitiveField(data.treatmentsHtml) : null,
      data.remarksHtml ? encryptSensitiveField(data.remarksHtml) : null
    );

    const consultationId = Number(createdConsultation.lastInsertRowid);
    const title = String(data.title ?? '').trim();
    const reason = title || 'Consultation';

    const overlappingAppointmentId = findOverlappingAppointmentForPatient(
      patientId,
      localCalendarId,
      alignedStartIso,
      slotDurationMinutes
    );

    if (overlappingAppointmentId && linkStrategy === 'attach-existing') {
      db.prepare('UPDATE appointments SET consultation_id = ? WHERE id = ?').run(consultationId, overlappingAppointmentId);
      return {
        consultationId,
        appointmentId: overlappingAppointmentId,
        linkedToExisting: true
      };
    }

    const createdAppointment = db
      .prepare(
        `INSERT INTO appointments (patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        patientId,
        alignedStartIso,
        encryptSensitiveField(reason),
        'A confirmer',
        localCalendarId,
        consultationId
      );

    return {
      consultationId,
      appointmentId: Number(createdAppointment.lastInsertRowid),
      linkedToExisting: false
    };
  } catch { /* table might not exist on first run – will be created on restart */ }

  return null;
}

function storeAntecedentTypes(labels) {
  if (!labels.length) {
    return;
  }

  const upsertAntecedentType = db.prepare(
    'INSERT OR IGNORE INTO antecedent_types (label) VALUES (?)'
  );

  const insertMany = db.transaction((items) => {
    for (const label of items) {
      upsertAntecedentType.run(label);
    }
  });

  const unique = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  insertMany(unique);
}

function normalizeAuditValue(value) {
  return String(value ?? '').trim();
}

function buildPatientUpdateChanges(beforeSnapshot, afterSnapshot) {
  const labels = {
    fullName: 'Nom complet',
    sex: 'Sexe',
    birthDate: 'Date de naissance',
    mobilePhone: 'Telephone portable',
    landlinePhone: 'Telephone fixe',
    email: 'Email',
    address1: 'Adresse ligne 1',
    address2: 'Adresse ligne 2',
    postalCode: 'Code postal',
    city: 'Ville',
    country: 'Pays',
    occupationOrSchool: 'Profession / Scolarite',
    hobbies: 'Loisirs',
    primaryDoctor: 'Medecin traitant',
    socialSecurityNumber: 'Numero de securite sociale',
    referredBy: 'Envoye par',
    manualPreference: 'Preference manuelle',
    generalRemarks: 'Remarques generales',
    relatedPeople: 'Liens de parente',
    medicalHistory: 'Antecedents medicaux'
  };

  const changes = [];
  for (const key of Object.keys(labels)) {
    const before = normalizeAuditValue(beforeSnapshot[key]);
    const after = normalizeAuditValue(afterSnapshot[key]);

    if (before === after) {
      continue;
    }

    changes.push({
      field: labels[key],
      before,
      after
    });
  }

  return changes;
}

function authMiddleware(req, res, next) {
  const token = req.cookies.os_session;

  if (!token) {
    return res.status(401).json({ message: 'Session absente' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ message: 'Session invalide' });
  }
}

function adminOnlyMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Acces refuse' });
  }

  return next();
}

function getUserAccessContext(userId) {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.is_active, u.profile_id, p.label AS profile_label, p.rights_json
       FROM users u
       LEFT JOIN access_profiles p ON p.id = u.profile_id
       WHERE u.id = ?`
    )
    .get(userId);

  if (!row || !row.is_active) {
    return null;
  }

  let parsedRights;
  try {
    parsedRights = row.rights_json ? JSON.parse(row.rights_json) : {};
  } catch {
    parsedRights = {};
  }

  const offices = getUserOfficeOptions(row.id);
  const officeIds = offices.map((office) => office.id);

  return {
    id: row.id,
    username: row.username,
    role: row.role,
    profileId: row.profile_id ?? null,
    profileLabel: row.profile_label ?? null,
    officeIds,
    offices,
    rights: normalizeAccessRights(parsedRights, false)
  };
}

function hasPermission(rights, permissionId) {
  for (const domainRights of Object.values(rights ?? {})) {
    if (domainRights && typeof domainRights === 'object' && domainRights[permissionId] === true) {
      return true;
    }
  }

  return false;
}

function requirePermission(permissionId) {
  return (req, res, next) => {
    const access = getUserAccessContext(req.user.sub);
    if (!access) {
      return res.status(401).json({ message: 'Session invalide' });
    }

    if (access.role === 'admin') {
      req.userAccess = access;
      return next();
    }

    if (!hasPermission(access.rights, permissionId)) {
      return res.status(403).json({ message: 'Droit insuffisant' });
    }

    req.userAccess = access;
    return next();
  };
}

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(256),
  remember: z.boolean().optional().default(false)
});

const createPatientSchema = z.object({
  sex: z.enum(['Non renseigne', 'Femme', 'Homme']),
  lastName: z.string().min(1).max(100),
  firstName: z.string().min(1).max(100),
  birthDate: z.string().max(20).optional().default(''),
  mobilePhone: z.string().max(50).optional().default(''),
  landlinePhone: z.string().max(50).optional().default(''),
  email: z.string().max(150).optional().default(''),
  address1: z.string().max(150).optional().default(''),
  address2: z.string().max(150).optional().default(''),
  postalCode: z.string().max(20).optional().default(''),
  city: z.string().max(100).optional().default(''),
  country: z.string().max(80).optional().default('France'),
  occupationOrSchool: z.string().max(200).optional().default(''),
  hobbies: z.string().max(500).optional().default(''),
  primaryDoctor: z.string().max(160).optional().default(''),
  socialSecurityNumber: z.string().max(32).optional().default(''),
  referredBy: z.string().max(160).optional().default(''),
  manualPreference: z.enum(['Non renseigne', 'Droitier', 'Gaucher']).optional().default('Non renseigne'),
  generalRemarks: z.string().max(5000).optional().default(''),
  relatedPeople: z.string().max(500).optional().default(''),
  isDeceased: z.boolean().optional().default(false),
  medicalHistory: z.string().max(5000).optional().default(''),
  consultationNote: z.string().max(30000).optional().default(''),
  consultationLinkStrategy: z.enum(['attach-existing', 'create-new']).optional()
});

const patientDraftSchema = z.object({
  step: z.number().int().min(1).max(5),
  payload: createPatientSchema
});

const updatePatientSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  lastName: z.string().min(1).max(100).optional(),
  firstName: z.string().min(1).max(100).optional(),
  sex: z.enum(['Non renseigne', 'Femme', 'Homme']).optional(),
  birthDate: z.string().max(20).optional(),
  mobilePhone: z.string().max(50).optional(),
  landlinePhone: z.string().max(50).optional(),
  email: z.string().max(150).optional(),
  address1: z.string().max(150).optional(),
  address2: z.string().max(150).optional(),
  postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(80).optional(),
  occupationOrSchool: z.string().max(200).optional(),
  hobbies: z.string().max(500).optional(),
  primaryDoctor: z.string().max(160).optional(),
  socialSecurityNumber: z.string().max(32).optional(),
  referredBy: z.string().max(160).optional(),
  manualPreference: z.enum(['Non renseigne', 'Droitier', 'Gaucher']).optional(),
  generalRemarks: z.string().max(5000).optional(),
  relatedPeople: z.string().max(500).optional(),
  medicalHistory: z.string().max(5000).optional()
});

const createAccessProfileSchema = z.object({
  label: z.string().min(1).max(80),
  description: z.string().max(160).optional().default('')
});

const updateAccessRightsSchema = z.object({
  rights: z.record(z.string(), z.record(z.string(), z.boolean()))
});

const updateCurrentUserAccessProfileSchema = z.object({
  profileId: z.string().min(1).max(80)
});

const updateUserAccessProfileSchema = z.object({
  profileId: z.string().min(1).max(80)
});

const userAccountFieldsSchema = z.object({
  isActive: z.boolean().optional().default(true),
  profileId: z.string().min(1).max(80),
  role: z.string().min(1).max(40).optional(),
  officeId: z.number().int().positive().nullable().optional().default(null),
  officeIds: z.array(z.number().int().positive()).optional().default([]),
  username: z.string().min(1).max(100),
  password: z.string().max(256).optional().default(''),
  lastName: z.string().max(100).optional().default(''),
  firstName: z.string().max(100).optional().default(''),
  email: z.string().max(150).optional().default(''),
  mobilePhone: z.string().max(50).optional().default(''),
  country: z.string().max(80).optional().default('France'),
  siret: z.string().max(30).optional().default(''),
  adeliCode: z.string().max(40).optional().default(''),
  rppsCode: z.string().max(40).optional().default(''),
  apeNafCode: z.string().max(40).optional().default(''),
  nameSuffixText: z.string().max(200).optional().default(''),
  letterHeader: z.string().max(500).optional().default(''),
  letterFooter: z.string().max(500).optional().default(''),
  signatureText: z.string().max(2000000).optional().default(''),
  colorHex: z.string().max(20).optional().default('#4d92d1'),
  bankName: z.string().max(150).optional().default(''),
  iban: z.string().max(60).optional().default(''),
  retrocessionPercent: z.number().min(0).max(100).optional().default(0),
  retrocessionRecipient: z.string().max(120).optional().default(''),
  defaultAgendaView: z.string().max(80).optional().default('Semaine'),
  visibleCalendars: z.string().max(120).optional().default('Tous les calendriers'),
  defaultService: z.string().max(120).optional().default('Aucune prestation'),
  invoiceMentions: z.string().max(2000).optional().default(''),
  includeFreeConsultations: z.boolean().optional().default(true),
  showConsultationHour: z.boolean().optional().default(true)
});

const createUserAccountSchema = userAccountFieldsSchema.extend({
  password: z.string().min(1).max(256)
});

const updateUserAccountSchema = userAccountFieldsSchema;

const dataRestoreSchema = z.object({
  meta: z.record(z.string(), z.unknown()).optional(),
  data: z.object({
    accessProfiles: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    users: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    userOffices: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    patients: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    appointments: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    invoices: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    consultations: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    antecedentTypes: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    serviceTypes: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    paymentMethods: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    localCalendars: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    config: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    patientDrafts: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    auditLogs: z.array(z.record(z.string(), z.unknown())).optional().default([])
  })
});

const generalSettingsPayloadSchema = z.object({
  backupReminderFrequency: z.enum(['Toutes les semaines', 'Tous les 15 jours', 'Tous les mois', 'Tous les 2 mois'])
});

const agendaSettingsPayloadSchema = z.object({
  settings: z.object({
    dayStartHour: z.number().int().min(0).max(23).optional(),
    dayEndHour: z.number().int().min(1).max(24).optional(),
    lunchStartHour: z.number().int().min(0).max(23),
    lunchEndHour: z.number().int().min(1).max(24),
    defaultSessionDurationMinutes: z.number().int().min(15).max(90),
    slotDurationMinutes: z.number().int().min(5).max(50),
    displayHeight: z.number().int().min(14).max(35),
    showWeekend: z.boolean().optional(),
    autoConsultationType: z.boolean(),
    showPatientSex: z.boolean().optional(),
    showPatientMobilePhone: z.boolean().optional(),
    showPatientLandlinePhone: z.boolean().optional(),
    showAppointmentComment: z.boolean().optional(),
    patientRemarksDisplay: z.enum(['hidden', 'edit', 'readonly']).optional(),
    appointmentColorMode: z.enum(['calendar', 'user']).optional()
  }),
  localCalendars: z.array(
    z.object({
      id: z.number().int().positive().nullable().optional(),
      name: z.string().min(1).max(120),
      description: z.string().max(300).optional().default(''),
      colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      visibility: z.enum(['all', 'selected']),
      visibleUserIds: z.array(z.number().int().positive()).optional().default([]),
      officeId: z.number().int().positive(),
      displayOrder: z.number().int().min(0).optional().default(0)
    })
  )
});

const userAgendaPreferencesSchema = z.object({
  slotDurationMinutes: z.number().int().min(5).max(50),
  displayHeight: z.number().int().min(14).max(35),
  pdfDisplayMode: z.enum(['browser', 'download']),
  consultationOrder: z.enum(['Chronologique', 'Antichronologique']),
  groupConsultationsByYearFrom: z.number().int().min(0).max(200),
  patientAutoSaveFrequency: z.enum(['Jamais', 'Toutes les 2 minutes', 'Toutes les 5 minutes', 'Toutes les 10 minutes']),
  showWeekend: z.boolean(),
  showPatientSex: z.boolean(),
  showPatientMobilePhone: z.boolean(),
  showPatientLandlinePhone: z.boolean(),
  showAppointmentComment: z.boolean(),
  patientRemarksDisplay: z.enum(['hidden', 'edit', 'readonly']),
  appointmentColorMode: z.enum(['calendar', 'user'])
});

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:4200',
    credentials: true
  })
);
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: { message: 'Trop de tentatives de connexion. Reessayez plus tard.' }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/config', (_req, res) => {
  const appName = db.prepare('SELECT value FROM config WHERE key = ?').get('app_name');
  const version = db.prepare('SELECT value FROM config WHERE key = ?').get('version');
  
  res.json({
    app_name: appName?.value ?? 'OsteoSoft',
    version: version?.value ?? '0.0.2'
  });
});

app.get('/api/settings/general', authMiddleware, adminOnlyMiddleware, (_req, res) => {
  return res.json({ settings: readGeneralSettings() });
});

app.put('/api/settings/general', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const parsed = generalSettingsPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;

  const transaction = db.transaction(() => {
    const setConfig = db.prepare(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );

    setConfig.run('settings_backup_reminder_frequency', payload.backupReminderFrequency);
  });

  transaction();
  writeAuditLog(req.user.sub, 'UPDATE', 'general_settings', null, {});

  return res.json({ settings: readGeneralSettings() });
});

app.get('/api/settings/agenda', authMiddleware, adminOnlyMiddleware, (req, res) => {
  return res.json({ settings: readAgendaSettings(req.user.sub) });
});

app.put('/api/settings/agenda', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const parsed = agendaSettingsPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;

  const transaction = db.transaction(() => {
    const setConfig = db.prepare(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );

    setConfig.run('agenda_default_session_duration_minutes', String(payload.settings.defaultSessionDurationMinutes));
    // Slot/display settings are user-scoped and updated from profile preferences.
    // Auto consultation type is no longer configurable and stays enabled.

    const upsertCalendar = db.prepare(
      `INSERT INTO local_calendars (id, name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id)
       DO UPDATE SET name = excluded.name,
                     description = excluded.description,
                     color_hex = excluded.color_hex,
                     is_visible_to_all = excluded.is_visible_to_all,
                     visible_user_ids = excluded.visible_user_ids,
                     office_id = excluded.office_id,
                     display_order = excluded.display_order,
                     updated_at = CURRENT_TIMESTAMP`
    );

    const insertCalendar = db.prepare(
      `INSERT INTO local_calendars (name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const keepCalendarIds = [];

    payload.localCalendars.forEach((calendar, index) => {
      const visibleUserIds = [...new Set((calendar.visibleUserIds ?? []).filter((id) => Number.isInteger(id) && id > 0))];
      const isVisibleToAll = calendar.visibility === 'all' ? 1 : 0;
      const visibleUserIdsJson = JSON.stringify(visibleUserIds);
      const displayOrder = index + 1;

      if (calendar.id) {
        upsertCalendar.run(
          Number(calendar.id),
          calendar.name.trim(),
          String(calendar.description ?? '').trim(),
          normalizeColorHex(calendar.colorHex),
          isVisibleToAll,
          visibleUserIdsJson,
          Number(calendar.officeId),
          displayOrder
        );
        keepCalendarIds.push(Number(calendar.id));
      } else {
        const result = insertCalendar.run(
          calendar.name.trim(),
          String(calendar.description ?? '').trim(),
          normalizeColorHex(calendar.colorHex),
          isVisibleToAll,
          visibleUserIdsJson,
          Number(calendar.officeId),
          displayOrder
        );
        keepCalendarIds.push(Number(result.lastInsertRowid));
      }
    });

    if (keepCalendarIds.length > 0) {
      const placeholders = keepCalendarIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM local_calendars WHERE id NOT IN (${placeholders})`).run(...keepCalendarIds);
    } else {
      db.prepare('DELETE FROM local_calendars').run();
    }
  });

  transaction();
  writeAuditLog(req.user.sub, 'UPDATE', 'agenda_settings', null, {
    calendarsCount: payload.localCalendars.length
  });

  return res.json({ settings: readAgendaSettings(req.user.sub) });
});

app.get('/api/profile/agenda-preferences', authMiddleware, (req, res) => {
  return res.json({ preferences: readUserAgendaPreferences(req.user.sub) });
});

app.put('/api/profile/agenda-preferences', authMiddleware, (req, res) => {
  const parsed = userAgendaPreferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const preferences = saveUserAgendaPreferences(req.user.sub, parsed.data);
  writeAuditLog(req.user.sub, 'UPDATE', 'user_preference', String(req.user.sub), {});

  return res.json({ preferences });
});

app.get('/api/offices', authMiddleware, adminOnlyMiddleware, (_req, res) => {
  const offices = db.prepare(`
    SELECT id, name, default_session_duration_minutes as defaultSessionDurationMinutes, country, devise,
           invoice_number_format as invoiceNumberFormat, invoice_numbering_configuration as invoiceNumberingConfiguration,
           invoice_show_insurance_fields as invoiceShowInsuranceFields, invoice_hide_vat_mention as invoiceHideVatMention,
           address_line1 as addressLine1, address_line2 as addressLine2,
           postal_code as postalCode, city, phone_mobile as phoneMobile,
           phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
           vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson, is_active as isActive,
           display_order as displayOrder, created_at as createdAt, updated_at as updatedAt
    FROM offices
    ORDER BY display_order ASC, created_at DESC
  `).all() || [];
  
  return res.json({
    offices: offices.map(mapOfficeRow)
  });
});

app.post('/api/offices', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const {
    name,
    defaultSessionDurationMinutes,
    country,
    devise,
    invoiceNumberFormat,
    numberingConfiguration,
    alwaysShowSocialSecurityAndMutuelle,
    hideVatMention,
    addressLine1,
    addressLine2,
    postalCode,
    city,
    phoneMobile,
    phoneLandline,
    phoneFax,
    email,
    website,
    vatNumber,
    logoData,
    openingHours,
    serviceTypes,
    paymentMethods
  } = req.body;
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ message: 'Le nom du cabinet est obligatoire' });
  }

  const normalizedOpeningHours = normalizeOfficeOpeningHours(openingHours);
  const normalizedDefaultSessionDurationMinutes = normalizeOfficeDefaultSessionDurationMinutes(defaultSessionDurationMinutes);
  const normalizedCountry = String(country ?? '').trim() || 'France';
  const normalizedDevise = normalizeOfficeDevise(devise);
  const normalizedInvoiceNumberFormat = normalizeOfficeInvoiceNumberFormat(invoiceNumberFormat);
  const normalizedInvoiceNumberingConfiguration = normalizeOfficeInvoiceNumberingConfiguration(numberingConfiguration);
  const normalizedInvoiceShowInsuranceFields = alwaysShowSocialSecurityAndMutuelle ? 1 : 0;
  const normalizedInvoiceHideVatMention = hideVatMention ? 1 : 0;

  try {
    const maxOrder = db.prepare(`SELECT MAX(display_order) as maxOrder FROM offices`).get() || {};
    const displayOrder = (maxOrder.maxOrder || 0) + 1;

    const insert = db.prepare(`
      INSERT INTO offices (name, default_session_duration_minutes, country, devise, invoice_number_format, invoice_numbering_configuration,
                           invoice_show_insurance_fields, invoice_hide_vat_mention, address_line1, address_line2, postal_code, city, phone_mobile,
                           phone_landline, phone_fax, email, website, vat_number, logo_data, opening_hours_json, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      name, normalizedDefaultSessionDurationMinutes, normalizedCountry, normalizedDevise,
      normalizedInvoiceNumberFormat, normalizedInvoiceNumberingConfiguration, normalizedInvoiceShowInsuranceFields, normalizedInvoiceHideVatMention,
      addressLine1 || null, addressLine2 || null, postalCode || null, city || null,
      phoneMobile || null, phoneLandline || null, phoneFax || null, email || null,
      website || null, vatNumber || null, logoData || null, JSON.stringify(normalizedOpeningHours), displayOrder
    );

    const createdOfficeId = Number(result.lastInsertRowid);
    replaceOfficeBusinessSettings(createdOfficeId, serviceTypes, paymentMethods);

    createLocalCalendarFromOffice(createdOfficeId, name);

    writeAuditLog(req.user.id, 'CREATE', 'office', result.lastInsertRowid, {
      name, city, defaultSessionDurationMinutes: normalizedDefaultSessionDurationMinutes
    });

    const office = db.prepare(`
          SELECT id, name, default_session_duration_minutes as defaultSessionDurationMinutes, country, devise,
            invoice_number_format as invoiceNumberFormat, invoice_numbering_configuration as invoiceNumberingConfiguration,
            invoice_show_insurance_fields as invoiceShowInsuranceFields, invoice_hide_vat_mention as invoiceHideVatMention,
            address_line1 as addressLine1, address_line2 as addressLine2,
             postal_code as postalCode, city, phone_mobile as phoneMobile,
             phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
             vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson, is_active as isActive,
             display_order as displayOrder, created_at as createdAt, updated_at as updatedAt
      FROM offices WHERE id = ?
    `).get(result.lastInsertRowid);

    return res.json({ office: mapOfficeRow(office) });
  } catch (err) {
    console.error('Error creating office:', err);
    return res.status(500).json({ message: 'Erreur lors de la création du cabinet' });
  }
});

app.put('/api/offices/:id', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const officeId = Number(req.params.id);
  const {
    name,
    defaultSessionDurationMinutes,
    country,
    devise,
    invoiceNumberFormat,
    numberingConfiguration,
    alwaysShowSocialSecurityAndMutuelle,
    hideVatMention,
    addressLine1,
    addressLine2,
    postalCode,
    city,
    phoneMobile,
    phoneLandline,
    phoneFax,
    email,
    website,
    vatNumber,
    logoData,
    openingHours,
    serviceTypes,
    paymentMethods,
    isActive
  } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ message: 'Le nom du cabinet est obligatoire' });
  }

  const normalizedOpeningHours = normalizeOfficeOpeningHours(openingHours);
  const normalizedDefaultSessionDurationMinutes = normalizeOfficeDefaultSessionDurationMinutes(defaultSessionDurationMinutes);
  const normalizedCountry = String(country ?? '').trim() || 'France';
  const normalizedDevise = normalizeOfficeDevise(devise);
  const normalizedInvoiceNumberFormat = normalizeOfficeInvoiceNumberFormat(invoiceNumberFormat);
  const normalizedInvoiceNumberingConfiguration = normalizeOfficeInvoiceNumberingConfiguration(numberingConfiguration);
  const normalizedInvoiceShowInsuranceFields = alwaysShowSocialSecurityAndMutuelle ? 1 : 0;
  const normalizedInvoiceHideVatMention = hideVatMention ? 1 : 0;

  try {
    const update = db.prepare(`
      UPDATE offices
        SET name = ?, default_session_duration_minutes = ?, country = ?, devise = ?, invoice_number_format = ?,
          invoice_numbering_configuration = ?, invoice_show_insurance_fields = ?, invoice_hide_vat_mention = ?, address_line1 = ?, address_line2 = ?, postal_code = ?, city = ?,
          phone_mobile = ?, phone_landline = ?, phone_fax = ?, email = ?, website = ?,
          vat_number = ?, logo_data = ?, opening_hours_json = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    update.run(
      name, normalizedDefaultSessionDurationMinutes, normalizedCountry, normalizedDevise,
      normalizedInvoiceNumberFormat, normalizedInvoiceNumberingConfiguration, normalizedInvoiceShowInsuranceFields, normalizedInvoiceHideVatMention,
      addressLine1 || null, addressLine2 || null, postalCode || null, city || null,
      phoneMobile || null, phoneLandline || null, phoneFax || null, email || null,
      website || null, vatNumber || null, logoData || null, JSON.stringify(normalizedOpeningHours), isActive ? 1 : 0, officeId
    );

    replaceOfficeBusinessSettings(officeId, serviceTypes, paymentMethods);

    writeAuditLog(req.user.id, 'UPDATE', 'office', officeId, { name, city, defaultSessionDurationMinutes: normalizedDefaultSessionDurationMinutes });

    const office = db.prepare(`
          SELECT id, name, default_session_duration_minutes as defaultSessionDurationMinutes, country, devise,
            invoice_number_format as invoiceNumberFormat, invoice_numbering_configuration as invoiceNumberingConfiguration,
            invoice_show_insurance_fields as invoiceShowInsuranceFields, invoice_hide_vat_mention as invoiceHideVatMention,
            address_line1 as addressLine1, address_line2 as addressLine2,
             postal_code as postalCode, city, phone_mobile as phoneMobile,
             phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
             vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson, is_active as isActive,
             display_order as displayOrder, created_at as createdAt, updated_at as updatedAt
      FROM offices WHERE id = ?
    `).get(officeId);

    return res.json({ office: mapOfficeRow(office) });
  } catch (err) {
    console.error('Error updating office:', err);
    return res.status(500).json({ message: 'Erreur lors de la mise à jour du cabinet' });
  }
});

app.delete('/api/offices/:id', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const officeId = Number(req.params.id);

  try {
    db.prepare('DELETE FROM service_types WHERE office_id = ?').run(officeId);
    db.prepare('DELETE FROM payment_methods WHERE office_id = ?').run(officeId);
    db.prepare(`DELETE FROM offices WHERE id = ?`).run(officeId);
    writeAuditLog(req.user.id, 'DELETE', 'office', officeId, {});

    return res.json({ message: 'Cabinet supprimé' });
  } catch (err) {
    console.error('Error deleting office:', err);
    return res.status(500).json({ message: 'Erreur lors de la suppression du cabinet' });
  }
});

app.post('/api/offices/reorder', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const { officeIds } = req.body;
  if (!Array.isArray(officeIds)) {
    return res.status(400).json({ message: 'officeIds doit être un tableau' });
  }

  try {
    const updateOrder = db.prepare(`UPDATE offices SET display_order = ? WHERE id = ?`);
    officeIds.forEach((id, index) => {
      updateOrder.run(index, id);
    });

    writeAuditLog(req.user.id, 'UPDATE', 'office-order', 0, { count: officeIds.length });

    const offices = db.prepare(`
          SELECT id, name, default_session_duration_minutes as defaultSessionDurationMinutes, country, devise,
            invoice_number_format as invoiceNumberFormat, invoice_numbering_configuration as invoiceNumberingConfiguration,
            invoice_show_insurance_fields as invoiceShowInsuranceFields, invoice_hide_vat_mention as invoiceHideVatMention,
            address_line1 as addressLine1, address_line2 as addressLine2,
             postal_code as postalCode, city, phone_mobile as phoneMobile,
             phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
             vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson, is_active as isActive,
             display_order as displayOrder, created_at as createdAt, updated_at as updatedAt
      FROM offices ORDER BY display_order ASC
    `).all() || [];

    return res.json({
      offices: offices.map(mapOfficeRow)
    });
  } catch (err) {
    console.error('Error reordering offices:', err);
    return res.status(500).json({ message: 'Erreur lors de la réorganisation' });
  }
});

app.get('/api/data-management/backup', authMiddleware, adminOnlyMiddleware, (_req, res) => {
  const snapshot = buildDataBackupSnapshot();
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `osteosoft-backup-${now}.json`;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(JSON.stringify(snapshot, null, 2));
});

app.post('/api/data-management/restore', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const parsed = dataRestoreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Fichier de sauvegarde invalide' });
  }

  try {
    restoreDataBackupSnapshot(parsed.data);
    return res.status(204).send();
  } catch {
    return res.status(500).json({ message: 'La restauration de la sauvegarde a échoué' });
  }
});

app.get('/api/audit-logs', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const rawLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;

  const rows = db
    .prepare(
      `SELECT l.id, l.created_at, l.action, l.entity, l.entity_id, l.metadata, u.username
       FROM audit_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ORDER BY datetime(l.created_at) DESC, l.id DESC
       LIMIT ?`
    )
    .all(limit);

  const logs = rows.map((row) => {
    let metadata = null;

    try {
      const parsed = row.metadata ? JSON.parse(row.metadata) : null;
      metadata = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      metadata = null;
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      username: row.username ?? 'system',
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id ?? null,
      metadata
    };
  });

  return res.json({ logs });
});

app.get('/api/patient-drafts/new-patient', authMiddleware, (req, res) => {
  const row = db
    .prepare(
      `SELECT step, draft_json, updated_at
       FROM patient_drafts
       WHERE user_id = ? AND flow_key = 'new_patient'`
    )
    .get(req.user.sub);

  if (!row) {
    return res.json({ draft: null });
  }

  let payload = null;
  try {
    payload = JSON.parse(row.draft_json);
  } catch {
    payload = null;
  }

  if (!payload) {
    return res.json({ draft: null });
  }

  return res.json({
    draft: {
      step: row.step,
      payload,
      updatedAt: row.updated_at
    }
  });
});

app.put('/api/patient-drafts/new-patient', authMiddleware, (req, res) => {
  const parsed = patientDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  db.prepare(
    `INSERT INTO patient_drafts (user_id, flow_key, draft_json, step, updated_at)
     VALUES (?, 'new_patient', ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, flow_key)
     DO UPDATE SET draft_json = excluded.draft_json,
                   step = excluded.step,
                   updated_at = CURRENT_TIMESTAMP`
  ).run(req.user.sub, JSON.stringify(parsed.data.payload), parsed.data.step);

  return res.status(204).send();
});

app.delete('/api/patient-drafts/new-patient', authMiddleware, (req, res) => {
  db.prepare(
    `DELETE FROM patient_drafts
     WHERE user_id = ? AND flow_key = 'new_patient'`
  ).run(req.user.sub);

  return res.status(204).send();
});

app.get('/api/antecedent-types', authMiddleware, (_req, res) => {
  const rows = db
    .prepare('SELECT label FROM antecedent_types ORDER BY lower(label) ASC')
    .all();

  return res.json({ types: rows.map((row) => row.label) });
});

app.get('/api/practitioners', authMiddleware, requirePermission('read-dashboard'), (_req, res) => {
  const rows = db
    .prepare('SELECT id, username, role FROM users ORDER BY lower(username) ASC')
    .all();

  return res.json({
    practitioners: rows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role
    }))
  });
});

function mapUserAccountRow(row) {
  let officeIds = [];
  try {
    const parsed = JSON.parse(row.office_ids_json ?? '[]');
    if (Array.isArray(parsed)) {
      officeIds = parsed
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
    }
  } catch {
    officeIds = [];
  }

  const fallbackOfficeId = row.office_id != null ? Number(row.office_id) : null;
  if (officeIds.length === 0 && fallbackOfficeId != null && Number.isInteger(fallbackOfficeId) && fallbackOfficeId > 0) {
    officeIds = [fallbackOfficeId];
  }

  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    role: row.role,
    isActive: Boolean(row.is_active),
    profileId: row.profile_id ?? null,
    profileLabel: row.profile_label ?? null,
    officeId: row.office_id != null ? Number(row.office_id) : null,
    officeIds,
    cabinetName: row.office_names ?? row.office_name ?? '',
    lastName: row.last_name ?? '',
    firstName: row.first_name ?? '',
    email: row.email ?? '',
    mobilePhone: row.mobile_phone ?? '',
    country: row.country ?? 'France',
    siret: row.siret ?? '',
    adeliCode: row.adeli_code ?? '',
    rppsCode: row.rpps_code ?? '',
    apeNafCode: row.ape_naf_code ?? '',
    nameSuffixText: row.name_suffix_text ?? '',
    letterHeader: row.letter_header ?? '',
    letterFooter: row.letter_footer ?? '',
    signatureText: row.signature_text ?? '',
    colorHex: row.color_hex ?? '#4d92d1',
    bankName: row.bank_name ?? '',
    iban: row.iban ?? '',
    retrocessionPercent: Number(row.retrocession_percent ?? 0),
    retrocessionRecipient: row.retrocession_recipient ?? '',
    defaultAgendaView: row.default_agenda_view ?? 'Semaine',
    visibleCalendars: row.visible_calendars ?? 'Tous les calendriers',
    defaultService: row.default_service ?? 'Aucune prestation',
    invoiceMentions: row.invoice_mentions ?? '',
    includeFreeConsultations: Boolean(row.include_free_consultations ?? 1),
    showConsultationHour: Boolean(row.show_consultation_hour ?? 1)
  };
}

app.get('/api/users', authMiddleware, adminOnlyMiddleware, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.created_at, u.role, u.is_active, u.profile_id, p.label AS profile_label,
              u.office_id, o.name AS office_name, u.last_name, u.first_name, u.email, u.mobile_phone, u.country,
              u.siret, u.adeli_code, u.rpps_code, u.ape_naf_code, u.name_suffix_text,
              u.letter_header, u.letter_footer, u.signature_text, u.color_hex,
              u.bank_name, u.iban, u.retrocession_percent, u.retrocession_recipient,
              u.default_agenda_view, u.visible_calendars, u.default_service, u.invoice_mentions,
              (
                SELECT json_group_array(uo.office_id)
                FROM user_offices uo
                WHERE uo.user_id = u.id
              ) AS office_ids_json,
              (
                SELECT group_concat(o2.name, ', ')
                FROM user_offices uo2
                INNER JOIN offices o2 ON o2.id = uo2.office_id
                WHERE uo2.user_id = u.id
              ) AS office_names
       FROM users u
       LEFT JOIN access_profiles p ON p.id = u.profile_id
       LEFT JOIN offices o ON o.id = u.office_id
       ORDER BY lower(u.username) ASC`
    )
    .all();

  return res.json({
    users: rows.map((row) => mapUserAccountRow(row))
  });
});

app.post('/api/users', authMiddleware, adminOnlyMiddleware, async (req, res) => {
  const parsed = createUserAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;
  const username = payload.username.trim();
  const password = payload.password.trim();
  const profileId = payload.profileId.trim();
  const officeIds = normalizeOfficeIds(payload.officeIds, payload.officeId);
  const officeId = officeIds.length > 0 ? officeIds[0] : null;

  if (!username || !password || !profileId) {
    return res.status(400).json({ message: 'Champs requis manquants' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username);
  if (existing) {
    return res.status(409).json({ message: 'Un utilisateur avec ce login existe deja' });
  }

  const profile = db.prepare('SELECT id FROM access_profiles WHERE id = ?').get(profileId);
  if (!profile) {
    return res.status(404).json({ message: 'Profil introuvable' });
  }

  for (const selectedOfficeId of officeIds) {
    const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(selectedOfficeId);
    if (!office) {
      return res.status(404).json({ message: 'Cabinet introuvable' });
    }
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1
  });

  const role = (payload.role ?? 'practitioner').trim() || 'practitioner';

  const result = db.prepare(
    `INSERT INTO users (
      username, password_hash, role, is_active, profile_id, office_id,
      last_name, first_name, email, mobile_phone, country,
      siret, adeli_code, rpps_code, ape_naf_code, name_suffix_text,
      letter_header, letter_footer, signature_text, color_hex,
      bank_name, iban, retrocession_percent, retrocession_recipient,
      default_agenda_view, visible_calendars, default_service, invoice_mentions,
      include_free_consultations, show_consultation_hour
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    username,
    passwordHash,
    role,
    payload.isActive ? 1 : 0,
    profileId,
    officeId,
    payload.lastName.trim(),
    payload.firstName.trim(),
    payload.email.trim(),
    payload.mobilePhone.trim(),
    payload.country.trim() || 'France',
    payload.siret.trim(),
    payload.adeliCode.trim(),
    payload.rppsCode.trim(),
    payload.apeNafCode.trim(),
    payload.nameSuffixText.trim(),
    payload.letterHeader.trim(),
    payload.letterFooter.trim(),
    payload.signatureText.trim(),
    payload.colorHex.trim() || '#4d92d1',
    payload.bankName.trim(),
    payload.iban.trim(),
    Number(payload.retrocessionPercent) || 0,
    payload.retrocessionRecipient.trim(),
    payload.defaultAgendaView.trim() || 'Semaine',
    payload.visibleCalendars.trim() || 'Tous les calendriers',
    payload.defaultService.trim() || 'Aucune prestation',
    payload.invoiceMentions.trim(),
    payload.includeFreeConsultations ? 1 : 0,
    payload.showConsultationHour ? 1 : 0
  );

  const createdUserId = Number(result.lastInsertRowid);
  syncUserOffices(createdUserId, officeIds);
  writeAuditLog(req.user.sub, 'CREATE', 'users', String(createdUserId), {
    username,
    profileId,
    officeIds
  });

  const createdUser = db
    .prepare(
      `SELECT u.id, u.username, u.created_at, u.role, u.is_active, u.profile_id, p.label AS profile_label,
              u.office_id, o.name AS office_name, u.last_name, u.first_name, u.email, u.mobile_phone, u.country,
              u.siret, u.adeli_code, u.rpps_code, u.ape_naf_code, u.name_suffix_text,
              u.letter_header, u.letter_footer, u.signature_text, u.color_hex,
              u.bank_name, u.iban, u.retrocession_percent, u.retrocession_recipient,
              u.default_agenda_view, u.visible_calendars, u.default_service, u.invoice_mentions,
              (
                SELECT json_group_array(uo.office_id)
                FROM user_offices uo
                WHERE uo.user_id = u.id
              ) AS office_ids_json,
              (
                SELECT group_concat(o2.name, ', ')
                FROM user_offices uo2
                INNER JOIN offices o2 ON o2.id = uo2.office_id
                WHERE uo2.user_id = u.id
              ) AS office_names
       FROM users u
       LEFT JOIN access_profiles p ON p.id = u.profile_id
       LEFT JOIN offices o ON o.id = u.office_id
       WHERE u.id = ?`
    )
    .get(createdUserId);

  return res.status(201).json({ user: mapUserAccountRow(createdUser) });
});

app.put('/api/users/:id', authMiddleware, adminOnlyMiddleware, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: 'ID utilisateur invalide' });
  }

  const parsed = updateUserAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;
  const targetUser = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!targetUser) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  const username = payload.username.trim();
  const profileId = payload.profileId.trim();
  if (!username || !profileId) {
    return res.status(400).json({ message: 'Champs requis manquants' });
  }

  const usernameConflict = db
    .prepare('SELECT id FROM users WHERE lower(username) = lower(?) AND id <> ?')
    .get(username, userId);
  if (usernameConflict) {
    return res.status(409).json({ message: 'Un utilisateur avec ce login existe deja' });
  }

  const profile = db.prepare('SELECT id FROM access_profiles WHERE id = ?').get(profileId);
  if (!profile) {
    return res.status(404).json({ message: 'Profil introuvable' });
  }

  const officeIds = normalizeOfficeIds(payload.officeIds, payload.officeId);
  const officeId = officeIds.length > 0 ? officeIds[0] : null;
  for (const selectedOfficeId of officeIds) {
    const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(selectedOfficeId);
    if (!office) {
      return res.status(404).json({ message: 'Cabinet introuvable' });
    }
  }

  if (targetUser.username === 'admin') {
    if (username !== 'admin') {
      return res.status(403).json({ message: 'Le login du compte admin ne peut pas être modifié' });
    }

    if (profileId !== 'super-admin') {
      return res.status(403).json({ message: 'Le compte admin doit rester Super Administrateur' });
    }

    if (!payload.isActive) {
      return res.status(403).json({ message: 'Le compte admin doit rester actif' });
    }
  }

  const role = (payload.role ?? targetUser.role).trim() || targetUser.role;

  db.prepare(
    `UPDATE users
     SET username = ?,
         role = ?,
         is_active = ?,
         profile_id = ?,
         office_id = ?,
         last_name = ?,
         first_name = ?,
         email = ?,
         mobile_phone = ?,
         country = ?,
         siret = ?,
         adeli_code = ?,
         rpps_code = ?,
         ape_naf_code = ?,
         name_suffix_text = ?,
         letter_header = ?,
         letter_footer = ?,
         signature_text = ?,
         color_hex = ?,
         bank_name = ?,
         iban = ?,
         retrocession_percent = ?,
         retrocession_recipient = ?,
         default_agenda_view = ?,
         visible_calendars = ?,
         default_service = ?,
         invoice_mentions = ?,
         include_free_consultations = ?,
         show_consultation_hour = ?
     WHERE id = ?`
  ).run(
    username,
    role,
    payload.isActive ? 1 : 0,
    profileId,
    officeId,
    payload.lastName.trim(),
    payload.firstName.trim(),
    payload.email.trim(),
    payload.mobilePhone.trim(),
    payload.country.trim() || 'France',
    payload.siret.trim(),
    payload.adeliCode.trim(),
    payload.rppsCode.trim(),
    payload.apeNafCode.trim(),
    payload.nameSuffixText.trim(),
    payload.letterHeader.trim(),
    payload.letterFooter.trim(),
    payload.signatureText.trim(),
    payload.colorHex.trim() || '#4d92d1',
    payload.bankName.trim(),
    payload.iban.trim(),
    Number(payload.retrocessionPercent) || 0,
    payload.retrocessionRecipient.trim(),
    payload.defaultAgendaView.trim() || 'Semaine',
    payload.visibleCalendars.trim() || 'Tous les calendriers',
    payload.defaultService.trim() || 'Aucune prestation',
    payload.invoiceMentions.trim(),
    payload.includeFreeConsultations ? 1 : 0,
    payload.showConsultationHour ? 1 : 0,
    userId
  );

  syncUserOffices(userId, officeIds);

  const nextPassword = payload.password.trim();
  if (nextPassword) {
    const passwordHash = await argon2.hash(nextPassword, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  }

  writeAuditLog(req.user.sub, 'UPDATE', 'users', String(userId), {
    username,
    profileId,
    officeIds,
    updatedPassword: Boolean(nextPassword)
  });

  return res.status(204).send();
});

app.delete('/api/users/:id', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: 'ID utilisateur invalide' });
  }

  const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!targetUser) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  if (targetUser.username === 'admin') {
    return res.status(403).json({ message: 'Le compte admin ne peut pas être supprimé' });
  }

  if (req.user.sub === userId) {
    return res.status(403).json({ message: 'Vous ne pouvez pas supprimer votre propre compte' });
  }

  const removeUser = db.transaction(() => {
    db.prepare('UPDATE audit_logs SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM patient_drafts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  removeUser();

  writeAuditLog(req.user.sub, 'DELETE', 'users', String(userId), {
    targetUsername: targetUser.username
  });

  return res.status(204).send();
});

app.put('/api/users/:id/access-profile', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: 'ID utilisateur invalide' });
  }

  const parsed = updateUserAccessProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const targetUser = db
    .prepare('SELECT id, username FROM users WHERE id = ?')
    .get(userId);
  if (!targetUser) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  if (targetUser.username === 'admin' && parsed.data.profileId !== 'super-admin') {
    return res.status(403).json({ message: 'Le compte admin doit rester Super Administrateur' });
  }

  const profile = db
    .prepare('SELECT id, label FROM access_profiles WHERE id = ?')
    .get(parsed.data.profileId);
  if (!profile) {
    return res.status(404).json({ message: 'Profil introuvable' });
  }

  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profile.id, userId);
  writeAuditLog(req.user.sub, 'UPDATE', 'users', String(userId), {
    field: 'profile_id',
    profileId: profile.id,
    targetUsername: targetUser.username
  });

  return res.status(204).send();
});

app.get('/api/access-profiles', authMiddleware, adminOnlyMiddleware, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, label, description, rights_json, immutable
       FROM access_profiles
       ORDER BY immutable DESC, lower(label) ASC`
    )
    .all();

  const profiles = rows.map((row) => {
    let parsedRights;
    try {
      parsedRights = JSON.parse(row.rights_json);
    } catch {
      parsedRights = {};
    }

    return {
      id: row.id,
      label: row.label,
      description: row.description ?? '',
      immutable: Boolean(row.immutable),
      rights: normalizeAccessRights(parsedRights, false)
    };
  });

  return res.json({ profiles });
});

app.post('/api/access-profiles', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const parsed = createAccessProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const label = parsed.data.label.trim();
  const description = parsed.data.description.trim();

  const existing = db
    .prepare('SELECT id FROM access_profiles WHERE lower(label) = lower(?)')
    .get(label);

  if (existing) {
    return res.status(409).json({ message: 'Un profil avec ce nom existe deja' });
  }

  const profileId = createAccessProfileId(label);
  db.prepare(
    `INSERT INTO access_profiles (id, label, description, rights_json, immutable)
     VALUES (?, ?, ?, ?, 0)`
  ).run(profileId, label, description, JSON.stringify(buildAccessRights(false)));

  writeAuditLog(req.user.sub, 'CREATE', 'access_profiles', profileId, { label });

  return res.status(201).json({
    profile: {
      id: profileId,
      label,
      description,
      immutable: false,
      rights: buildAccessRights(false)
    }
  });
});

app.put('/api/access-profiles/:id/rights', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const profileId = String(req.params.id ?? '').trim();
  if (!profileId) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const parsed = updateAccessRightsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const profile = db
    .prepare('SELECT id, immutable FROM access_profiles WHERE id = ?')
    .get(profileId);

  if (!profile) {
    return res.status(404).json({ message: 'Profil introuvable' });
  }

  if (profile.immutable) {
    return res.status(403).json({ message: 'Profil systeme non modifiable' });
  }

  const normalizedRights = normalizeAccessRights(parsed.data.rights, false);

  db.prepare(
    `UPDATE access_profiles
     SET rights_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(JSON.stringify(normalizedRights), profileId);

  writeAuditLog(req.user.sub, 'UPDATE', 'access_profiles', profileId, {
    updatedRights: true
  });

  return res.status(204).send();
});

app.put('/api/auth/me/access-profile', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const parsed = updateCurrentUserAccessProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const profile = db
    .prepare('SELECT id, label FROM access_profiles WHERE id = ?')
    .get(parsed.data.profileId);

  if (!profile) {
    return res.status(404).json({ message: 'Profil introuvable' });
  }

  const currentUser = db
    .prepare('SELECT id, username FROM users WHERE id = ?')
    .get(req.user.sub);

  if (!currentUser) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  if (currentUser.username === 'admin' && parsed.data.profileId !== 'super-admin') {
    return res.status(403).json({ message: 'Le compte admin doit rester Super Administrateur' });
  }

  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profile.id, req.user.sub);
  writeAuditLog(req.user.sub, 'UPDATE', 'users', String(req.user.sub), {
    field: 'profile_id',
    profileId: profile.id
  });

  return res.status(204).send();
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const user = db
    .prepare(
      `SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.profile_id, p.label AS profile_label
       FROM users u
       LEFT JOIN access_profiles p ON p.id = u.profile_id
       WHERE u.username = ?`
    )
    .get(parsed.data.username);

  if (!user) {
    return res.status(401).json({ message: 'Identifiants invalides' });
  }

  if (!user.is_active) {
    return res.status(403).json({ message: 'Compte desactive' });
  }

  const validPassword = await argon2.verify(user.password_hash, parsed.data.password);
  if (!validPassword) {
    return res.status(401).json({ message: 'Identifiants invalides' });
  }

  const token = signToken(user);
  res.cookie('os_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: parsed.data.remember ? 12 * 60 * 60 * 1000 : undefined
  });

  writeAuditLog(user.id, 'LOGIN', 'auth', String(user.id));

  const access = getUserAccessContext(user.id);

  return res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      profileId: access?.profileId ?? null,
      profileLabel: access?.profileLabel ?? null,
      officeIds: access?.officeIds ?? [],
      offices: access?.offices ?? [],
      rights: access?.rights ?? buildAccessRights(false)
    }
  });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  res.clearCookie('os_session');
  writeAuditLog(req.user.sub, 'LOGOUT', 'auth', String(req.user.sub));
  res.status(204).send();
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = getUserAccessContext(req.user.sub);

  if (!user) {
    return res.status(401).json({ message: 'Session invalide' });
  }

  return res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      profileId: user.profileId ?? null,
      profileLabel: user.profileLabel ?? null,
      officeIds: user.officeIds ?? [],
      offices: user.offices ?? [],
      rights: user.rights
    }
  });
});

app.get('/api/directory/contacts', authMiddleware, requirePermission('read-directory'), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const offices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const allowedOfficeIds = new Set(offices.map((office) => Number(office.id)).filter((id) => Number.isInteger(id) && id > 0));

  const requestedOfficeId = Number(req.query.officeId);
  const officeIdFilter = Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 ? requestedOfficeId : null;

  if (officeIdFilter != null && !allowedOfficeIds.has(officeIdFilter)) {
    return res.status(403).json({ message: 'Acces refuse a ce cabinet' });
  }

  if (!isAdmin && allowedOfficeIds.size === 0) {
    return res.json({ contacts: [], offices, selectedOfficeId: officeIdFilter });
  }

  const search = String(req.query.search ?? '').trim().toLowerCase();
  const kindFilter = String(req.query.kind ?? '').trim().toLowerCase();
  const activeFilterRaw = String(req.query.isActive ?? '').trim().toLowerCase();

  const whereParts = [];
  const params = [];

  if (!isAdmin) {
    const placeholders = [...allowedOfficeIds].map(() => '?').join(', ');
    whereParts.push(`dc.office_id IN (${placeholders})`);
    params.push(...allowedOfficeIds);
  }

  if (officeIdFilter != null) {
    whereParts.push('dc.office_id = ?');
    params.push(officeIdFilter);
  }

  if (kindFilter === 'person' || kindFilter === 'company') {
    whereParts.push('dc.kind = ?');
    params.push(kindFilter);
  }

  if (activeFilterRaw === 'true' || activeFilterRaw === 'false') {
    whereParts.push('dc.is_active = ?');
    params.push(activeFilterRaw === 'true' ? 1 : 0);
  }

  const rows = db
    .prepare(
      `SELECT dc.id, dc.office_id, o.name AS office_name, dc.kind,
              dc.first_name, dc.last_name, dc.organization, dc.role,
              dc.email, dc.mobile_phone, dc.landline_phone,
              dc.address_line1, dc.address_line2, dc.postal_code, dc.city, dc.country,
              dc.notes, dc.is_active, dc.created_at, dc.updated_at
       FROM directory_contacts dc
       INNER JOIN offices o ON o.id = dc.office_id
       ${whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''}
       ORDER BY lower(dc.last_name) ASC, lower(dc.first_name) ASC, lower(dc.organization) ASC, dc.id ASC`
    )
    .all(...params)
    .map(mapDirectoryContactRow)
    .filter((contact) => {
      if (!search) {
        return true;
      }

      return [
        contact.displayName,
        contact.firstName,
        contact.lastName,
        contact.organization,
        contact.role,
        contact.email,
        contact.mobilePhone,
        contact.landlinePhone,
        contact.city,
        contact.postalCode,
        contact.officeName
      ]
        .map((value) => String(value ?? '').toLowerCase())
        .some((value) => value.includes(search));
    });

  return res.json({ contacts: rows, offices, selectedOfficeId: officeIdFilter });
});

app.post('/api/directory/contacts', authMiddleware, requirePermission('create-directory-contact'), (req, res) => {
  const parsed = z
    .object({
      officeId: z.number().int().positive(),
      kind: z.enum(['person', 'company']).optional().default('person'),
      firstName: z.string().trim().max(120).optional().default(''),
      lastName: z.string().trim().max(120).optional().default(''),
      organization: z.string().trim().max(200).optional().default(''),
      role: z.string().trim().max(120).optional().default(''),
      email: z.string().trim().max(160).optional().default(''),
      mobilePhone: z.string().trim().max(50).optional().default(''),
      landlinePhone: z.string().trim().max(50).optional().default(''),
      address1: z.string().trim().max(200).optional().default(''),
      address2: z.string().trim().max(200).optional().default(''),
      postalCode: z.string().trim().max(20).optional().default(''),
      city: z.string().trim().max(120).optional().default(''),
      country: z.string().trim().max(80).optional().default('France'),
      notes: z.string().trim().max(4000).optional().default(''),
      isActive: z.boolean().optional().default(true)
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const isAdmin = req.user.role === 'admin';
  const offices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const allowedOfficeIds = new Set(offices.map((office) => Number(office.id)).filter((id) => Number.isInteger(id) && id > 0));

  if (!allowedOfficeIds.has(parsed.data.officeId)) {
    return res.status(403).json({ message: 'Acces refuse a ce cabinet' });
  }

  const officeExists = db.prepare('SELECT id FROM offices WHERE id = ?').get(parsed.data.officeId);
  if (!officeExists) {
    return res.status(404).json({ message: 'Cabinet introuvable' });
  }

  if (!parsed.data.firstName && !parsed.data.lastName && !parsed.data.organization) {
    return res.status(400).json({ message: 'Renseignez au moins un nom ou une organisation' });
  }

  const result = db
    .prepare(
      `INSERT INTO directory_contacts (
         office_id, kind, first_name, last_name, organization, role,
         email, mobile_phone, landline_phone,
         address_line1, address_line2, postal_code, city, country,
         notes, is_active, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      parsed.data.officeId,
      parsed.data.kind,
      parsed.data.firstName,
      parsed.data.lastName,
      parsed.data.organization,
      parsed.data.role,
      parsed.data.email,
      parsed.data.mobilePhone,
      parsed.data.landlinePhone,
      parsed.data.address1,
      parsed.data.address2,
      parsed.data.postalCode,
      parsed.data.city,
      parsed.data.country,
      parsed.data.notes,
      parsed.data.isActive ? 1 : 0,
      req.user.sub,
      req.user.sub
    );

  const row = db
    .prepare(
      `SELECT dc.id, dc.office_id, o.name AS office_name, dc.kind,
              dc.first_name, dc.last_name, dc.organization, dc.role,
              dc.email, dc.mobile_phone, dc.landline_phone,
              dc.address_line1, dc.address_line2, dc.postal_code, dc.city, dc.country,
              dc.notes, dc.is_active, dc.created_at, dc.updated_at
       FROM directory_contacts dc
       INNER JOIN offices o ON o.id = dc.office_id
       WHERE dc.id = ?`
    )
    .get(Number(result.lastInsertRowid));

  writeAuditLog(req.user.sub, 'CREATE', 'directory_contacts', String(result.lastInsertRowid), {
    officeId: parsed.data.officeId,
    kind: parsed.data.kind
  });

  return res.status(201).json({ contact: mapDirectoryContactRow(row) });
});

app.put('/api/directory/contacts/:id', authMiddleware, requirePermission('edit-directory-contact'), (req, res) => {
  const contactId = Number(req.params.id);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const parsed = z
    .object({
      officeId: z.number().int().positive(),
      kind: z.enum(['person', 'company']).optional().default('person'),
      firstName: z.string().trim().max(120).optional().default(''),
      lastName: z.string().trim().max(120).optional().default(''),
      organization: z.string().trim().max(200).optional().default(''),
      role: z.string().trim().max(120).optional().default(''),
      email: z.string().trim().max(160).optional().default(''),
      mobilePhone: z.string().trim().max(50).optional().default(''),
      landlinePhone: z.string().trim().max(50).optional().default(''),
      address1: z.string().trim().max(200).optional().default(''),
      address2: z.string().trim().max(200).optional().default(''),
      postalCode: z.string().trim().max(20).optional().default(''),
      city: z.string().trim().max(120).optional().default(''),
      country: z.string().trim().max(80).optional().default('France'),
      notes: z.string().trim().max(4000).optional().default(''),
      isActive: z.boolean().optional().default(true)
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const existing = db.prepare('SELECT id, office_id FROM directory_contacts WHERE id = ?').get(contactId);
  if (!existing) {
    return res.status(404).json({ message: 'Contact introuvable' });
  }

  const isAdmin = req.user.role === 'admin';
  const offices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const allowedOfficeIds = new Set(offices.map((office) => Number(office.id)).filter((id) => Number.isInteger(id) && id > 0));

  if (!allowedOfficeIds.has(Number(existing.office_id)) || !allowedOfficeIds.has(parsed.data.officeId)) {
    return res.status(403).json({ message: 'Acces refuse a ce cabinet' });
  }

  if (!parsed.data.firstName && !parsed.data.lastName && !parsed.data.organization) {
    return res.status(400).json({ message: 'Renseignez au moins un nom ou une organisation' });
  }

  db.prepare(
    `UPDATE directory_contacts
     SET office_id = ?, kind = ?, first_name = ?, last_name = ?, organization = ?, role = ?,
         email = ?, mobile_phone = ?, landline_phone = ?,
         address_line1 = ?, address_line2 = ?, postal_code = ?, city = ?, country = ?,
         notes = ?, is_active = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    parsed.data.officeId,
    parsed.data.kind,
    parsed.data.firstName,
    parsed.data.lastName,
    parsed.data.organization,
    parsed.data.role,
    parsed.data.email,
    parsed.data.mobilePhone,
    parsed.data.landlinePhone,
    parsed.data.address1,
    parsed.data.address2,
    parsed.data.postalCode,
    parsed.data.city,
    parsed.data.country,
    parsed.data.notes,
    parsed.data.isActive ? 1 : 0,
    req.user.sub,
    contactId
  );

  const row = db
    .prepare(
      `SELECT dc.id, dc.office_id, o.name AS office_name, dc.kind,
              dc.first_name, dc.last_name, dc.organization, dc.role,
              dc.email, dc.mobile_phone, dc.landline_phone,
              dc.address_line1, dc.address_line2, dc.postal_code, dc.city, dc.country,
              dc.notes, dc.is_active, dc.created_at, dc.updated_at
       FROM directory_contacts dc
       INNER JOIN offices o ON o.id = dc.office_id
       WHERE dc.id = ?`
    )
    .get(contactId);

  writeAuditLog(req.user.sub, 'UPDATE', 'directory_contacts', String(contactId), {
    officeId: parsed.data.officeId,
    kind: parsed.data.kind
  });

  return res.json({ contact: mapDirectoryContactRow(row) });
});

app.delete('/api/directory/contacts/:id', authMiddleware, requirePermission('delete-directory-contact'), (req, res) => {
  const contactId = Number(req.params.id);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const existing = db.prepare('SELECT id, office_id FROM directory_contacts WHERE id = ?').get(contactId);
  if (!existing) {
    return res.status(404).json({ message: 'Contact introuvable' });
  }

  const isAdmin = req.user.role === 'admin';
  const offices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const allowedOfficeIds = new Set(offices.map((office) => Number(office.id)).filter((id) => Number.isInteger(id) && id > 0));
  if (!allowedOfficeIds.has(Number(existing.office_id))) {
    return res.status(403).json({ message: 'Acces refuse a ce cabinet' });
  }

  db.prepare('DELETE FROM directory_contacts WHERE id = ?').run(contactId);
  writeAuditLog(req.user.sub, 'DELETE', 'directory_contacts', String(contactId));
  return res.status(204).send();
});

app.get('/api/directory/contacts/export', authMiddleware, requirePermission('export-directory'), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const offices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const allowedOfficeIds = new Set(offices.map((office) => Number(office.id)).filter((id) => Number.isInteger(id) && id > 0));

  if (!isAdmin && allowedOfficeIds.size === 0) {
    return res.status(403).json({ message: 'Aucun cabinet disponible pour export' });
  }

  const requestedOfficeId = Number(req.query.officeId);
  const officeIdFilter = Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 ? requestedOfficeId : null;
  if (officeIdFilter != null && !allowedOfficeIds.has(officeIdFilter)) {
    return res.status(403).json({ message: 'Acces refuse a ce cabinet' });
  }

  const whereParts = [];
  const params = [];

  if (!isAdmin) {
    const placeholders = [...allowedOfficeIds].map(() => '?').join(', ');
    whereParts.push(`dc.office_id IN (${placeholders})`);
    params.push(...allowedOfficeIds);
  }

  if (officeIdFilter != null) {
    whereParts.push('dc.office_id = ?');
    params.push(officeIdFilter);
  }

  const rows = db
    .prepare(
      `SELECT dc.id, dc.office_id, o.name AS office_name, dc.kind,
              dc.first_name, dc.last_name, dc.organization, dc.role,
              dc.email, dc.mobile_phone, dc.landline_phone,
              dc.address_line1, dc.address_line2, dc.postal_code, dc.city, dc.country,
              dc.notes, dc.is_active, dc.created_at, dc.updated_at
       FROM directory_contacts dc
       INNER JOIN offices o ON o.id = dc.office_id
       ${whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''}
       ORDER BY lower(dc.last_name) ASC, lower(dc.first_name) ASC, lower(dc.organization) ASC, dc.id ASC`
    )
    .all(...params)
    .map(mapDirectoryContactRow);

  const header = [
    'id',
    'cabinet',
    'type',
    'nom',
    'prenom',
    'organisation',
    'fonction',
    'email',
    'mobile',
    'fixe',
    'adresse1',
    'adresse2',
    'code_postal',
    'ville',
    'pays',
    'actif'
  ];

  const escapeCsv = (value) => {
    const raw = String(value ?? '');
    if (raw.includes(';') || raw.includes('"') || raw.includes('\n')) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  const lines = [header.join(';')];
  for (const row of rows) {
    lines.push([
      row.id,
      row.officeName,
      row.kind,
      row.lastName,
      row.firstName,
      row.organization,
      row.role,
      row.email,
      row.mobilePhone,
      row.landlinePhone,
      row.address1,
      row.address2,
      row.postalCode,
      row.city,
      row.country,
      row.isActive ? 'oui' : 'non'
    ].map(escapeCsv).join(';'));
  }

  const fileName = `repertoire-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  writeAuditLog(req.user.sub, 'EXPORT', 'directory_contacts', null, { count: rows.length });
  return res.status(200).send(lines.join('\n'));
});

app.get('/api/people/search', authMiddleware, requirePermission('create-patient-record'), (req, res) => {
  const query = String(req.query.search ?? '').trim().toLowerCase();
  if (query.length < 2) {
    return res.json({ contacts: [] });
  }

  const rows = db
    .prepare(
      `SELECT id, username, role, first_name, last_name
       FROM users
       WHERE is_active = 1
       ORDER BY lower(last_name) ASC, lower(first_name) ASC, lower(username) ASC`
    )
    .all();

  const contacts = rows
    .map((row) => {
      const fullName = `${String(row.last_name ?? '').trim()} ${String(row.first_name ?? '').trim()}`.trim();
      const label = fullName || String(row.username ?? '').trim();
      return {
        id: Number(row.id),
        fullName: label,
        role: String(row.role ?? '').trim()
      };
    })
    .filter((contact) =>
      contact.fullName.toLowerCase().includes(query)
    )
    .slice(0, 12);

  return res.json({ contacts });
});

app.get('/api/patients/referrals', authMiddleware, requirePermission('create-patient-record'), (req, res) => {
  const query = String(req.query.search ?? '').trim().toLowerCase();
  const rows = db.prepare('SELECT cipher_medical_notes FROM patients WHERE is_deleted = 0').all();

  const unique = new Set();
  const referrals = [];

  for (const row of rows) {
    let notes = {};
    try {
      notes = JSON.parse(decryptSensitiveField(row.cipher_medical_notes)) ?? {};
    } catch {
      notes = {};
    }

    const candidate = String(notes.referredBy ?? '').trim();
    if (!candidate) {
      continue;
    }

    if (query && !candidate.toLowerCase().includes(query)) {
      continue;
    }

    const key = candidate.toLowerCase();
    if (unique.has(key)) {
      continue;
    }

    unique.add(key);
    referrals.push(candidate);
  }

  referrals.sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  return res.json({ referrals: referrals.slice(0, 20) });
});

app.post('/api/patients', authMiddleware, requirePermission('create-patient-record'), (req, res) => {
  const parsed = createPatientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;
  const lastName = payload.lastName.trim();
  const firstName = payload.firstName.trim();
  const fullName = `${lastName} ${firstName}`.trim();
  const mobilePhone = payload.mobilePhone.trim();
  const landlinePhone = payload.landlinePhone.trim();
  const mainPhone = mobilePhone || landlinePhone || 'Non renseigne';

  const retentionDate = new Date();
  retentionDate.setFullYear(retentionDate.getFullYear() + 10);
  const retentionUntil = retentionDate.toISOString().slice(0, 10);

  const normalizedRelatedPeople = formatRelatedPeople(parseRelatedPeople(payload.relatedPeople));

  const medicalRecord = {
    generalRemarks: payload.generalRemarks.trim(),
    medicalHistory: payload.medicalHistory.trim(),
    consultationNote: payload.consultationNote.trim(),
    relatedPeople: normalizedRelatedPeople,
    mobilePhone,
    landlinePhone,
    email: payload.email.trim(),
    address1: payload.address1.trim(),
    address2: payload.address2.trim(),
    postalCode: payload.postalCode.trim(),
    city: payload.city.trim(),
    country: payload.country.trim() || 'France',
    occupationOrSchool: payload.occupationOrSchool.trim(),
    hobbies: payload.hobbies.trim(),
    primaryDoctor: payload.primaryDoctor.trim(),
    socialSecurityNumber: payload.socialSecurityNumber.trim(),
    referredBy: payload.referredBy.trim(),
    manualPreference: normalizeManualPreference(payload.manualPreference),
    isDeceased: Boolean(payload.isDeceased)
  };

  const antecedentCategories = extractAntecedentCategories(payload.medicalHistory);

  const birthDate = payload.birthDate.trim();
  const inserted = db
    .prepare(
      `INSERT INTO patients
       (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, last_visit, consent_signed, retention_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      encryptSensitiveField(fullName),
      encryptSensitiveField(mainPhone),
      encryptSensitiveField(JSON.stringify(medicalRecord)),
      payload.sex === 'Femme' ? 'F' : payload.sex === 'Homme' ? 'M' : 'Non renseigne',
      birthDate || null,
      null,
      1,
      retentionUntil
    );

  writeAuditLog(req.user.sub, 'CREATE', 'patients', String(inserted.lastInsertRowid), {
    fullName,
    sex: payload.sex
  });

  storeAntecedentTypes(antecedentCategories);
  insertConsultationFromNote(Number(inserted.lastInsertRowid), payload.consultationNote, {
    userId: req.user.sub,
    linkStrategy: payload.consultationLinkStrategy === 'create-new' ? 'create-new' : 'attach-existing'
  });
  synchronizeBidirectionalRelatedPeople({
    targetPatientId: Number(inserted.lastInsertRowid),
    targetCurrentFullName: fullName,
    targetPreviousFullName: fullName,
    previousRelatedPeople: '',
    nextRelatedPeople: normalizedRelatedPeople
  });

  db.prepare(
    `DELETE FROM patient_drafts
     WHERE user_id = ? AND flow_key = 'new_patient'`
  ).run(req.user.sub);

  return res.status(201).json({
    patient: {
      id: inserted.lastInsertRowid,
      fullName
    }
  });
});

app.get('/api/patients', authMiddleware, requirePermission('read-patient-list'), (req, res) => {
  const query = String(req.query.search ?? '').trim().toLowerCase();

  const rows = db
    .prepare(
      `SELECT p.id,
              p.cipher_full_name,
              p.cipher_phone,
              p.last_visit,
              p.sex,
              p.birth_date,
              COALESCE(a.consultation_count, 0) AS consultation_count
       FROM patients p
       LEFT JOIN (
         SELECT patient_id, COUNT(*) AS consultation_count
         FROM appointments
         GROUP BY patient_id
       ) a ON a.patient_id = p.id
       WHERE p.is_deleted = 0`
    )
    .all();

  const patients = rows
    .map((row) => ({
      id: row.id,
      fullName: decryptSensitiveField(row.cipher_full_name),
      phone: decryptSensitiveField(row.cipher_phone),
      lastVisit: row.last_visit ?? '',
      sex: row.sex === 'F' ? 'Femme' : row.sex === 'M' ? 'Homme' : 'Non renseigne',
      age: getAgeFromBirthDate(row.birth_date),
      consultationCount: Number(row.consultation_count ?? 0)
    }))
    .filter((patient) => (query ? patient.fullName.toLowerCase().includes(query) : true));

  writeAuditLog(req.user.sub, 'READ_LIST', 'patients', null, { count: patients.length });
  return res.json({ patients });
});

app.get('/api/patients/locations', authMiddleware, requirePermission('search-patient-list'), (req, res) => {
  const postalQuery = String(req.query.postalCode ?? '').trim().toLowerCase();
  const cityQuery = String(req.query.city ?? '').trim().toLowerCase();
  const requestedLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(5000, Math.floor(requestedLimit))) : 100;

  const rows = db
    .prepare('SELECT cipher_medical_notes FROM patients WHERE is_deleted = 0')
    .all();

  const seen = new Set();
  const locations = [];

  for (const row of rows) {
    let notes;
    try {
      notes = JSON.parse(decryptSensitiveField(row.cipher_medical_notes));
    } catch {
      continue;
    }

    const postalCode = String(notes?.postalCode ?? '').trim();
    const city = String(notes?.city ?? '').trim();

    if (!postalCode || !city) {
      continue;
    }

    const postalNormalized = postalCode.toLowerCase();
    const cityNormalized = city.toLowerCase();

    if (postalQuery && !postalNormalized.includes(postalQuery)) {
      continue;
    }
    if (cityQuery && !cityNormalized.includes(cityQuery)) {
      continue;
    }

    const key = `${postalNormalized}|${cityNormalized}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    locations.push({ postalCode, city });
  }

  locations.sort((a, b) => {
    if (a.postalCode !== b.postalCode) {
      return a.postalCode.localeCompare(b.postalCode, 'fr');
    }
    return a.city.localeCompare(b.city, 'fr');
  });

  return res.json({ locations: locations.slice(0, limit) });
});

app.get('/api/patients/count', authMiddleware, requirePermission('read-patient-list'), (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS total FROM patients WHERE is_deleted = 0').get();
  return res.json({ count: row.total });
});

app.get('/api/patients/count', authMiddleware, requirePermission('read-patient-list'), (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS total FROM patients WHERE is_deleted = 0').get();
  return res.json({ count: row.total });
});

app.get('/api/patients/:id', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalide' });

  const row = db
    .prepare(
      `SELECT p.id, p.cipher_full_name, p.cipher_phone, p.cipher_medical_notes,
              p.sex, p.birth_date, p.last_visit,
              COALESCE(a.consultation_count, 0) AS consultation_count
       FROM patients p
       LEFT JOIN (
         SELECT patient_id, COUNT(*) AS consultation_count
         FROM appointments
         GROUP BY patient_id
       ) a ON a.patient_id = p.id
       WHERE p.id = ? AND p.is_deleted = 0`
    )
    .get(id);

  if (!row) return res.status(404).json({ message: 'Patient introuvable' });

  const fullName = decryptSensitiveField(row.cipher_full_name);
  const phone = decryptSensitiveField(row.cipher_phone);
  let notes = {};
  try { notes = JSON.parse(decryptSensitiveField(row.cipher_medical_notes)) ?? {}; } catch { notes = {}; }

  const spaceIdx = fullName.indexOf(' ');
  const lastName = spaceIdx >= 0 ? fullName.slice(0, spaceIdx) : fullName;
  const firstName = spaceIdx >= 0 ? fullName.slice(spaceIdx + 1) : '';

  writeAuditLog(req.user.sub, 'READ_DETAIL', 'patients', String(id));

  return res.json({
    patient: {
      id: row.id,
      fullName,
      lastName,
      firstName,
      sex: row.sex === 'F' ? 'Femme' : row.sex === 'M' ? 'Homme' : 'Non renseigne',
      birthDate: row.birth_date ?? '',
      age: getAgeFromBirthDate(row.birth_date),
      lastVisit: row.last_visit ?? '',
      consultationCount: Number(row.consultation_count ?? 0),
      phone,
      mobilePhone: notes.mobilePhone ?? (phone !== 'Non renseigne' ? phone : ''),
      landlinePhone: notes.landlinePhone ?? '',
      email: notes.email ?? '',
      address1: notes.address1 ?? '',
      address2: notes.address2 ?? '',
      postalCode: notes.postalCode ?? '',
      city: notes.city ?? '',
      country: notes.country ?? 'France',
      occupationOrSchool: notes.occupationOrSchool ?? '',
      hobbies: notes.hobbies ?? '',
      primaryDoctor: notes.primaryDoctor ?? '',
      socialSecurityNumber: notes.socialSecurityNumber ?? '',
      referredBy: notes.referredBy ?? '',
      manualPreference: normalizeManualPreference(notes.manualPreference),
      generalRemarks: notes.generalRemarks ?? '',
      medicalHistory: notes.medicalHistory ?? '',
      relatedPeople: notes.relatedPeople ?? '',
      isDeceased: Boolean(notes.isDeceased)
    }
  });
});

app.get('/api/patients/:id/consultations', authMiddleware, requirePermission('read-consultation-detail'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalide' });

  const patient = db.prepare('SELECT id FROM patients WHERE id = ? AND is_deleted = 0').get(id);
  if (!patient) return res.status(404).json({ message: 'Patient introuvable' });

  let consultationRows = [];
  try {
    consultationRows = db
      .prepare(
        `SELECT id, started_at, practitioner, title, important, height_cm, weight_kg,
                eva_before, eva_after, profile,
                motif_main_cipher, tests_cipher, schema_cipher, treatments_cipher, remarks_cipher
         FROM consultations WHERE patient_id = ? ORDER BY started_at DESC`
      )
      .all(id);
  } catch { consultationRows = []; }

  const appointmentRows = db
    .prepare('SELECT id, starts_at, reason_cipher, status FROM appointments WHERE patient_id = ? ORDER BY starts_at DESC')
    .all(id);

  const consultations = consultationRows.map((row) => ({
    id: row.id,
    type: 'consultation',
    startedAt: row.started_at,
    practitioner: row.practitioner ?? '',
    title: row.title ?? '',
    important: Boolean(row.important),
    heightCm: row.height_cm ?? null,
    weightKg: row.weight_kg ?? null,
    evaBefore: row.eva_before ?? 0,
    evaAfter: row.eva_after ?? 0,
    profile: row.profile ?? 'Adulte',
    motifMainHtml: row.motif_main_cipher ? decryptSensitiveField(row.motif_main_cipher) : '',
    testsHtml: row.tests_cipher ? decryptSensitiveField(row.tests_cipher) : '',
    schemaHtml: row.schema_cipher ? decryptSensitiveField(row.schema_cipher) : '',
    treatmentsHtml: row.treatments_cipher ? decryptSensitiveField(row.treatments_cipher) : '',
    remarksHtml: row.remarks_cipher ? decryptSensitiveField(row.remarks_cipher) : '',
    status: 'Termine'
  }));

  const consultationDates = new Set(consultations.map((c) => c.startedAt.slice(0, 10)));
  const appointments = appointmentRows
    .filter((row) => !consultationDates.has(row.starts_at.slice(0, 10)))
    .map((row) => ({
      id: row.id,
      type: 'appointment',
      startedAt: row.starts_at,
      practitioner: '',
      title: decryptSensitiveField(row.reason_cipher),
      important: false,
      heightCm: null,
      weightKg: null,
      evaBefore: 0,
      evaAfter: 0,
      profile: 'Adulte',
      motifMainHtml: '',
      testsHtml: '',
      schemaHtml: '',
      treatmentsHtml: '',
      remarksHtml: '',
      status: row.status
    }));

  const all = [...consultations, ...appointments].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return res.json({ consultations: all });
});

app.get('/api/patients/:id/audit-logs', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalide' });

  const patient = db.prepare('SELECT id FROM patients WHERE id = ? AND is_deleted = 0').get(id);
  if (!patient) return res.status(404).json({ message: 'Patient introuvable' });

  const rows = db
    .prepare(
      `SELECT l.id, l.created_at, l.metadata, u.username
       FROM audit_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.entity = 'patients' AND l.entity_id = ? AND l.action = 'UPDATE'
       ORDER BY datetime(l.created_at) ASC, l.id ASC`
    )
    .all(String(id));

  const logs = rows
    .map((row) => {
      let metadata = {};
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : {};
      } catch {
        metadata = {};
      }

      const changes = Array.isArray(metadata.changes)
        ? metadata.changes
            .map((change) => ({
              field: String(change?.field ?? '').trim(),
              before: String(change?.before ?? ''),
              after: String(change?.after ?? '')
            }))
            .filter((change) => change.field.length > 0)
        : [];

      return {
        id: row.id,
        createdAt: row.created_at,
        username: row.username ?? 'system',
        changes
      };
    })
    .filter((entry) => entry.changes.length > 0);

  return res.json({ logs });
});

app.put('/api/patients/:id', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalide' });

  const parsed = updatePatientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Payload invalide' });

  const existing = db
    .prepare('SELECT cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date FROM patients WHERE id = ? AND is_deleted = 0')
    .get(id);
  if (!existing) return res.status(404).json({ message: 'Patient introuvable' });

  const existingFullName = decryptSensitiveField(existing.cipher_full_name);
  const existingPhone = decryptSensitiveField(existing.cipher_phone);
  let existingNotes = {};
  try { existingNotes = JSON.parse(decryptSensitiveField(existing.cipher_medical_notes)) ?? {}; } catch { existingNotes = {}; }

  const existingRelatedPeople = String(existingNotes.relatedPeople ?? '');
  const data = parsed.data;
  let fullName;
  if (data.lastName !== undefined || data.firstName !== undefined) {
    const existingSpaceIdx = existingFullName.indexOf(' ');
    const existingLast = existingSpaceIdx >= 0 ? existingFullName.slice(0, existingSpaceIdx) : existingFullName;
    const existingFirst = existingSpaceIdx >= 0 ? existingFullName.slice(existingSpaceIdx + 1) : '';
    const lastN = (data.lastName ?? existingLast).trim();
    const firstN = (data.firstName ?? existingFirst).trim();
    fullName = `${lastN} ${firstN}`.trim();
  } else {
    fullName = data.fullName !== undefined ? data.fullName.trim() : existingFullName;
  }

  const updatedNotes = {
    ...existingNotes,
    ...(data.mobilePhone !== undefined && { mobilePhone: data.mobilePhone.trim() }),
    ...(data.landlinePhone !== undefined && { landlinePhone: data.landlinePhone.trim() }),
    ...(data.email !== undefined && { email: data.email.trim() }),
    ...(data.address1 !== undefined && { address1: data.address1.trim() }),
    ...(data.address2 !== undefined && { address2: data.address2.trim() }),
    ...(data.postalCode !== undefined && { postalCode: data.postalCode.trim() }),
    ...(data.city !== undefined && { city: data.city.trim() }),
    ...(data.country !== undefined && { country: data.country.trim() }),
    ...(data.occupationOrSchool !== undefined && { occupationOrSchool: data.occupationOrSchool.trim() }),
    ...(data.hobbies !== undefined && { hobbies: data.hobbies.trim() }),
    ...(data.primaryDoctor !== undefined && { primaryDoctor: data.primaryDoctor.trim() }),
    ...(data.socialSecurityNumber !== undefined && { socialSecurityNumber: data.socialSecurityNumber.trim() }),
    ...(data.referredBy !== undefined && { referredBy: data.referredBy.trim() }),
    ...(data.manualPreference !== undefined && { manualPreference: normalizeManualPreference(data.manualPreference) }),
    ...(data.generalRemarks !== undefined && { generalRemarks: data.generalRemarks.trim() }),
    ...(data.relatedPeople !== undefined && { relatedPeople: formatRelatedPeople(parseRelatedPeople(data.relatedPeople)) }),
    ...(data.medicalHistory !== undefined && { medicalHistory: data.medicalHistory.trim() })
  };

  const beforeSnapshot = {
    fullName: existingFullName,
    sex: existing.sex === 'F' ? 'Femme' : existing.sex === 'M' ? 'Homme' : 'Non renseigne',
    birthDate: existing.birth_date ?? '',
    mobilePhone: String(existingNotes.mobilePhone ?? '').trim() || (existingPhone !== 'Non renseigne' ? existingPhone : ''),
    landlinePhone: String(existingNotes.landlinePhone ?? '').trim(),
    email: existingNotes.email ?? '',
    address1: existingNotes.address1 ?? '',
    address2: existingNotes.address2 ?? '',
    postalCode: existingNotes.postalCode ?? '',
    city: existingNotes.city ?? '',
    country: existingNotes.country ?? '',
    occupationOrSchool: existingNotes.occupationOrSchool ?? '',
    hobbies: existingNotes.hobbies ?? '',
    primaryDoctor: existingNotes.primaryDoctor ?? '',
    socialSecurityNumber: existingNotes.socialSecurityNumber ?? '',
    referredBy: existingNotes.referredBy ?? '',
    manualPreference: normalizeManualPreference(existingNotes.manualPreference),
    generalRemarks: existingNotes.generalRemarks ?? '',
    relatedPeople: existingNotes.relatedPeople ?? '',
    medicalHistory: existingNotes.medicalHistory ?? ''
  };

  const newSex =
    data.sex !== undefined
      ? data.sex === 'Femme' ? 'F' : data.sex === 'Homme' ? 'M' : 'Non renseigne'
      : existing.sex;

  const newBirthDate =
    data.birthDate !== undefined ? (data.birthDate.trim() || null) : existing.birth_date;

  const nextMobilePhone = data.mobilePhone !== undefined
    ? data.mobilePhone.trim()
    : String(existingNotes.mobilePhone ?? '').trim();
  const nextLandlinePhone = data.landlinePhone !== undefined
    ? data.landlinePhone.trim()
    : String(existingNotes.landlinePhone ?? '').trim();
  const newMainPhone = nextMobilePhone || nextLandlinePhone || existingPhone || 'Non renseigne';

  const afterSnapshot = {
    fullName,
    sex: newSex === 'F' ? 'Femme' : newSex === 'M' ? 'Homme' : 'Non renseigne',
    birthDate: newBirthDate ?? '',
    mobilePhone: nextMobilePhone,
    landlinePhone: nextLandlinePhone,
    email: updatedNotes.email ?? '',
    address1: updatedNotes.address1 ?? '',
    address2: updatedNotes.address2 ?? '',
    postalCode: updatedNotes.postalCode ?? '',
    city: updatedNotes.city ?? '',
    country: updatedNotes.country ?? '',
    occupationOrSchool: updatedNotes.occupationOrSchool ?? '',
    hobbies: updatedNotes.hobbies ?? '',
    primaryDoctor: updatedNotes.primaryDoctor ?? '',
    socialSecurityNumber: updatedNotes.socialSecurityNumber ?? '',
    referredBy: updatedNotes.referredBy ?? '',
    manualPreference: normalizeManualPreference(updatedNotes.manualPreference),
    generalRemarks: updatedNotes.generalRemarks ?? '',
    relatedPeople: updatedNotes.relatedPeople ?? '',
    medicalHistory: updatedNotes.medicalHistory ?? ''
  };

  const changes = buildPatientUpdateChanges(beforeSnapshot, afterSnapshot);

  db.prepare(
    `UPDATE patients SET
       cipher_full_name = ?,
       cipher_phone = ?,
       cipher_medical_notes = ?,
       sex = ?,
       birth_date = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    encryptSensitiveField(fullName),
    encryptSensitiveField(newMainPhone),
    encryptSensitiveField(JSON.stringify(updatedNotes)),
    newSex,
    newBirthDate,
    id
  );

  synchronizeBidirectionalRelatedPeople({
    targetPatientId: id,
    targetCurrentFullName: fullName,
    targetPreviousFullName: existingFullName,
    previousRelatedPeople: existingRelatedPeople,
    nextRelatedPeople: String(updatedNotes.relatedPeople ?? '')
  });

  if (data.medicalHistory !== undefined) {
    storeAntecedentTypes(extractAntecedentCategories(data.medicalHistory));
  }

  writeAuditLog(req.user.sub, 'UPDATE', 'patients', String(id), {
    changedFieldCount: changes.length,
    changes
  });
  return res.status(204).send();
});

app.get('/api/patients/:id/export', authMiddleware, requirePermission('export-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const row = db
    .prepare(
      `SELECT id, cipher_full_name, cipher_phone, cipher_medical_notes,
              sex, birth_date, last_visit, consent_signed, retention_until,
              created_at, updated_at
       FROM patients WHERE id = ? AND is_deleted = 0`
    )
    .get(id);

  if (!row) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const fullName = decryptSensitiveField(row.cipher_full_name);
  const phone = decryptSensitiveField(row.cipher_phone);

  let notes = {};
  try {
    notes = JSON.parse(decryptSensitiveField(row.cipher_medical_notes)) ?? {};
  } catch {
    notes = {};
  }

  let consultationRows = [];
  try {
    consultationRows = db
      .prepare(
        `SELECT id, started_at, practitioner, title, important, height_cm, weight_kg,
                eva_before, eva_after, profile,
                motif_main_cipher, tests_cipher, schema_cipher, treatments_cipher, remarks_cipher
         FROM consultations WHERE patient_id = ? ORDER BY started_at DESC`
      )
      .all(id);
  } catch {
    consultationRows = [];
  }

  const appointmentRows = db
    .prepare('SELECT id, starts_at, reason_cipher, status, created_at FROM appointments WHERE patient_id = ? ORDER BY starts_at DESC')
    .all(id);

  const consultations = consultationRows.map((consultation) => ({
    id: consultation.id,
    startedAt: consultation.started_at,
    practitioner: consultation.practitioner ?? '',
    title: consultation.title ?? '',
    important: Boolean(consultation.important),
    heightCm: consultation.height_cm ?? null,
    weightKg: consultation.weight_kg ?? null,
    evaBefore: consultation.eva_before ?? 0,
    evaAfter: consultation.eva_after ?? 0,
    profile: consultation.profile ?? 'Adulte',
    motifMain: consultation.motif_main_cipher ? decryptSensitiveField(consultation.motif_main_cipher) : '',
    tests: consultation.tests_cipher ? decryptSensitiveField(consultation.tests_cipher) : '',
    schema: consultation.schema_cipher ? decryptSensitiveField(consultation.schema_cipher) : '',
    treatments: consultation.treatments_cipher ? decryptSensitiveField(consultation.treatments_cipher) : '',
    remarks: consultation.remarks_cipher ? decryptSensitiveField(consultation.remarks_cipher) : ''
  }));

  const appointments = appointmentRows.map((appointment) => ({
    id: appointment.id,
    startsAt: appointment.starts_at,
    reason: decryptSensitiveField(appointment.reason_cipher),
    status: appointment.status,
    createdAt: appointment.created_at
  }));

  const auditRows = db
    .prepare(
      `SELECT l.id, l.created_at, l.action, l.metadata, u.username
       FROM audit_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.entity = 'patients' AND l.entity_id = ?
       ORDER BY datetime(l.created_at) ASC, l.id ASC`
    )
    .all(String(id));

  const auditTrail = auditRows.map((entry) => {
    let metadata = null;
    try {
      metadata = entry.metadata ? JSON.parse(entry.metadata) : null;
    } catch {
      metadata = null;
    }

    return {
      id: entry.id,
      at: entry.created_at,
      action: entry.action,
      by: entry.username ?? 'system',
      metadata
    };
  });

  const rgpdPayload = {
    meta: {
      kind: 'rgpd-patient-export',
      exportedAt: new Date().toISOString(),
      patientId: row.id
    },
    patient: {
      id: row.id,
      fullName,
      sex: row.sex === 'F' ? 'Femme' : row.sex === 'M' ? 'Homme' : 'Non renseigne',
      birthDate: row.birth_date ?? '',
      phone,
      mobilePhone: notes.mobilePhone ?? (phone !== 'Non renseigne' ? phone : ''),
      landlinePhone: notes.landlinePhone ?? '',
      email: notes.email ?? '',
      address1: notes.address1 ?? '',
      address2: notes.address2 ?? '',
      postalCode: notes.postalCode ?? '',
      city: notes.city ?? '',
      country: notes.country ?? 'France',
      generalRemarks: notes.generalRemarks ?? '',
      medicalHistory: notes.medicalHistory ?? '',
      consultationNote: notes.consultationNote ?? '',
      relatedPeople: notes.relatedPeople ?? '',
      isDeceased: Boolean(notes.isDeceased),
      lastVisit: row.last_visit ?? '',
      consentSigned: Boolean(row.consent_signed),
      retentionUntil: row.retention_until ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    },
    appointments,
    consultations,
    auditTrail
  };

  writeAuditLog(req.user.sub, 'EXPORT', 'patients', String(id), {
    exportType: 'rgpd'
  });

  const safeName = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `patient-${id}`;

  const fileName = `rgpd-export-${safeName}-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(JSON.stringify(rgpdPayload, null, 2));
});

app.post('/api/patients/:id/anonymize', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const updated = db
    .prepare(
      `UPDATE patients
       SET cipher_full_name = ?,
           cipher_phone = ?,
           cipher_medical_notes = ?,
           is_deleted = 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .run(
      encryptSensitiveField('ANONYMIZED'),
      encryptSensitiveField('ANONYMIZED'),
      encryptSensitiveField('ANONYMIZED'),
      id
    );

  if (!updated.changes) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  writeAuditLog(req.user.sub, 'ANONYMIZE', 'patients', String(id));
  return res.status(204).send();
});

function normalizePatientSexLabel(rawSex) {
  if (rawSex === 'F') {
    return 'Femme';
  }
  if (rawSex === 'M') {
    return 'Homme';
  }
  return 'Non renseigne';
}

function parsePatientNotesFromCipher(cipherMedicalNotes) {
  try {
    const decrypted = decryptSensitiveField(cipherMedicalNotes);
    const parsed = JSON.parse(decrypted);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function inferConsultationType(reason) {
  const normalized = String(reason ?? '').toLowerCase();
  if (normalized.includes('urgence') || normalized.includes('aigu')) {
    return 'Urgence';
  }
  if (normalized.includes('bilan') || normalized.includes('premier')) {
    return 'Bilan';
  }
  if (normalized.includes('suivi') || normalized.includes('controle')) {
    return 'Suivi';
  }
  return 'Consultation';
}

app.get('/api/appointments', authMiddleware, requirePermission('read-agenda'), (req, res) => {
  const requestedOfficeId = Number(req.query.officeId);
  const officeIdFilter = Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 ? requestedOfficeId : null;
  const agendaConfig = readAgendaSettings(req.user.sub, officeIdFilter);
  const accessibleCalendarIds = new Set(getAccessibleCalendarIdsForUser(req.user.sub, officeIdFilter));
  const userOffices = getUserOfficeOptions(req.user.sub);
  const fallbackCalendar = agendaConfig.localCalendars[0] ?? null;

  const rows = db
    .prepare(
      `SELECT a.id, a.starts_at, a.reason_cipher, a.status, a.local_calendar_id,
              p.cipher_full_name, p.cipher_phone, p.cipher_medical_notes, p.sex
       FROM appointments a
       INNER JOIN patients p ON p.id = a.patient_id
       WHERE p.is_deleted = 0
       ORDER BY a.starts_at ASC`
    )
    .all();

  const currentUser = db.prepare('SELECT id, color_hex FROM users WHERE id = ?').get(req.user.sub);
  const practitionerColor = normalizeColorHex(currentUser?.color_hex, '#4d92d1');

  const appointments = rows
    .filter((row) => {
      const rowCalendarId = row.local_calendar_id != null ? Number(row.local_calendar_id) : null;
      const effectiveCalendarId = rowCalendarId ?? (fallbackCalendar?.id ?? null);
      if (effectiveCalendarId == null) {
        return false;
      }
      return accessibleCalendarIds.has(effectiveCalendarId);
    })
    .map((row) => ({
      id: Number(row.id),
      time: new Intl.DateTimeFormat('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(row.starts_at)),
      patient: decryptSensitiveField(row.cipher_full_name),
      reason: decryptSensitiveField(row.reason_cipher),
      status: row.status
    }));

  const stats = {
    consultationsToday: appointments.length,
    newPatients: 1,
    occupancyRate: '87%'
  };

  writeAuditLog(req.user.sub, 'READ_LIST', 'appointments', null, { count: appointments.length });
  return res.json({
    appointments,
    stats,
    agendaSettings: agendaConfig.settings,
    localCalendars: agendaConfig.localCalendars,
    practitionerColor,
    offices: userOffices,
    selectedOfficeId: officeIdFilter
  });
});

app.post('/api/appointments', authMiddleware, requirePermission('write-agenda'), (req, res) => {
  const { patientId, startsAt, reason, status, localCalendarId, consultationId } = req.body;

  // Validate required fields
  if (!Number.isInteger(Number(patientId)) || Number(patientId) <= 0) {
    return res.status(400).json({ error: 'Invalid patientId' });
  }

  if (typeof startsAt !== 'string' || !startsAt.trim()) {
    return res.status(400).json({ error: 'Invalid startsAt' });
  }

  if (typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'Invalid reason' });
  }

  const validStatuses = ['A confirmer', 'En attente', 'Termine'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // Verify patient exists
  const patient = db.prepare('SELECT id FROM patients WHERE id = ? AND is_deleted = 0').get(patientId);
  if (!patient) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  const effectiveCalendarId = Number.isInteger(Number(localCalendarId)) && Number(localCalendarId) > 0 ? Number(localCalendarId) : null;
  const effectiveConsultationId = Number.isInteger(Number(consultationId)) && Number(consultationId) > 0 ? Number(consultationId) : null;

  if (effectiveConsultationId !== null) {
    const consultation = db
      .prepare('SELECT id, patient_id FROM consultations WHERE id = ?')
      .get(effectiveConsultationId);
    if (!consultation) {
      return res.status(404).json({ error: 'Consultation not found' });
    }
    if (Number(consultation.patient_id) !== Number(patientId)) {
      return res.status(400).json({ error: 'Consultation does not belong to patient' });
    }
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO appointments (patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(patientId, startsAt, encryptSensitiveField(reason.trim()), status, effectiveCalendarId, effectiveConsultationId);

    const newAppointment = db
      .prepare(
        `SELECT a.id, a.starts_at, a.reason_cipher, a.status, a.local_calendar_id,
                p.cipher_full_name, p.sex
         FROM appointments a
         INNER JOIN patients p ON p.id = a.patient_id
         WHERE a.id = ?`
      )
      .get(result.lastInsertRowid);

    res.status(201).json({
      appointment: {
        id: Number(newAppointment.id),
        time: new Intl.DateTimeFormat('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date(newAppointment.starts_at)),
        patient: decryptSensitiveField(newAppointment.cipher_full_name),
        reason: decryptSensitiveField(newAppointment.reason_cipher),
        status: newAppointment.status
      }
    });
  } catch (ex) {
    logger.error('Failed to create appointment:', ex);
    return res.status(500).json({ error: 'Failed to create appointment' });
  }
});


app.get('/api/dashboard', authMiddleware, requirePermission('read-dashboard'), (req, res) => {
  const requestedOfficeId = Number(req.query.officeId);
  const officeIdFilter = Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 ? requestedOfficeId : null;
  const agendaConfig = readAgendaSettings(req.user.sub, officeIdFilter);
  const accessibleCalendarIds = new Set(getAccessibleCalendarIdsForUser(req.user.sub, officeIdFilter));

  const appointmentRows = db
    .prepare(
      `SELECT a.id, a.starts_at, a.reason_cipher, a.status, a.local_calendar_id,
              a.patient_id,
              p.cipher_full_name, p.cipher_phone, p.cipher_medical_notes, p.sex,
              c.id AS consultation_id, c.title AS consultation_title, c.practitioner AS consultation_practitioner
       FROM appointments a
       INNER JOIN patients p ON p.id = a.patient_id
       LEFT JOIN consultations c ON c.id = COALESCE(
         a.consultation_id,
         (
           SELECT c2.id
           FROM consultations c2
           WHERE c2.patient_id = a.patient_id AND date(c2.started_at) = date(a.starts_at)
           ORDER BY datetime(c2.started_at) DESC, c2.id DESC
           LIMIT 1
         )
       )
       WHERE p.is_deleted = 0
       ORDER BY a.starts_at ASC`
    )
    .all();

  const currentUser = db.prepare('SELECT id, color_hex FROM users WHERE id = ?').get(req.user.sub);
  const practitionerColor = normalizeColorHex(currentUser?.color_hex, '#4d92d1');
  const calendarById = new Map(agendaConfig.localCalendars.map((calendar) => [Number(calendar.id), calendar]));
  const fallbackCalendar = agendaConfig.localCalendars[0] ?? null;
  const filteredAppointmentRows = appointmentRows.filter((row) => {
    const rowCalendarId = row.local_calendar_id != null ? Number(row.local_calendar_id) : null;
    const effectiveCalendarId = rowCalendarId ?? (fallbackCalendar?.id ?? null);
    if (effectiveCalendarId == null) {
      return false;
    }
    return accessibleCalendarIds.has(effectiveCalendarId);
  });

  const events = filteredAppointmentRows
    .map((row) => {
      const reason = decryptSensitiveField(row.reason_cipher);
      const patient = decryptSensitiveField(row.cipher_full_name);
      const patientPhone = decryptSensitiveField(row.cipher_phone);
      const notes = parsePatientNotesFromCipher(row.cipher_medical_notes);
      const patientSex = normalizePatientSexLabel(row.sex);
      const patientMobilePhone = String(notes.mobilePhone ?? patientPhone ?? '').trim();
      const patientLandlinePhone = String(notes.landlinePhone ?? '').trim();
      const patientRemarks = String(notes.generalRemarks ?? '').trim();
      const consultationType = agendaConfig.settings.autoConsultationType ? inferConsultationType(reason) : '';
      const rowCalendarId = row.local_calendar_id != null ? Number(row.local_calendar_id) : null;
      const calendar = rowCalendarId != null ? (calendarById.get(rowCalendarId) ?? fallbackCalendar) : fallbackCalendar;
      const effectiveCalendarId = calendar?.id ?? null;

      return {
        id: Number(row.id),
        patientId: Number(row.patient_id),
        title: reason,
        start: row.starts_at,
        patient,
        reason,
        status: row.status,
        calendarId: effectiveCalendarId,
        calendarColor: calendar?.colorHex ?? null,
        practitionerColor,
        patientSex,
        patientMobilePhone,
        patientLandlinePhone,
        appointmentComment: reason,
        patientRemarks,
        consultationType,
        consultationId: row.consultation_id != null ? Number(row.consultation_id) : null,
        consultationTitle: String(row.consultation_title ?? '').trim(),
        consultationPractitioner: String(row.consultation_practitioner ?? '').trim()
      };
    });

  const monthFormatter = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });
  const monthSlots = [];
  const monthlyCounters = new Map();

  for (let offset = 11; offset >= 0; offset -= 1) {
    const slotDate = new Date();
    slotDate.setDate(1);
    slotDate.setHours(0, 0, 0, 0);
    slotDate.setMonth(slotDate.getMonth() - offset);
    const key = `${slotDate.getFullYear()}-${String(slotDate.getMonth() + 1).padStart(2, '0')}`;
    monthSlots.push({
      key,
      label: monthFormatter.format(slotDate).replace('.', '')
    });
    monthlyCounters.set(key, 0);
  }

  for (const row of filteredAppointmentRows) {
    const date = new Date(row.starts_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (monthlyCounters.has(key)) {
      monthlyCounters.set(key, Number(monthlyCounters.get(key)) + 1);
    }
  }

  const monthlyConsultations = monthSlots.map((slot) => ({
    month: slot.label,
    count: Number(monthlyCounters.get(slot.key) ?? 0)
  }));

  const patientRows = db
    .prepare(
      `SELECT id, cipher_full_name, cipher_phone, sex, birth_date, last_visit
       FROM patients
       WHERE is_deleted = 0`
    )
    .all();

  const sexMap = new Map([
    ['Femme', 0],
    ['Homme', 0],
    ['Non renseigne', 0]
  ]);
  const ageMap = new Map([
    ['0-17', 0],
    ['18-29', 0],
    ['30-44', 0],
    ['45-59', 0],
    ['60+', 0],
    ['Non renseigne', 0]
  ]);

  for (const row of patientRows) {
    const normalizedSex = row.sex === 'F' ? 'Femme' : row.sex === 'M' ? 'Homme' : 'Non renseigne';
    sexMap.set(normalizedSex, Number(sexMap.get(normalizedSex)) + 1);

    const ageRange = getAgeRangeFromBirthDate(row.birth_date);
    ageMap.set(ageRange, Number(ageMap.get(ageRange)) + 1);
  }

  const patientsBySex = Array.from(sexMap.entries()).map(([label, count]) => ({ label, count }));
  const patientsByAgeRange = Array.from(ageMap.entries()).map(([label, count]) => ({ label, count }));

  const recentPatients = patientRows
    .filter((row) => Boolean(row.last_visit))
    .sort((a, b) => b.last_visit.localeCompare(a.last_visit))
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      fullName: decryptSensitiveField(row.cipher_full_name),
      phone: decryptSensitiveField(row.cipher_phone),
      lastVisit: formatDateFr(row.last_visit)
    }));

  const pendingPayments = db
    .prepare(
      `SELECT i.invoice_number, i.amount_cents, i.due_at, i.status, p.cipher_full_name
       FROM invoices i
       INNER JOIN patients p ON p.id = i.patient_id
       WHERE p.is_deleted = 0 AND i.status != 'payee'
       ORDER BY i.due_at ASC`
    )
    .all()
    .map((row) => ({
      invoiceNumber: row.invoice_number,
      patientName: decryptSensitiveField(row.cipher_full_name),
      amountEur: Number((row.amount_cents / 100).toFixed(2)),
      dueAt: formatDateFr(row.due_at),
      status: row.status
    }));

  writeAuditLog(req.user.sub, 'READ_DASHBOARD', 'dashboard', null, {
    events: events.length,
    recentPatients: recentPatients.length,
    pendingPayments: pendingPayments.length
  });

  return res.json({
    events,
    monthlyConsultations,
    patientsBySex,
    patientsByAgeRange,
    recentPatients,
    pendingPayments,
    agendaSettings: agendaConfig.settings,
    localCalendars: agendaConfig.localCalendars
  });
});

app.get('/api/appointments/:id/patient', authMiddleware, requirePermission('read-dashboard'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID de rendez-vous invalide' });
  }

  const row = db.prepare('SELECT patient_id FROM appointments WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ message: 'Rendez-vous introuvable' });
  }

  return res.json({ patientId: Number(row.patient_id) });
});

app.patch('/api/appointments/:id/consultation-meta', authMiddleware, requirePermission('read-dashboard'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID de rendez-vous invalide' });
  }

  const parsed = z
    .object({
      title: z.string().trim().max(255).optional(),
      practitioner: z.string().trim().max(255).optional(),
      linkStrategy: z.enum(['attach-existing', 'create-new']).optional()
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const appointment = db
    .prepare('SELECT id, patient_id, starts_at, consultation_id FROM appointments WHERE id = ?')
    .get(id);

  if (!appointment) {
    return res.status(404).json({ message: 'Rendez-vous introuvable' });
  }

  const title = String(parsed.data.title ?? '').trim();
  const practitioner = String(parsed.data.practitioner ?? '').trim();
  const linkStrategy = parsed.data.linkStrategy;

  let existingConsultation = null;
  if (appointment.consultation_id != null) {
    existingConsultation = db
      .prepare('SELECT id, title, practitioner, started_at FROM consultations WHERE id = ?')
      .get(appointment.consultation_id);
  }

  if (!existingConsultation) {
    existingConsultation = db
      .prepare(
        `SELECT id, title, practitioner, started_at
         FROM consultations
         WHERE patient_id = ? AND date(started_at) = date(?)
         ORDER BY datetime(started_at) DESC, id DESC
         LIMIT 1`
      )
      .get(appointment.patient_id, appointment.starts_at);
  }

  if (existingConsultation && appointment.consultation_id == null && !linkStrategy) {
    return res.status(409).json({
      message: 'Une consultation existe deja sur ce creneau.',
      conflict: {
        existingConsultation: {
          id: Number(existingConsultation.id),
          title: String(existingConsultation.title ?? '').trim(),
          practitioner: String(existingConsultation.practitioner ?? '').trim(),
          startedAt: String(existingConsultation.started_at ?? appointment.starts_at)
        }
      }
    });
  }

  let consultationId;
  let linkedToExisting = false;
  if (existingConsultation && (appointment.consultation_id != null || linkStrategy !== 'create-new')) {
    consultationId = Number(existingConsultation.id);
    db.prepare('UPDATE consultations SET title = ?, practitioner = ? WHERE id = ?').run(
      title,
      practitioner,
      consultationId
    );
    linkedToExisting = true;
  } else {
    const created = db
      .prepare(
        `INSERT INTO consultations (
           patient_id, started_at, practitioner, title, important,
           eva_before, eva_after, profile
         ) VALUES (?, ?, ?, ?, 0, 0, 0, 'Adulte')`
      )
      .run(appointment.patient_id, appointment.starts_at, practitioner, title);
    consultationId = Number(created.lastInsertRowid);
  }

  db.prepare('UPDATE appointments SET consultation_id = ? WHERE id = ?').run(consultationId, id);

  writeAuditLog(req.user.sub, 'UPDATE', 'consultations', String(consultationId), {
    source: 'agenda-modal',
    appointmentId: id,
    title,
    practitioner
  });

  return res.json({
    consultation: {
      id: consultationId,
      title,
      practitioner,
      linkedToExisting
    }
  });
});

app.get('/api/invoices/summary', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const rows = db
    .prepare('SELECT amount_cents, status FROM invoices')
    .all();

  const monthlyRevenue = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  const unpaid = rows.filter((row) => row.status !== 'payee').reduce((sum, row) => sum + row.amount_cents, 0);

  const summary = [
    {
      label: 'CA mensuel',
      value: `${(monthlyRevenue / 100).toFixed(2)} EUR`,
      trend: '+12%'
    },
    {
      label: 'Impayes',
      value: `${(unpaid / 100).toFixed(2)} EUR`,
      trend: unpaid > 0 ? '+5%' : '-10%'
    },
    {
      label: 'Factures',
      value: String(rows.length),
      trend: '+3'
    }
  ];

  writeAuditLog(req.user.sub, 'READ_LIST', 'invoices', null, { count: rows.length });
  return res.json({ summary });
});

await ensureSeedData();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Secure SQLite API ready on http://localhost:${port}`);
});
