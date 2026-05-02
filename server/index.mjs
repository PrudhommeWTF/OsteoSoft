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
import { fileTypeFromBuffer } from 'file-type';
import helmet from 'helmet';
import JSZip from 'jszip';
import jwt from 'jsonwebtoken';
import XLSX from 'xlsx';
import { z } from 'zod';

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT ?? 3000);
const dataDir = path.resolve(process.cwd(), 'server/data');
const dbPath = path.resolve(dataDir, 'osteo.db');
const jwtSecret = process.env.JWT_SECRET ?? 'dev-only-jwt-secret-change-me';
const isProduction = process.env.NODE_ENV === 'production';
const allowRemoteSetup = /^(1|true|yes)$/i.test(String(process.env.ALLOW_REMOTE_SETUP ?? 'false'));
const SUPER_ADMIN_PROFILE_ID = 'super-admin';
const requestBodyLimit = process.env.API_BODY_LIMIT ?? '5mb';
const largeRequestBodyLimit = process.env.API_LARGE_BODY_LIMIT ?? '60mb';
const MAX_PATIENT_DOCUMENT_BYTES = Number(process.env.MAX_PATIENT_DOCUMENT_BYTES ?? 15 * 1024 * 1024);
const trustedProxies = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1'
  ? 1
  : (process.env.TRUST_PROXY === 'loopback' ? 'loopback' : false);
const SESSION_COOKIE_NAME = 'os_session';
const SESSION_COOKIE_PATH = '/';
const SESSION_REMEMBER_MAX_AGE_MS = Number(process.env.SESSION_REMEMBER_MAX_AGE_MS ?? 12 * 60 * 60 * 1000);
const SESSION_DEFAULT_MAX_AGE_MS = Number(process.env.SESSION_DEFAULT_MAX_AGE_MS ?? 2 * 60 * 60 * 1000);
const SESSION_REMEMBER_TTL = process.env.SESSION_REMEMBER_TTL ?? '12h';
const SESSION_DEFAULT_TTL = process.env.SESSION_DEFAULT_TTL ?? '2h';
const CURRENT_CONSENT_FORM_VERSION = '1.0';

if (isProduction && jwtSecret === 'dev-only-jwt-secret-change-me') {
  throw new Error('JWT_SECRET must be configured in production.');
}

if (!isProduction && jwtSecret === 'dev-only-jwt-secret-change-me') {
  console.warn('WARNING: Using development JWT secret. Set JWT_SECRET for safer local environments.');
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('secure_delete = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');

// Migration: Rename patient_drafts table to draft
try {
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='patient_drafts'`
  ).get();
  
  if (tableExists) {
    // Check if draft table already exists
    const draftExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='draft'`
    ).get();
    
    if (!draftExists) {
      // Rename the table
      db.exec('ALTER TABLE patient_drafts RENAME TO draft');
      console.log('✓ Migrated patient_drafts table to draft');
    }
  }
} catch (err) {
  console.warn('Migration check failed (may be normal if tables don\'t exist yet):', err.message);
}

// Migration: add office_id and consultation_id to invoices table
try {
  const cols = db.prepare(`PRAGMA table_info(invoices)`).all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('office_id')) {
    db.exec('ALTER TABLE invoices ADD COLUMN office_id INTEGER REFERENCES offices(id) ON DELETE SET NULL');
    console.log('✓ Added office_id column to invoices');
  }
  if (cols.length > 0 && !cols.includes('consultation_id')) {
    db.exec('ALTER TABLE invoices ADD COLUMN consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL');
    console.log('✓ Added consultation_id column to invoices');
  }
  if (cols.length > 0 && !cols.includes('payment_method')) {
    db.exec("ALTER TABLE invoices ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
    console.log('✓ Added payment_method column to invoices');
  }
} catch (err) {
  console.warn('invoices migration failed:', err.message);
}

// Migration: add system_key to payment_methods and backfill known defaults
try {
  const cols = db.prepare(`PRAGMA table_info(payment_methods)`).all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('system_key')) {
    db.exec("ALTER TABLE payment_methods ADD COLUMN system_key TEXT NOT NULL DEFAULT ''");
    console.log('✓ Added system_key column to payment_methods');
  }
} catch (err) {
  console.warn('payment_methods migration failed:', err.message);
}

// Migration: add bordereau metadata columns for accounting_deposits
try {
  const cols = db.prepare(`PRAGMA table_info(accounting_deposits)`).all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('deposit_code')) {
    db.exec("ALTER TABLE accounting_deposits ADD COLUMN deposit_code TEXT NOT NULL DEFAULT ''");
    console.log('✓ Added deposit_code column to accounting_deposits');
  }
  if (cols.length > 0 && !cols.includes('bank_name')) {
    db.exec("ALTER TABLE accounting_deposits ADD COLUMN bank_name TEXT NOT NULL DEFAULT ''");
    console.log('✓ Added bank_name column to accounting_deposits');
  }
  if (cols.length > 0 && !cols.includes('account_label')) {
    db.exec("ALTER TABLE accounting_deposits ADD COLUMN account_label TEXT NOT NULL DEFAULT ''");
    console.log('✓ Added account_label column to accounting_deposits');
  }
} catch (err) {
  console.warn('accounting_deposits migration failed:', err.message);
}

// Migration: add GDPR consent detail columns to patients table
try {
  const cols = db.prepare(`PRAGMA table_info(patients)`).all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('consent_signed_at')) {
    db.exec('ALTER TABLE patients ADD COLUMN consent_signed_at TEXT');
    console.log('✓ Added consent_signed_at column to patients');
  }
  if (cols.length > 0 && !cols.includes('consent_form_version')) {
    db.exec("ALTER TABLE patients ADD COLUMN consent_form_version TEXT NOT NULL DEFAULT '1.0'");
    console.log('✓ Added consent_form_version column to patients');
  }
  if (cols.length > 0 && !cols.includes('consent_withdrawn_at')) {
    db.exec('ALTER TABLE patients ADD COLUMN consent_withdrawn_at TEXT');
    console.log('✓ Added consent_withdrawn_at column to patients');
  }
} catch (err) {
  console.warn('patients consent columns migration failed:', err.message);
}

// Migration: add must_change_password column to users table
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    console.log('✓ Added must_change_password column to users');
  }
} catch (err) {
  console.warn('users must_change_password migration failed:', err.message);
}

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
    bank_name_cipher TEXT NOT NULL DEFAULT '',
    iban_cipher TEXT NOT NULL DEFAULT '',
    retrocession_percent REAL NOT NULL DEFAULT 0,
    retrocession_recipient TEXT NOT NULL DEFAULT '',
    default_agenda_view TEXT NOT NULL DEFAULT 'Semaine',
    visible_calendars TEXT NOT NULL DEFAULT 'Tous les calendriers',
    default_service TEXT NOT NULL DEFAULT 'Aucune prestation',
    invoice_mentions TEXT NOT NULL DEFAULT '',
    must_change_password INTEGER NOT NULL DEFAULT 0,
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
    marital_status TEXT NOT NULL DEFAULT 'Non renseigne',
    children_count INTEGER NOT NULL DEFAULT 0,
    last_visit TEXT,
    consent_signed INTEGER NOT NULL DEFAULT 1,
    consent_signed_at TEXT,
    consent_form_version TEXT NOT NULL DEFAULT '1.0',
    consent_withdrawn_at TEXT,
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
    office_id INTEGER,
    local_calendar_id INTEGER,
    consultation_id INTEGER,
    practitioner TEXT NOT NULL DEFAULT '',
    is_private INTEGER NOT NULL DEFAULT 0,
    private_label_cipher TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL,
    FOREIGN KEY(local_calendar_id) REFERENCES local_calendars(id) ON DELETE SET NULL,
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
    office_id INTEGER,
    consultation_id INTEGER,
    payment_method TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL,
    FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS invoice_line_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit_amount_ht_cents INTEGER NOT NULL DEFAULT 0,
    vat_rate REAL NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invoice_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    payment_method TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    bank_name_cipher TEXT NOT NULL DEFAULT '',
    cheque_number TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS patient_payment_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    office_id INTEGER,
    paid_at TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    remaining_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    payment_method TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    bank_name_cipher TEXT NOT NULL DEFAULT '',
    cheque_number TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS patient_payment_credit_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    credit_id INTEGER NOT NULL,
    invoice_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    allocated_at TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(credit_id) REFERENCES patient_payment_credits(id) ON DELETE CASCADE,
    FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS accounting_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    office_id INTEGER,
    owner_user_id INTEGER,
    title TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    payment_method TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    retrocession_percent REAL NOT NULL DEFAULT 0,
    retrocession_recipient TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL,
    FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS accounting_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    office_id INTEGER,
    owner_user_id INTEGER,
    type TEXT NOT NULL DEFAULT 'cheque',
    deposit_code TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    bank_name_cipher TEXT NOT NULL DEFAULT '',
    account_label TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    notes TEXT NOT NULL DEFAULT '',
    retrocession_percent REAL NOT NULL DEFAULT 0,
    retrocession_recipient TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL,
    FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS accounting_deposit_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deposit_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(deposit_id) REFERENCES accounting_deposits(id) ON DELETE CASCADE,
    UNIQUE(deposit_id, source_type, source_id)
  );

  CREATE TABLE IF NOT EXISTS accounting_operation_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    owner_user_id INTEGER,
    retrocession_percent REAL NOT NULL DEFAULT 0,
    retrocession_recipient TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(source_type, source_id)
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
    system_key TEXT,
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
    invoice_template_layout_json TEXT NOT NULL DEFAULT '{}',
    address_line1 TEXT,
    address_line2 TEXT,
    postal_code TEXT,
    city TEXT,
    phone_mobile TEXT,
    phone_landline TEXT,
    phone_fax TEXT,
    email TEXT,
    website TEXT,
    siret TEXT,
    adeli_code TEXT,
    rpps_code TEXT,
    ape_naf_code TEXT,
    vat_number TEXT,
    logo_data TEXT,
    opening_hours_json TEXT NOT NULL DEFAULT '{"monday":[],"tuesday":[],"wednesday":[],"thursday":[],"friday":[],"saturday":[],"sunday":[]}',
    consultation_profiles_json TEXT NOT NULL DEFAULT '[]',
    payment_reminder_letter_title TEXT NOT NULL DEFAULT '',
    payment_reminder_letter_content TEXT NOT NULL DEFAULT '',
    patient_letters_json TEXT NOT NULL DEFAULT '[]',
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

  CREATE TABLE IF NOT EXISTS office_user_delegations (
    office_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (office_id, user_id),
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(profile_id) REFERENCES access_profiles(id)
  );

  CREATE TABLE IF NOT EXISTS user_preference (
    user_id INTEGER PRIMARY KEY,
    slot_duration_minutes INTEGER NOT NULL DEFAULT 15,
    display_height INTEGER NOT NULL DEFAULT 14,
    theme_mode TEXT NOT NULL DEFAULT 'system',
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

  CREATE TABLE IF NOT EXISTS patient_antecedents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    date_precision TEXT NOT NULL DEFAULT 'date',
    date_display TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    important INTEGER NOT NULL DEFAULT 0,
    sort_key INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS draft (
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
    office_id INTEGER,
    practitioner TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    important INTEGER NOT NULL DEFAULT 0,
    height_cm REAL,
    weight_kg REAL,
    eva_before INTEGER NOT NULL DEFAULT 0,
    eva_after INTEGER NOT NULL DEFAULT 0,
    profile TEXT NOT NULL DEFAULT 'Adulte',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS consultation_reason_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consultation_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    important INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS consultation_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consultation_id INTEGER NOT NULL,
    section_key TEXT NOT NULL,
    content_cipher TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
    UNIQUE(consultation_id, section_key)
  );

  CREATE TABLE IF NOT EXISTS patient_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_ref TEXT NOT NULL UNIQUE,
    patient_id INTEGER NOT NULL,
    consultation_id INTEGER,
    office_id INTEGER,
    created_by INTEGER,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    title_cipher TEXT,
    comment_cipher TEXT,
    content_cipher TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE SET NULL,
    FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
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

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_office_id ON users(office_id);

  CREATE INDEX IF NOT EXISTS idx_patients_is_deleted_last_visit ON patients(is_deleted, last_visit);

  CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_office_starts_at ON appointments(office_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_appointments_calendar_starts_at ON appointments(local_calendar_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_appointments_consultation_id ON appointments(consultation_id);

  CREATE INDEX IF NOT EXISTS idx_consultations_patient_started_at ON consultations(patient_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_consultations_office_started_at ON consultations(office_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_consultation_reason_items_consultation_order ON consultation_reason_items(consultation_id, display_order);
  CREATE INDEX IF NOT EXISTS idx_consultation_sections_consultation_key ON consultation_sections(consultation_id, section_key);

  CREATE INDEX IF NOT EXISTS idx_invoices_patient_status ON invoices(patient_id, status);
  CREATE INDEX IF NOT EXISTS idx_invoices_status_due_at ON invoices(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_invoices_office_id ON invoices(office_id);
  CREATE INDEX IF NOT EXISTS idx_invoices_consultation_id ON invoices(consultation_id);
  CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_order ON invoice_line_items(invoice_id, display_order);
  CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice_paid_at ON invoice_payments(invoice_id, paid_at);
  CREATE INDEX IF NOT EXISTS idx_patient_payment_credits_patient_paid_at ON patient_payment_credits(patient_id, paid_at);
  CREATE INDEX IF NOT EXISTS idx_patient_payment_credits_office_id ON patient_payment_credits(office_id);
  CREATE INDEX IF NOT EXISTS idx_patient_payment_credit_allocations_credit_id ON patient_payment_credit_allocations(credit_id);
  CREATE INDEX IF NOT EXISTS idx_patient_payment_credit_allocations_invoice_id ON patient_payment_credit_allocations(invoice_id);

  CREATE INDEX IF NOT EXISTS idx_directory_contacts_office_kind ON directory_contacts(office_id, kind);
  CREATE INDEX IF NOT EXISTS idx_directory_contacts_office_name_sort ON directory_contacts(office_id, last_name, first_name, organization);

  CREATE INDEX IF NOT EXISTS idx_user_offices_office_user ON user_offices(office_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_office_user_delegations_user_office ON office_user_delegations(user_id, office_id);

  CREATE INDEX IF NOT EXISTS idx_service_types_office_order ON service_types(office_id, display_order);
  CREATE INDEX IF NOT EXISTS idx_payment_methods_office_order_active ON payment_methods(office_id, display_order, is_active);
  CREATE INDEX IF NOT EXISTS idx_local_calendars_office_order ON local_calendars(office_id, display_order);

  CREATE INDEX IF NOT EXISTS idx_patient_documents_patient_created_at ON patient_documents(patient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_patient_documents_consultation_id ON patient_documents(consultation_id);
  CREATE INDEX IF NOT EXISTS idx_patient_documents_office_id ON patient_documents(office_id);
  CREATE INDEX IF NOT EXISTS idx_patient_antecedents_patient_sort_key ON patient_antecedents(patient_id, sort_key);

  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created_at ON audit_logs(user_id, created_at);
`);

const rawDataKey = process.env.OSTEOSOFT_DATA_KEY;

if (isProduction && !rawDataKey) {
  throw new Error(
    'OSTEOSOFT_DATA_KEY must be configured in production. ' +
    'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
  );
}

if (!isProduction && !rawDataKey) {
  console.warn('WARNING: Using development encryption key. Set OSTEOSOFT_DATA_KEY.');
}

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

function updateEnvFile(key, value) {
  const envPath = path.resolve(process.cwd(), '.env');
  const tempPath = `${envPath}.tmp`;
  let content = '';
  try {
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    }
  } catch {
    content = '';
  }
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content ? `${content.trimEnd()}\n${line}\n` : `${line}\n`;
  }
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, envPath);
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

function safeDecryptField(cipherText) {
  const text = String(cipherText ?? '');
  try {
    return decryptSensitiveField(text);
  } catch {
    return text;
  }
}

function restoreCipherField(value) {
  const text = String(value ?? '');
  if (!text) {
    return encryptSensitiveField('');
  }
  try {
    decryptSensitiveField(text);
    return text;
  } catch {
    return encryptSensitiveField(text);
  }
}

function signTokenForSession(user, remember) {
  const tokenTtl = remember ? SESSION_REMEMBER_TTL : SESSION_DEFAULT_TTL;
  const payload = { sub: user.id, role: user.role, username: user.username };
  if (user.must_change_password === 1) {
    payload.mcp = true;
  }
  return jwt.sign(payload, jwtSecret, {
    algorithm: 'HS256',
    expiresIn: tokenTtl
  });
}

function buildSessionCookieOptions(remember) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: SESSION_COOKIE_PATH,
    maxAge: remember ? SESSION_REMEMBER_MAX_AGE_MS : SESSION_DEFAULT_MAX_AGE_MS
  };
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: SESSION_COOKIE_PATH
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
  statistics: ['read-dashboard', 'read-advanced-statistics', 'read-peer-statistics', 'export-statistics'],
  'contact-directory': ['read-directory', 'create-directory-contact', 'edit-directory-contact', 'delete-directory-contact', 'export-directory'],
  'office-management': [
    'read-office-settings',
    'create-office',
    'update-office-settings',
    'delete-office',
    'reorder-offices',
    'manage-data-backup-restore',
    'manage-data-rgpd',
    'manage-data-import',
    'manage-data-cleanup'
  ]
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

function mergeAccessRights(rightsList) {
  const merged = buildAccessRights(false);

  for (const rights of Array.isArray(rightsList) ? rightsList : []) {
    const normalized = normalizeAccessRights(rights, false);
    for (const [domainId, domainRights] of Object.entries(normalized)) {
      for (const [permissionId, enabled] of Object.entries(domainRights)) {
        if (enabled === true) {
          merged[domainId][permissionId] = true;
        }
      }
    }
  }

  return merged;
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

const anonymizePatientTx = db.transaction((patientId) => {
  const anonymizedValue = encryptSensitiveField('ANONYMIZED');

  db.prepare('DELETE FROM patient_antecedents WHERE patient_id = ?').run(patientId);
  db.prepare('DELETE FROM patient_documents WHERE patient_id = ?').run(patientId);

  db.prepare(
    `DELETE FROM consultation_sections
     WHERE consultation_id IN (
       SELECT id FROM consultations WHERE patient_id = ?
     )`
  ).run(patientId);

  db.prepare(
    `DELETE FROM consultation_reason_items
     WHERE consultation_id IN (
       SELECT id FROM consultations WHERE patient_id = ?
     )`
  ).run(patientId);

  db.prepare('DELETE FROM consultations WHERE patient_id = ?').run(patientId);

  db.prepare(
    `UPDATE appointments
     SET reason_cipher = ?
     WHERE patient_id = ?`
  ).run(anonymizedValue, patientId);

  db.prepare(
    `UPDATE invoices
     SET notes_cipher = ?
     WHERE patient_id = ?`
  ).run(anonymizedValue, patientId);

  db.prepare(
    `UPDATE patient_payment_credits
     SET bank_name = '', bank_name_cipher = '', cheque_number = '', reference = '', notes = ''
     WHERE patient_id = ?`
  ).run(patientId);

  db.prepare(
    `UPDATE patients
     SET cipher_full_name = ?,
         cipher_phone = ?,
         cipher_medical_notes = ?,
         is_deleted = 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(anonymizedValue, anonymizedValue, anonymizedValue, patientId);

  db.prepare("DELETE FROM audit_logs WHERE entity = 'patients' AND entity_id = ?")
    .run(String(patientId));
});

function processExpiredPatients() {
  const today = new Date().toISOString().slice(0, 10);

  const expired = db.prepare(
    `SELECT id, retention_until FROM patients
     WHERE is_deleted = 0
       AND retention_until IS NOT NULL
       AND retention_until < ?`
  ).all(today);

  for (const { id, retention_until: retentionUntil } of expired) {
    anonymizePatientTx(id);
    writeAuditLog(null, 'AUTO_ANONYMIZE', 'patients', String(id), {
      reason: 'retention_expired',
      retentionUntil
    });
  }

  return expired.length;
}

function shouldAutoTraceRequest(req) {
  const method = String(req.method ?? '').toUpperCase();
  if (['OPTIONS', 'HEAD'].includes(method)) {
    return false;
  }

  const route = String(req.originalUrl ?? '').split('?')[0];
  if (!route.startsWith('/api/')) {
    return false;
  }

  // Avoid noisy self-referential traces when reading audit endpoints.
  if (route === '/api/audit-logs' || route === '/api/audit-logs/security/setup') {
    return false;
  }

  return true;
}

function writeAuthSecurityLog(req, event, details = {}) {
  try {
    const route = String(req.originalUrl ?? '').split('?')[0] || null;
    const remoteAddress = String(req.socket?.remoteAddress ?? req.ip ?? '').trim() || null;
    const forwardedFor = String(req.headers?.['x-forwarded-for'] ?? '').trim() || null;
    const userAgent = String(req.headers?.['user-agent'] ?? '').trim() || null;

    writeAuditLog(null, 'SECURITY', 'auth', null, {
      event,
      method: String(req.method ?? '').toUpperCase(),
      route,
      remoteAddress,
      forwardedFor,
      userAgent,
      ...details
    });
  } catch (error) {
    console.warn('Unable to write auth security log:', error instanceof Error ? error.message : error);
  }
}

function mapAuditLogRow(row) {
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

// Migration: encrypt plaintext sensitive fields in patient_antecedents and consultation_reason_items
try {
  const migrationDone = getConfigValue('migration_sensitive_fields_v1', '0');
  if (migrationDone !== '1') {
    db.transaction(() => {
      const antecedentRows = db.prepare(
        'SELECT id, date_display, description FROM patient_antecedents'
      ).all();
      const updateAntecedent = db.prepare(
        'UPDATE patient_antecedents SET date_display = ?, description = ? WHERE id = ?'
      );
      for (const row of antecedentRows) {
        updateAntecedent.run(
          restoreCipherField(String(row.date_display ?? '')),
          restoreCipherField(String(row.description ?? '')),
          row.id
        );
      }

      const reasonRows = db.prepare(
        'SELECT id, value FROM consultation_reason_items'
      ).all();
      const updateReason = db.prepare(
        'UPDATE consultation_reason_items SET value = ? WHERE id = ?'
      );
      for (const row of reasonRows) {
        updateReason.run(restoreCipherField(String(row.value ?? '')), row.id);
      }

      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('migration_sensitive_fields_v1', '1')"
      ).run();
    })();
    console.log('✓ Encrypted sensitive fields in patient_antecedents and consultation_reason_items');
  }
} catch (err) {
  console.warn('Sensitive field encryption migration failed:', err.message);
}

// Migration: encrypt historical patient audit before/after values stored in clear text
try {
  const migrationDone = getConfigValue('migration_patient_audit_encryption_v1', '0');
  if (migrationDone !== '1') {
    const encryptedCount = db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT id, metadata
           FROM audit_logs
           WHERE entity = 'patients' AND action = 'UPDATE' AND metadata IS NOT NULL AND trim(metadata) <> ''`
        )
        .all();

      const updateMetadata = db.prepare('UPDATE audit_logs SET metadata = ? WHERE id = ?');
      let changedRows = 0;

      for (const row of rows) {
        let metadata;
        try {
          metadata = JSON.parse(String(row.metadata ?? '{}'));
        } catch {
          continue;
        }

        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
          continue;
        }

        const rawChanges = metadata.changes;
        if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
          continue;
        }

        let hasPlainValues = false;
        const encryptedChanges = rawChanges.map((change) => {
          if (!change || typeof change !== 'object' || Array.isArray(change)) {
            return change;
          }

          const field = String(change.field ?? '').trim();
          if (!field) {
            return change;
          }

          const hasCipherValues =
            Object.prototype.hasOwnProperty.call(change, 'beforeCipher') ||
            Object.prototype.hasOwnProperty.call(change, 'afterCipher');
          if (hasCipherValues) {
            return {
              field,
              beforeCipher: String(change.beforeCipher ?? ''),
              afterCipher: String(change.afterCipher ?? '')
            };
          }

          hasPlainValues = true;
          const before = normalizeAuditValue(change.before);
          const after = normalizeAuditValue(change.after);

          return {
            field,
            beforeCipher: encryptSensitiveField(before),
            afterCipher: encryptSensitiveField(after)
          };
        });

        if (!hasPlainValues) {
          continue;
        }

        updateMetadata.run(JSON.stringify({ ...metadata, changes: encryptedChanges }), row.id);
        changedRows += 1;
      }

      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('migration_patient_audit_encryption_v1', '1')"
      ).run();

      return changedRows;
    })();

    if (encryptedCount > 0) {
      console.log(`✓ Encrypted patient audit before/after values in ${encryptedCount} log entrie(s)`);
    }
  }
} catch (err) {
  console.warn('Patient audit encryption migration failed:', err.message);
}

// Migration: encrypt plaintext fullName stored in CREATE patient audit logs
try {
  const migrationDone = getConfigValue('migration_patient_create_audit_encryption_v1', '0');
  if (migrationDone !== '1') {
    const encryptedCount = db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT id, metadata
           FROM audit_logs
           WHERE entity = 'patients' AND action = 'CREATE' AND metadata IS NOT NULL AND trim(metadata) <> ''`
        )
        .all();

      const updateMetadata = db.prepare('UPDATE audit_logs SET metadata = ? WHERE id = ?');
      let changedRows = 0;

      for (const row of rows) {
        let metadata;
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          continue;
        }

        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
          continue;
        }

        if (!Object.prototype.hasOwnProperty.call(metadata, 'fullName')) {
          continue;
        }

        const plainFullName = String(metadata.fullName ?? '').trim();
        if (!plainFullName) {
          continue;
        }

        let nameCipher;
        try {
          nameCipher = encryptSensitiveField(plainFullName);
        } catch {
          continue;
        }

        const { fullName: _removed, ...rest } = metadata;
        updateMetadata.run(
          JSON.stringify({ ...rest, nameCipher }),
          row.id
        );
        changedRows += 1;
      }

      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('migration_patient_create_audit_encryption_v1', '1')"
      ).run();

      return changedRows;
    })();

    if (encryptedCount > 0) {
      console.log(`✓ Encrypted fullName in ${encryptedCount} patient CREATE audit log entries`);
    }
  }
} catch (err) {
  console.warn('Patient CREATE audit encryption migration failed:', err.message);
}

// Migration: encrypt legacy draft payloads stored in plaintext
try {
  const migrationDone = getConfigValue('migration_draft_encryption_v1', '0');
  if (migrationDone !== '1') {
    const encryptedCount = db.transaction(() => {
      const rows = db.prepare('SELECT user_id, flow_key, draft_json FROM draft').all();
      const updateDraft = db.prepare(
        'UPDATE draft SET draft_json = ? WHERE user_id = ? AND flow_key = ?'
      );
      let changedRows = 0;

      for (const row of rows) {
        const raw = String(row.draft_json ?? '');
        const encrypted = restoreCipherField(raw);
        if (encrypted === raw) {
          continue;
        }

        updateDraft.run(encrypted, Number(row.user_id), String(row.flow_key ?? ''));
        changedRows += 1;
      }

      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('migration_draft_encryption_v1', '1')"
      ).run();

      return changedRows;
    })();

    if (encryptedCount > 0) {
      console.log(`✓ Encrypted ${encryptedCount} draft entrie(s)`);
    }
  }
} catch (err) {
  console.warn('Draft encryption migration failed:', err.message);
}

function normalizeUserAgendaPreferences(rawValue) {
  const source = rawValue && typeof rawValue === 'object' ? rawValue : {};

  const slotDurationMinutes = Number.isInteger(source.slotDurationMinutes)
    ? Math.min(Math.max(source.slotDurationMinutes, 5), 50)
    : 15;

  const displayHeight = Number.isInteger(source.displayHeight)
    ? Math.min(Math.max(source.displayHeight, 14), 35)
    : 14;

  const themeMode = ['system', 'light', 'dark'].includes(source.themeMode)
    ? source.themeMode
    : 'system';

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
    themeMode,
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
          `SELECT slot_duration_minutes, display_height, theme_mode, pdf_display_mode,
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
      themeMode: getConfigValue('settings_theme_mode', 'system'),
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
    themeMode: row.theme_mode,
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
      theme_mode,
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id)
    DO UPDATE SET
      slot_duration_minutes = excluded.slot_duration_minutes,
      display_height = excluded.display_height,
      theme_mode = excluded.theme_mode,
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
    preferences.themeMode,
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

function normalizeOfficeConsultationProfiles(rawProfiles) {
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  return rawProfiles
    .map((profile, index) => {
      if (!profile || typeof profile !== 'object') {
        return null;
      }

      const id = String(profile.id ?? '').trim() || `profile-${index + 1}`;
      const name = String(profile.name ?? '').trim() || `Profil ${index + 1}`;
      const reasons = Array.isArray(profile.reasons)
        ? profile.reasons
          .map((reason) => String(reason ?? '').trim())
          .filter((reason) => reason.length > 0)
        : [];

      return {
        id,
        name,
        reasons,
        displayOrder: index + 1
      };
    })
    .filter(Boolean);
}

function parseOfficeConsultationProfiles(rawJson) {
  if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
    return [];
  }

  try {
    return normalizeOfficeConsultationProfiles(JSON.parse(rawJson));
  } catch {
    return [];
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

function clampInvoiceTemplateLayoutValue(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function defaultInvoiceTemplateLayout() {
  return {
    logo: { x: 4, y: 4, w: 24 },
    practitioner: { x: 30, y: 4, w: 32 },
    patient: { x: 64, y: 4, w: 32 },
    invoiceMeta: { x: 64, y: 20, w: 32 },
    lineItems: { x: 4, y: 32, w: 92 },
    totals: { x: 56, y: 74, w: 40 },
    payment: { x: 4, y: 74, w: 50 },
    mentions: { x: 4, y: 86, w: 92 },
    signature: { x: 60, y: 92, w: 36 }
  };
}

function normalizeInvoiceTemplateLayoutJson(rawValue) {
  const normalized = defaultInvoiceTemplateLayout();
  let source = {};

  if (typeof rawValue === 'string' && rawValue.trim()) {
    try {
      const parsed = JSON.parse(rawValue);
      if (parsed && typeof parsed === 'object') {
        source = parsed;
      }
    } catch {
      source = {};
    }
  } else if (rawValue && typeof rawValue === 'object') {
    source = rawValue;
  }

  for (const [key, fallback] of Object.entries(normalized)) {
    const candidate = source?.[key];
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const next = {
      x: clampInvoiceTemplateLayoutValue(candidate.x, 0, 96, fallback.x),
      y: clampInvoiceTemplateLayoutValue(candidate.y, 0, 96, fallback.y),
      w: clampInvoiceTemplateLayoutValue(candidate.w, 20, 96, fallback.w)
    };

    if (next.x + next.w > 100) {
      next.x = Math.max(0, 100 - next.w);
    }

    normalized[key] = next;
  }

  return JSON.stringify(normalized);
}

function normalizeOfficeLetterTitle(rawValue) {
  return String(rawValue ?? '').trim().slice(0, 200);
}

function normalizeOfficeLetterContent(rawValue) {
  return String(rawValue ?? '').trim().slice(0, 20000);
}

const DEFAULT_PAYMENT_REMINDER_LETTER_TITLE = 'Relance de règlement';
const DEFAULT_PAYMENT_REMINDER_LETTER_CONTENT = `{$CIVILITE},

Suite à la consultation ostéopathique du {$DATECONSULTATION}, il apparaît que la somme de {$MONTANTCONSULTATION} {$DEVISE} n'a pas été réglée à ce jour. Si ceci n'est pas une erreur de ma part, je vous prie de bien vouloir régulariser cette situation par retour de courrier.

Je vous remercie par avance, et vous prie d'agréer mes sincères salutations.`;

function normalizePatientLetterTemplates(rawValue) {
  let arr;
  try {
    arr = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
  } catch {
    arr = [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => ({
    title: String(item?.title ?? '').trim().slice(0, 200),
    content: String(item?.content ?? '').trim().slice(0, 20000)
  }));
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
      `SELECT id, system_key, label, is_active, display_order
       FROM payment_methods
       WHERE office_id = ?
       ORDER BY display_order ASC, id ASC`
    )
    .all(officeId)
    .map((row) => ({
      id: Number(row.id),
      systemKey: String(row.system_key ?? '').trim() || null,
      isSystem: ['cb', 'especes', 'cheque'].includes(String(row.system_key ?? '').trim()),
      label: String(row.label ?? '').trim(),
      isActive: Number(row.is_active) === 1,
      displayOrder: Number(row.display_order ?? 0)
    }));
}

function readOfficeUserDelegations(officeId) {
  return db
    .prepare(
      `SELECT oud.user_id,
              oud.profile_id,
              u.username,
              u.first_name,
              u.last_name,
              ap.label AS profile_label
       FROM office_user_delegations oud
       INNER JOIN users u ON u.id = oud.user_id
       LEFT JOIN access_profiles ap ON ap.id = oud.profile_id
       WHERE oud.office_id = ?
       ORDER BY lower(u.username) ASC, oud.user_id ASC`
    )
    .all(officeId)
    .map((row) => {
      const firstName = String(row.first_name ?? '').trim();
      const lastName = String(row.last_name ?? '').trim();
      const displayName = `${firstName} ${lastName}`.trim() || String(row.username ?? '').trim();
      return {
        userId: Number(row.user_id),
        profileId: String(row.profile_id ?? '').trim(),
        username: String(row.username ?? '').trim(),
        displayName,
        profileLabel: String(row.profile_label ?? '').trim()
      };
    });
}

function normalizeOfficeUserDelegationsPayload(officeId, rawDelegations) {
  const normalizedOfficeId = Number(officeId);
  if (!Number.isInteger(normalizedOfficeId) || normalizedOfficeId <= 0 || !Array.isArray(rawDelegations)) {
    return [];
  }

  const allowedUserIds = new Set(
    db
      .prepare('SELECT id FROM users WHERE is_active = 1 ORDER BY id ASC')
      .all()
      .map((row) => Number(row.id))
      .filter((value) => Number.isInteger(value) && value > 0)
  );

  // Keep previously configured delegations valid even if a delegated user became inactive.
  for (const row of db.prepare('SELECT user_id FROM office_user_delegations WHERE office_id = ?').all(normalizedOfficeId)) {
    const userId = Number(row.user_id);
    if (Number.isInteger(userId) && userId > 0) {
      allowedUserIds.add(userId);
    }
  }

  const existingProfileIds = new Set(
    db
      .prepare('SELECT id FROM access_profiles')
      .all()
      .map((row) => String(row.id ?? '').trim())
      .filter(Boolean)
  );

  const seenUsers = new Set();
  const result = [];

  for (const item of rawDelegations) {
    const userId = Number(item?.userId);
    const profileId = String(item?.profileId ?? '').trim();

    if (!Number.isInteger(userId) || userId <= 0) {
      continue;
    }

    if (!profileId || !existingProfileIds.has(profileId)) {
      continue;
    }

    if (!allowedUserIds.has(userId) || seenUsers.has(userId)) {
      continue;
    }

    seenUsers.add(userId);
    result.push({ userId, profileId });
  }

  return result;
}

function replaceOfficeUserDelegations(officeId, rawDelegations) {
  const normalizedOfficeId = Number(officeId);
  if (!Number.isInteger(normalizedOfficeId) || normalizedOfficeId <= 0) {
    return;
  }

  const normalized = normalizeOfficeUserDelegationsPayload(normalizedOfficeId, rawDelegations);
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM office_user_delegations WHERE office_id = ?').run(normalizedOfficeId);

    if (normalized.length === 0) {
      return;
    }

    const insert = db.prepare(
      `INSERT INTO office_user_delegations (office_id, user_id, profile_id)
       VALUES (?, ?, ?)`
    );

    for (const item of normalized) {
      insert.run(normalizedOfficeId, item.userId, item.profileId);
    }
  });

  transaction();
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

function getDefaultOfficePaymentMethods() {
  return [
    { systemKey: 'cb', label: 'Carte bleu (CB)', displayOrder: 1 },
    { systemKey: 'especes', label: 'Espèces', displayOrder: 2 },
    { systemKey: 'cheque', label: 'Chèque', displayOrder: 3 }
  ];
}

function inferPaymentMethodSystemKey(rawLabel) {
  const label = String(rawLabel ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!label) {
    return null;
  }

  if (label.includes('cb') || label.includes('carte')) {
    return 'cb';
  }
  if (label.includes('espece') || label.includes('especes')) {
    return 'especes';
  }
  if (label.includes('cheque') || label.includes('chq')) {
    return 'cheque';
  }
  return null;
}

function ensureDefaultOfficePaymentMethods(officeId) {
  const normalizedOfficeId = Number(officeId);
  if (!Number.isInteger(normalizedOfficeId) || normalizedOfficeId <= 0) {
    return;
  }

  const defaults = getDefaultOfficePaymentMethods();
  const rows = db
    .prepare(
      `SELECT id, label, is_active, display_order, system_key
       FROM payment_methods
       WHERE office_id = ?
       ORDER BY display_order ASC, id ASC`
    )
    .all(normalizedOfficeId)
    .map((row) => ({
      id: Number(row.id),
      label: String(row.label ?? '').trim(),
      isActive: Number(row.is_active) === 1,
      displayOrder: Number(row.display_order ?? 0),
      systemKey: String(row.system_key ?? '').trim()
    }));

  const bySystemKey = new Map();
  for (const row of rows) {
    if (row.systemKey) {
      bySystemKey.set(row.systemKey, row);
    }
  }

  const updateById = db.prepare(
    `UPDATE payment_methods
     SET system_key = ?, label = ?, is_active = ?, display_order = ?
     WHERE id = ?`
  );
  const insertDefault = db.prepare(
    `INSERT INTO payment_methods (office_id, system_key, label, is_active, display_order)
     VALUES (?, ?, ?, ?, ?)`
  );

  for (const def of defaults) {
    let current = bySystemKey.get(def.systemKey) ?? null;

    if (!current) {
      const fallback = rows.find((row) => !row.systemKey && inferPaymentMethodSystemKey(row.label) === def.systemKey) ?? null;
      if (fallback) {
        updateById.run(def.systemKey, def.label, fallback.isActive ? 1 : 0, def.displayOrder, fallback.id);
        current = { ...fallback, systemKey: def.systemKey };
        bySystemKey.set(def.systemKey, current);
      }
    }

    if (!current) {
      insertDefault.run(normalizedOfficeId, def.systemKey, def.label, 1, def.displayOrder);
      continue;
    }

    updateById.run(def.systemKey, def.label, current.isActive ? 1 : 0, def.displayOrder, current.id);
  }
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

    ensureDefaultOfficePaymentMethods(normalizedOfficeId);

    const defaultRows = db
      .prepare(
        `SELECT id, system_key, is_active
         FROM payment_methods
         WHERE office_id = ? AND system_key IN ('cb', 'especes', 'cheque')
         ORDER BY display_order ASC, id ASC`
      )
      .all(normalizedOfficeId)
      .map((row) => ({
        id: Number(row.id),
        systemKey: String(row.system_key ?? '').trim(),
        isActive: Number(row.is_active) === 1
      }));

    const defaultById = new Set(defaultRows.map((row) => row.id));
    const defaultBySystemKey = new Map(defaultRows.map((row) => [row.systemKey, row]));
    const incomingById = new Map(
      normalizedPaymentMethods
        .filter((item) => Number.isInteger(item.id) && item.id > 0)
        .map((item) => [Number(item.id), item])
    );

    const updateDefaultPaymentMethod = db.prepare(
      `UPDATE payment_methods
       SET label = ?, is_active = ?, display_order = ?, system_key = ?
       WHERE id = ?`
    );

    for (const def of getDefaultOfficePaymentMethods()) {
      const current = defaultBySystemKey.get(def.systemKey);
      if (!current) {
        continue;
      }

      const incoming = incomingById.get(current.id);
      const isActive = incoming ? incoming.isActive : current.isActive;
      updateDefaultPaymentMethod.run(def.label, isActive ? 1 : 0, def.displayOrder, def.systemKey, current.id);
    }

    const upsertPaymentMethod = db.prepare(
      `INSERT INTO payment_methods (id, office_id, system_key, label, is_active, display_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET office_id = excluded.office_id,
                     system_key = excluded.system_key,
                     label = excluded.label,
                     is_active = excluded.is_active,
                     display_order = excluded.display_order`
    );
    const insertPaymentMethod = db.prepare(
      `INSERT INTO payment_methods (office_id, system_key, label, is_active, display_order)
       VALUES (?, ?, ?, ?, ?)`
    );
    const keepPaymentMethodIds = defaultRows.map((row) => row.id);

    const customPaymentMethods = normalizedPaymentMethods.filter((item) => {
      if (!item.id) {
        return inferPaymentMethodSystemKey(item.label) == null;
      }
      return !defaultById.has(item.id);
    });

    for (const item of customPaymentMethods) {
      if (item.id) {
        upsertPaymentMethod.run(item.id, normalizedOfficeId, null, item.label, item.isActive ? 1 : 0, item.displayOrder);
        keepPaymentMethodIds.push(item.id);
      } else {
        const result = insertPaymentMethod.run(normalizedOfficeId, null, item.label, item.isActive ? 1 : 0, item.displayOrder);
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
  const {
    openingHoursJson,
    consultationProfilesJson,
    invoiceTemplateLayoutJson,
    paymentReminderLetterTitle,
    paymentReminderLetterContent,
    patientLettersJson,
    ...officeFields
  } = row;
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
    invoiceTemplateLayoutJson: normalizeInvoiceTemplateLayoutJson(invoiceTemplateLayoutJson),
    paymentReminderLetterTemplate: {
      title: normalizeOfficeLetterTitle(paymentReminderLetterTitle),
      content: normalizeOfficeLetterContent(paymentReminderLetterContent)
    },
    patientLetterTemplates: normalizePatientLetterTemplates(patientLettersJson),
    serviceTypes: Number.isInteger(officeId) && officeId > 0 ? readOfficeServiceTypes(officeId) : [],
    paymentMethods: Number.isInteger(officeId) && officeId > 0 ? readOfficePaymentMethods(officeId) : [],
    officeUserDelegations: Number.isInteger(officeId) && officeId > 0 ? readOfficeUserDelegations(officeId) : [],
    isActive: Boolean(officeFields.isActive),
    openingHours: parseOfficeOpeningHours(openingHoursJson),
    consultationProfiles: parseOfficeConsultationProfiles(consultationProfilesJson)
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
  const directRows = db
    .prepare('SELECT office_id FROM user_offices WHERE user_id = ?')
    .all(userId);

  const delegatedRows = db
    .prepare('SELECT office_id FROM office_user_delegations WHERE user_id = ?')
    .all(userId);

  const ids = [
    ...directRows.map((row) => Number(row.office_id)),
    ...delegatedRows.map((row) => Number(row.office_id))
  ].filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length > 0) {
    return [...new Set(ids)].sort((a, b) => a - b);
  }

  const legacy = db.prepare('SELECT office_id FROM users WHERE id = ?').get(userId);
  const legacyOfficeId = Number(legacy?.office_id);
  return Number.isInteger(legacyOfficeId) && legacyOfficeId > 0 ? [legacyOfficeId] : [];
}

function getUserOfficeOptions(userId) {
  return db
    .prepare(
      `SELECT DISTINCT o.id, o.name
       FROM offices o
       WHERE o.id IN (
         SELECT office_id FROM user_offices WHERE user_id = ?
         UNION
         SELECT office_id FROM office_user_delegations WHERE user_id = ?
       )
       ORDER BY lower(o.name) ASC, o.id ASC`
    )
    .all(userId, userId)
    .map((row) => ({ id: Number(row.id), name: String(row.name ?? '').trim() }));
}

function getScopedOfficeOptions(userAccess, isAdmin) {
  const canAccessAllOffices = isAdmin || userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  if (canAccessAllOffices) {
    return db
      .prepare('SELECT id, name FROM offices ORDER BY lower(name) ASC, id ASC')
      .all()
      .map((row) => ({ id: Number(row.id), name: String(row.name ?? '').trim() }));
  }

  return Array.isArray(userAccess?.offices) ? userAccess.offices : [];
}

function isApplicationSuperAdmin(access) {
  return access?.role === 'admin' || access?.profileId === SUPER_ADMIN_PROFILE_ID;
}

function getDataManagementScopedOfficeIds(userAccess) {
  if (isApplicationSuperAdmin(userAccess)) {
    return db
      .prepare('SELECT id FROM offices ORDER BY id ASC')
      .all()
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);
  }

  const delegatedSuperAdminOfficeIds = db
    .prepare(
      `SELECT office_id
       FROM office_user_delegations
       WHERE user_id = ?
         AND profile_id = ?
       ORDER BY office_id ASC`
    )
    .all(Number(userAccess?.id ?? 0), SUPER_ADMIN_PROFILE_ID)
    .map((row) => Number(row.office_id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (delegatedSuperAdminOfficeIds.length > 0) {
    return [...new Set(delegatedSuperAdminOfficeIds)];
  }

  return [...new Set((Array.isArray(userAccess?.officeIds) ? userAccess.officeIds : [])
    .map((officeId) => Number(officeId))
    .filter((officeId) => Number.isInteger(officeId) && officeId > 0))];
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

function clearBusinessDataForInitialSetup() {
  db.exec('DELETE FROM patient_documents');
  db.exec('DELETE FROM appointments');
  db.exec('DELETE FROM consultations');
  db.exec('DELETE FROM invoices');
  db.exec('DELETE FROM patients');
  db.exec('DELETE FROM directory_contacts');
}

function resetDatabaseForDemoInstance() {
  const hasTable = (tableName) => Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(String(tableName ?? '').trim())
  );

  // Purge child tables first to satisfy FK constraints on users/offices.
  if (hasTable('patient_payment_credit_allocations')) {
    db.exec('DELETE FROM patient_payment_credit_allocations');
  }
  if (hasTable('patient_payment_credits')) {
    db.exec('DELETE FROM patient_payment_credits');
  }
  if (hasTable('invoice_line_items')) {
    db.exec('DELETE FROM invoice_line_items');
  }
  if (hasTable('invoice_payments')) {
    db.exec('DELETE FROM invoice_payments');
  }
  if (hasTable('consultation_reason_items')) {
    db.exec('DELETE FROM consultation_reason_items');
  }
  if (hasTable('consultation_sections')) {
    db.exec('DELETE FROM consultation_sections');
  }
  if (hasTable('patient_antecedents')) {
    db.exec('DELETE FROM patient_antecedents');
  }
  if (hasTable('accounting_deposit_items')) {
    db.exec('DELETE FROM accounting_deposit_items');
  }

  db.exec('DELETE FROM patient_documents');
  db.exec('DELETE FROM appointments');
  db.exec('DELETE FROM consultations');
  db.exec('DELETE FROM invoices');
  db.exec('DELETE FROM directory_contacts');
  if (hasTable('draft')) {
    db.exec('DELETE FROM draft');
  } else if (hasTable('patient_drafts')) {
    db.exec('DELETE FROM patient_drafts');
  }
  db.exec('DELETE FROM patients');
  db.exec('DELETE FROM accounting_operation_meta');
  db.exec('DELETE FROM accounting_expenses');
  db.exec('DELETE FROM accounting_deposits');
  if (hasTable('audit_logs')) {
    db.exec('DELETE FROM audit_logs');
  }
  db.exec('DELETE FROM office_user_delegations');
  db.exec('DELETE FROM user_offices');
  db.exec('DELETE FROM local_calendars');
  db.exec('DELETE FROM service_types');
  db.exec('DELETE FROM payment_methods');
  db.exec("UPDATE users SET office_id = NULL WHERE lower(username) = 'admin'");
  db.exec("DELETE FROM users WHERE lower(username) <> 'admin'");
  db.exec('DELETE FROM offices');
}

function isStrongPassword(password) {
  const normalized = String(password ?? '').trim();
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S{12,256}$/.test(normalized);
}

function deleteUsersByUsernames(usernames) {
  const normalized = Array.from(
    new Set(
      usernames
        .map((username) => String(username ?? '').trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (normalized.length === 0) {
    return [];
  }

  const placeholders = normalized.map(() => '?').join(', ');
  const users = db
    .prepare(`SELECT id FROM users WHERE lower(username) IN (${placeholders})`)
    .all(...normalized);

  const userIds = users
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (userIds.length === 0) {
    return [];
  }

  const idPlaceholders = userIds.map(() => '?').join(', ');
  db.prepare(`DELETE FROM draft WHERE user_id IN (${idPlaceholders})`).run(...userIds);
  db.prepare(`DELETE FROM audit_logs WHERE user_id IN (${idPlaceholders})`).run(...userIds);
  db.prepare(`DELETE FROM office_user_delegations WHERE user_id IN (${idPlaceholders})`).run(...userIds);
  db.prepare(`DELETE FROM user_offices WHERE user_id IN (${idPlaceholders})`).run(...userIds);
  db.prepare(`DELETE FROM user_preference WHERE user_id IN (${idPlaceholders})`).run(...userIds);
  db.prepare(`DELETE FROM users WHERE id IN (${idPlaceholders})`).run(...userIds);

  return userIds;
}

function seedDemoInstanceDataForOffice(officeId, options = {}) {
  const normalizedOfficeId = Number(officeId);
  if (!Number.isInteger(normalizedOfficeId) || normalizedOfficeId <= 0) {
    return { patients: 0, consultations: 0, appointments: 0, invoices: 0, directoryContacts: 0 };
  }

  const practitionerName = String(options.practitionerName ?? '').trim() || 'Cabinet Demo';
  const patientSetKey = String(options.patientSetKey ?? '').trim().toLowerCase() || 'nantes';
  const createdByUserId = Number(options.createdByUserId);
  const normalizedCreatedByUserId = Number.isInteger(createdByUserId) && createdByUserId > 0 ? createdByUserId : null;
  const officeLabel = String(options.officeLabel ?? '').trim() || practitionerName;

  const randomInt = (min, max) => {
    const normalizedMin = Math.floor(Number(min));
    const normalizedMax = Math.floor(Number(max));
    if (!Number.isFinite(normalizedMin) || !Number.isFinite(normalizedMax)) {
      return 0;
    }
    if (normalizedMax <= normalizedMin) {
      return normalizedMin;
    }
    return normalizedMin + Math.floor(Math.random() * ((normalizedMax - normalizedMin) + 1));
  };

  const generateBirthDateIso = () => {
    const year = randomInt(1938, 2023);
    const month = randomInt(1, 12);
    const day = randomInt(1, 28);
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const generateFrenchMobile = () => {
    const prefix = randomInt(0, 1) === 0 ? '06' : '07';
    return `${prefix} ${String(randomInt(10, 99)).padStart(2, '0')} ${String(randomInt(10, 99)).padStart(2, '0')} ${String(randomInt(10, 99)).padStart(2, '0')} ${String(randomInt(10, 99)).padStart(2, '0')}`;
  };

  const minPatientsOption = Number(options.minPatients);
  const maxPatientsOption = Number(options.maxPatients);
  const minPatients = Number.isInteger(minPatientsOption) && minPatientsOption > 0 ? minPatientsOption : 600;
  const maxPatientsCandidate = Number.isInteger(maxPatientsOption) && maxPatientsOption > 0 ? maxPatientsOption : 1000;
  const maxPatients = Math.max(maxPatientsCandidate, minPatients);
  const targetPatientCount = randomInt(minPatients, maxPatients);

  const calendarId = Number(
    db.prepare('SELECT id FROM local_calendars WHERE office_id = ? ORDER BY id ASC LIMIT 1').get(normalizedOfficeId)?.id ?? 0
  ) || null;

  const demoPatientsBySet = {
    nantes: [
      { lastName: 'DURAND', firstName: 'Emma', sex: 'F', birthDate: '1989-04-12', mobilePhone: '06 71 22 18 34', city: 'Nantes', postalCode: '44000', relatedPeople: 'DURAND Leo, DURAND Chloe', notes: 'Lombalgie recurrente, travail sur posture au bureau.' },
      { lastName: 'DURAND', firstName: 'Leo', sex: 'M', birthDate: '2015-09-02', mobilePhone: '06 71 22 18 35', city: 'Nantes', postalCode: '44000', relatedPeople: 'DURAND Emma, DURAND Chloe', notes: 'Suivi pediatrique, croissance et posture scolaire.' },
      { lastName: 'DURAND', firstName: 'Chloe', sex: 'F', birthDate: '2018-01-27', mobilePhone: '06 71 22 18 36', city: 'Nantes', postalCode: '44000', relatedPeople: 'DURAND Emma, DURAND Leo', notes: 'Troubles du sommeil, tensions cervicales legeres.' },
      { lastName: 'RIVIERE', firstName: 'Pauline', sex: 'F', birthDate: '1984-07-10', mobilePhone: '06 80 10 22 31', city: 'Nantes', postalCode: '44100', relatedPeople: 'RIVIERE Luc', notes: 'Douleurs thoraciques fonctionnelles et stress professionnel.' },
      { lastName: 'RIVIERE', firstName: 'Luc', sex: 'M', birthDate: '1982-01-19', mobilePhone: '06 80 10 22 32', city: 'Nantes', postalCode: '44100', relatedPeople: 'RIVIERE Pauline', notes: 'Suivi suite a une entorse lombaire repetee.' },
      { lastName: 'LEGRAND', firstName: 'Maya', sex: 'F', birthDate: '2006-11-05', mobilePhone: '07 43 28 16 04', city: 'Orvault', postalCode: '44700', relatedPeople: '', notes: 'Preparation sportive et prevention des blessures.' },
      { lastName: 'CHEVALIER', firstName: 'Nolan', sex: 'M', birthDate: '1997-03-23', mobilePhone: '07 62 80 14 56', city: 'Sautron', postalCode: '44880', relatedPeople: '', notes: 'Gene cervicale chronique en teletravail.' },
      { lastName: 'PERRAUD', firstName: 'Ines', sex: 'F', birthDate: '1992-09-30', mobilePhone: '06 57 41 93 28', city: 'Nantes', postalCode: '44200', relatedPeople: '', notes: 'Post-partum avec douleurs pelviennes persistantes.' },
      { lastName: 'BRETON', firstName: 'Mathis', sex: 'M', birthDate: '2011-12-14', mobilePhone: '06 93 70 26 45', city: 'Nantes', postalCode: '44300', relatedPeople: 'BRETON Elise', notes: 'Suivi croissance et adaptation posturale scolaire.' },
      { lastName: 'BRETON', firstName: 'Elise', sex: 'F', birthDate: '1980-05-04', mobilePhone: '06 93 70 26 46', city: 'Nantes', postalCode: '44300', relatedPeople: 'BRETON Mathis', notes: 'Tensions cervicales et cephalees recurrentes.' },
      { lastName: 'GUILLAUME', firstName: 'Axel', sex: 'M', birthDate: '1976-02-17', mobilePhone: '07 11 22 33 44', city: 'Nantes', postalCode: '44000', relatedPeople: '', notes: 'Suivi chronicite epaule droite, ergonomie professionnelle.' },
      { lastName: 'LAMY', firstName: 'Salome', sex: 'F', birthDate: '1999-08-08', mobilePhone: '07 15 48 29 60', city: 'Carquefou', postalCode: '44470', relatedPeople: '', notes: 'Douleurs lombaires liees a la course longue distance.' }
    ],
    reze: [
      { lastName: 'MARTIN', firstName: 'Hugo', sex: 'M', birthDate: '1993-11-08', mobilePhone: '07 88 44 12 50', city: 'Reze', postalCode: '44400', relatedPeople: 'MARTIN Alice', notes: 'Sportif amateur, chevilles fragiles.' },
      { lastName: 'MARTIN', firstName: 'Alice', sex: 'F', birthDate: '1995-02-16', mobilePhone: '07 88 44 12 51', city: 'Reze', postalCode: '44400', relatedPeople: 'MARTIN Hugo', notes: 'Cervicalgies chroniques avec migraines episodiques.' },
      { lastName: 'BERNARD', firstName: 'Noah', sex: 'M', birthDate: '2002-07-19', mobilePhone: '06 60 12 70 91', city: 'Saint-Herblain', postalCode: '44800', relatedPeople: '', notes: 'Reprise post-traumatique du membre inferieur droit.' },
      { lastName: 'MOREAU', firstName: 'Jeanne', sex: 'F', birthDate: '1987-10-21', mobilePhone: '06 18 20 40 72', city: 'Bouguenais', postalCode: '44340', relatedPeople: '', notes: 'Troubles digestifs fonctionnels avec tensions dorsales.' },
      { lastName: 'PICHON', firstName: 'Loris', sex: 'M', birthDate: '2013-06-12', mobilePhone: '06 51 17 25 09', city: 'Reze', postalCode: '44400', relatedPeople: 'PICHON Clara', notes: 'Suivi pediatrique et adaptation respiratoire.' },
      { lastName: 'PICHON', firstName: 'Clara', sex: 'F', birthDate: '1988-01-27', mobilePhone: '06 51 17 25 10', city: 'Reze', postalCode: '44400', relatedPeople: 'PICHON Loris', notes: 'Recuperation post-accouchement et douleurs sacro-iliaques.' },
      { lastName: 'LEMAIRE', firstName: 'Theo', sex: 'M', birthDate: '1990-09-03', mobilePhone: '07 70 34 88 91', city: 'Les Sorinieres', postalCode: '44840', relatedPeople: '', notes: 'Suivi suite a une chute en velo.' },
      { lastName: 'VIDAL', firstName: 'Iris', sex: 'F', birthDate: '1979-04-15', mobilePhone: '07 40 58 63 12', city: 'Vertou', postalCode: '44120', relatedPeople: '', notes: 'Douleurs thoraco-lombaires au poste de travail.' },
      { lastName: 'HUBERT', firstName: 'Sacha', sex: 'M', birthDate: '2008-02-11', mobilePhone: '06 72 94 21 87', city: 'Reze', postalCode: '44400', relatedPeople: '', notes: 'Suivi adolescent avec asymetrie posturale.' },
      { lastName: 'ROUSSEL', firstName: 'Maelle', sex: 'F', birthDate: '1996-12-01', mobilePhone: '06 63 15 77 43', city: 'Nantes', postalCode: '44200', relatedPeople: '', notes: 'Fatigue chronique et douleurs cervicales recidivantes.' },
      { lastName: 'TESSIER', firstName: 'Gabin', sex: 'M', birthDate: '1985-05-26', mobilePhone: '06 98 23 66 14', city: 'Reze', postalCode: '44400', relatedPeople: '', notes: 'Suivi de prevention sur contraintes physiques au travail.' },
      { lastName: 'MORIN', firstName: 'Lina', sex: 'F', birthDate: '2004-03-09', mobilePhone: '07 84 62 10 58', city: 'Pont-Saint-Martin', postalCode: '44860', relatedPeople: '', notes: 'Preparation examens et troubles du sommeil associes.' }
    ]
  };

  const baseDemoPatients = demoPatientsBySet[patientSetKey] ?? demoPatientsBySet.nantes;
  const availableCities = [...new Set(baseDemoPatients.map((entry) => String(entry.city ?? '').trim()).filter(Boolean))];
  const cityToPostalCode = new Map();
  for (const entry of baseDemoPatients) {
    const city = String(entry.city ?? '').trim();
    const postalCode = String(entry.postalCode ?? '').trim();
    if (city && postalCode && !cityToPostalCode.has(city)) {
      cityToPostalCode.set(city, postalCode);
    }
  }

  const notePool = [
    ...baseDemoPatients.map((entry) => String(entry.notes ?? '').trim()).filter(Boolean),
    'Suivi de prevention sur contraintes posturales professionnelles.',
    'Recurrence de douleurs lombaires apres charge repetitive.',
    'Gene cervicale liee au travail prolonge sur ecran.',
    'Programme de suivi sportif avec objectif de mobilite.',
    'Fatigue chronique avec tensions dorsales diffuses.',
    'Suivi adolescent pour asymetrie posturale legere.',
    'Accompagnement post-partum avec douleurs sacro-iliaques intermittentes.'
  ];

  const maleFirstNames = ['Lucas', 'Nathan', 'Hugo', 'Theo', 'Mathis', 'Jules', 'Leo', 'Noe', 'Sacha', 'Tom', 'Axel', 'Gabin', 'Ethan', 'Liam', 'Nolan'];
  const femaleFirstNames = ['Emma', 'Lea', 'Chloe', 'Ines', 'Lina', 'Maya', 'Jeanne', 'Alice', 'Clara', 'Iris', 'Maelle', 'Louise', 'Nina', 'Salome', 'Camille'];
  const lastNamePool = [
    ...new Set([
      ...baseDemoPatients.map((entry) => String(entry.lastName ?? '').trim()).filter(Boolean),
      'MOREL', 'GARNIER', 'DUPONT', 'MARCHAND', 'BARBIER', 'BLANCHARD', 'POTIER', 'COLIN', 'PICARD', 'LEFEBVRE',
      'RENARD', 'GERARD', 'MASSON', 'LECLERC', 'ROBIN', 'MEUNIER', 'CARON', 'GIRARD', 'BOYER', 'MARTEL'
    ])
  ];

  const pickArrayValue = (items) => {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }
    return items[randomInt(0, items.length - 1)] ?? '';
  };

  const demoPatients = Array.from({ length: targetPatientCount }, (_, patientIndex) => {
    const isFemale = randomInt(0, 1) === 0;
    const firstName = isFemale ? pickArrayValue(femaleFirstNames) : pickArrayValue(maleFirstNames);
    const sex = isFemale ? 'F' : 'M';
    const lastName = pickArrayValue(lastNamePool);
    const city = pickArrayValue(availableCities) || String(baseDemoPatients[0]?.city ?? 'Nantes');
    const postalCode = cityToPostalCode.get(city) || String(baseDemoPatients[0]?.postalCode ?? '44000');
    const relatedRoll = randomInt(0, 99);
    let relatedPeople = '';
    if (relatedRoll < 15) {
      // Partenaire / conjoint
      const partnerFirstName = isFemale ? pickArrayValue(maleFirstNames) : pickArrayValue(femaleFirstNames);
      relatedPeople = `${lastName} ${partnerFirstName}`;
    } else if (relatedRoll < 27) {
      // Enfant (lien de parentalite)
      const childFirstName = randomInt(0, 1) === 0 ? pickArrayValue(maleFirstNames) : pickArrayValue(femaleFirstNames);
      relatedPeople = `${lastName} ${childFirstName}`;
    }

    return {
      lastName,
      firstName,
      sex,
      birthDate: generateBirthDateIso(),
      mobilePhone: generateFrenchMobile(),
      city,
      postalCode,
      relatedPeople,
      notes: pickArrayValue(notePool) || 'Suivi osteopathique regulier.'
    };
  });

  // Templates for occasional patients (recent history only)
  const consultationTemplatesShort = [
    { minDaysAgo: 120, maxDaysAgo: 360, hour: 10, minute: 30, title: 'Consultation douleur aigue', amountCents: 7200 },
    { minDaysAgo: 20, maxDaysAgo: 110, hour: 14, minute: 0, title: 'Premier bilan osteopathique', amountCents: 7000 }
  ];
  // Templates for regular patients (standard history ~3 years)
  const consultationTemplatesBase = [
    { minDaysAgo: 1180, maxDaysAgo: 1540, hour: 9, minute: 0, title: 'Bilan osteopathique annuel', amountCents: 7000 },
    { minDaysAgo: 780, maxDaysAgo: 1090, hour: 11, minute: 15, title: 'Suivi fonctionnel', amountCents: 6500 },
    { minDaysAgo: 420, maxDaysAgo: 720, hour: 15, minute: 45, title: 'Controle postural', amountCents: 6800 },
    { minDaysAgo: 120, maxDaysAgo: 360, hour: 10, minute: 30, title: 'Consultation douleur aigue', amountCents: 7200 },
    { minDaysAgo: 20, maxDaysAgo: 110, hour: 14, minute: 0, title: 'Suivi trimestriel', amountCents: 6900 }
  ];
  // Additional templates for chronic patients (extended history ~5 years)
  const consultationTemplatesChronique = [
    { minDaysAgo: 1600, maxDaysAgo: 1970, hour: 9, minute: 30, title: 'Premier bilan osteopathique', amountCents: 7000 },
    { minDaysAgo: 1300, maxDaysAgo: 1580, hour: 10, minute: 0, title: 'Suivi post-bilan', amountCents: 6700 },
    { minDaysAgo: 980, maxDaysAgo: 1280, hour: 11, minute: 30, title: 'Bilan de mi-annee', amountCents: 6800 },
    { minDaysAgo: 660, maxDaysAgo: 960, hour: 14, minute: 30, title: 'Suivi semestriel', amountCents: 6900 },
    { minDaysAgo: 340, maxDaysAgo: 640, hour: 9, minute: 0, title: 'Controle postural', amountCents: 6800 },
    { minDaysAgo: 180, maxDaysAgo: 320, hour: 15, minute: 45, title: 'Consultation preventive', amountCents: 6500 },
    { minDaysAgo: 60, maxDaysAgo: 170, hour: 11, minute: 0, title: 'Suivi trimestriel', amountCents: 6900 },
    { minDaysAgo: 8, maxDaysAgo: 55, hour: 14, minute: 0, title: 'Consultation de suivi recente', amountCents: 7000 }
  ];

  const consultationProfiles = ['Adulte', 'Enfant', 'Senior', 'Perinatalite', 'Sportif'];
  const occupations = ['Cadre', 'Etudiant', 'Profession liberale', 'Artisan', 'Infirmier', 'Retraite'];
  const hobbies = ['Running, yoga', 'Natation, randonnee', 'Escalade, mobilite', 'Musculation, pilates', 'Marche active'];
  const maritalStatuses = ['Non renseigne', 'Celibataire', 'Marie(e)', 'Pacs(e)', 'Divorce(e)'];
  const pastAppointmentStatuses = ['Termine', 'En attente'];
  const futureAppointmentStatuses = ['A confirmer', 'En attente'];
  const futureAppointmentReasons = [
    'Controle de suivi',
    'Douleur cervicale recente',
    'Gene lombaire apres effort',
    'Suivi sportif preventif',
    'Point postural'
  ];
  const paidMethods = ['cb', 'especes', 'virement', 'cheque', 'cb', 'cb', 'especes'];
  const unpaidMethods = ['cheque', 'virement'];

  const seededUnit = (seed) => {
    const value = Math.sin(seed) * 10000;
    return value - Math.floor(value);
  };

  const pickFrom = (items, seed) => {
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }
    const index = Math.floor(seededUnit(seed) * items.length) % items.length;
    return items[index];
  };

  const directoryContacts = [
    { kind: 'person', firstName: 'Camille', lastName: 'Roux', organization: '', role: 'Kinesitherapeute', email: 'camille.roux@example.test', mobilePhone: '06 30 10 20 30', landlinePhone: '', address1: '12 rue des Acacias', address2: '', postalCode: '44000', city: 'Nantes', country: 'France', notes: 'Partenaire reeducation sportive.' },
    { kind: 'person', firstName: 'Julien', lastName: 'Perrin', organization: '', role: 'Medecin traitant', email: 'julien.perrin@example.test', mobilePhone: '06 22 30 45 10', landlinePhone: '02 40 10 10 10', address1: '4 avenue de la Sante', address2: '', postalCode: '44000', city: 'Nantes', country: 'France', notes: 'Suivi de plusieurs patients communs.' },
    { kind: 'company', firstName: '', lastName: '', organization: 'Clinique Atlantique', role: 'Etablissement', email: 'contact@clinique-atlantique.test', mobilePhone: '', landlinePhone: '02 40 00 00 00', address1: '45 boulevard Maritime', address2: '', postalCode: '44100', city: 'Nantes', country: 'France', notes: 'Orientation post-operatoire.' },
    { kind: 'company', firstName: '', lastName: '', organization: 'Laboratoire Biocentre', role: 'Laboratoire', email: 'support@biocentre.test', mobilePhone: '', landlinePhone: '02 40 11 22 33', address1: '8 impasse des Sciences', address2: '', postalCode: '44200', city: 'Nantes', country: 'France', notes: 'Examens complementaires.' }
  ];

  const insertPatient = db.prepare(
    `INSERT INTO patients
     (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, marital_status, children_count, last_visit, consent_signed, consent_signed_at, consent_form_version, retention_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertConsultation = db.prepare(
    `INSERT INTO consultations
      (patient_id, started_at, office_id, practitioner, title, important,
       height_cm, weight_kg, eva_before, eva_after, profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAppointment = db.prepare(
    `INSERT INTO appointments (patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id, office_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertInvoice = db.prepare(
    `INSERT INTO invoices
     (patient_id, invoice_number, amount_cents, status, issued_at, due_at, notes_cipher, office_id, consultation_id, payment_method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertInvoicePaymentForDemo = db.prepare(
    `INSERT INTO invoice_payments (invoice_id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAccountingDepositForDemo = db.prepare(
    `INSERT INTO accounting_deposits (occurred_at, office_id, owner_user_id, type, deposit_code, bank_name_cipher, account_label, title, amount_cents, currency, notes, retrocession_percent, retrocession_recipient, is_deleted, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertDepositItemForDemo = db.prepare(
    `INSERT INTO accounting_deposit_items (deposit_id, source_type, source_id, created_at) VALUES (?, ?, ?, ?)`
  );
  const insertDirectoryContact = db.prepare(
    `INSERT INTO directory_contacts (
       office_id, kind, first_name, last_name, organization, role,
       email, mobile_phone, landline_phone,
       address_line1, address_line2, postal_code, city, country,
       notes, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const retentionDate = new Date();
  retentionDate.setFullYear(retentionDate.getFullYear() + 10);
  const retentionUntil = retentionDate.toISOString().slice(0, 10);
  const now = new Date();
  const adminUserId = Number(db.prepare("SELECT id FROM users WHERE lower(username) = 'admin' LIMIT 1").get()?.id ?? 0) || null;

  let patientCount = 0;
  let consultationCount = 0;
  let appointmentCount = 0;
  let invoiceCount = 0;
  let directoryContactCount = 0;
  let depositCount = 0;

  // Pending cheque/especes payments to batch into weekly bank remittances
  const pendingCheques = []; // { invoiceId, amountCents, issuedAt, ownerUserId }
  const pendingEspeces = []; // { invoiceId, amountCents, issuedAt, ownerUserId }

  const tx = db.transaction(() => {
    for (const [patientIndex, patient] of demoPatients.entries()) {
      const fullName = `${patient.lastName} ${patient.firstName}`.trim();
      const mobilePhone = String(patient.mobilePhone ?? '').trim();
      const landlinePhone = '';
      const mainPhone = mobilePhone || landlinePhone || 'Non renseigne';
      const normalizedRelatedPeople = formatRelatedPeople(parseRelatedPeople(patient.relatedPeople));
      const lastVisit = new Date(now.getTime() - ((30 + (patientIndex * 6)) * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
      const patientSeedBase = (normalizedOfficeId * 1009) + ((patientIndex + 1) * 313);
      const maritalStatus = pickFrom(maritalStatuses, patientSeedBase + 11) || 'Non renseigne';
      const childrenCount = Math.floor(seededUnit(patientSeedBase + 17) * 4);

      const medicalRecord = {
        generalRemarks: patient.notes,
        medicalHistory: '',
        consultationNote: '',
        relatedPeople: normalizedRelatedPeople,
        mobilePhone,
        landlinePhone,
        email: `${patient.firstName.toLowerCase()}.${patient.lastName.toLowerCase()}@example.test`,
        address1: 'Adresse de test',
        address2: '',
        postalCode: patient.postalCode,
        city: patient.city,
        country: 'France',
        maritalStatus,
        childrenCount,
        occupationOrSchool: pickFrom(occupations, patientSeedBase + 23) || 'Cadre',
        hobbies: pickFrom(hobbies, patientSeedBase + 29) || 'Running, yoga',
        primaryDoctor: patientIndex % 4 === 0 ? 'Dr Perrin' : '',
        socialSecurityNumber: '',
        referredBy: patientIndex % 5 === 0 ? 'Recommande par un patient du cabinet' : '',
        manualPreference: 'Non renseigne',
        isDeceased: false
      };

      const consentSigned = seededUnit(patientSeedBase + 31) < 0.14 ? 0 : 1;
      const consentSignedAt = consentSigned ? new Date(now.getTime() - ((365 + patientIndex * 30) * 24 * 60 * 60 * 1000)).toISOString() : null;

      const patientResult = insertPatient.run(
        encryptSensitiveField(fullName),
        encryptSensitiveField(mainPhone),
        encryptSensitiveField(JSON.stringify(medicalRecord)),
        patient.sex,
        patient.birthDate,
        maritalStatus,
        childrenCount,
        lastVisit,
        consentSigned,
        consentSignedAt,
        CURRENT_CONSENT_FORM_VERSION,
        retentionUntil
      );

      const patientId = Number(patientResult.lastInsertRowid);
      patientCount += 1;

      // Determine consultation history depth per patient profile
      const patientProfileRoll = seededUnit(patientSeedBase + 500);
      let consultationTemplates;
      if (patientProfileRoll < 0.20) {
        // Nouveau patient (occasional): 2 consultations recent history
        consultationTemplates = consultationTemplatesShort;
      } else if (patientProfileRoll < 0.55) {
        // Patient regulier: base 5 consultations
        consultationTemplates = consultationTemplatesBase;
      } else {
        // Patient chronique: extended 8 consultations over ~5 years
        consultationTemplates = consultationTemplatesChronique;
      }

      for (const [index, template] of consultationTemplates.entries()) {
        const jitterSeed = patientSeedBase + ((index + 1) * 71);
        const hourJitter = ((jitterSeed * 13) % 3) - 1;
        const minuteJitter = ((jitterSeed * 37) % 41) - 20;
        const minDaysAgo = Number(template.minDaysAgo);
        const maxDaysAgo = Number(template.maxDaysAgo);
        const daySpread = Math.max(maxDaysAgo - minDaysAgo, 1);
        const daysAgo = minDaysAgo + Math.floor(seededUnit(jitterSeed + 3) * daySpread);
        const baseMinutes = (template.hour * 60) + template.minute;
        const jitteredMinutes = baseMinutes + (hourJitter * 60) + minuteJitter;
        const boundedMinutes = Math.min(Math.max(jitteredMinutes, 8 * 60), (19 * 60) + 30);
        const roundedMinutes = Math.round(boundedMinutes / 5) * 5;
        const startHour = Math.floor(roundedMinutes / 60);
        const startMinute = roundedMinutes % 60;

        const startedAtDate = new Date(now.getTime() - (Math.max(daysAgo, 2) * 24 * 60 * 60 * 1000));
        startedAtDate.setHours(startHour, startMinute, 0, 0);

        if (startedAtDate.getTime() >= now.getTime()) {
          startedAtDate.setTime(now.getTime() - (2 * 24 * 60 * 60 * 1000));
          startedAtDate.setHours(startHour, startMinute, 0, 0);
        }

        const startedAt = startedAtDate.toISOString();

        const consultationTitle = `${template.title} - ${patient.firstName}`;
        const isFreeConsultation = patientIndex % 9 === 0 && index === 2;
        const shouldSkipInvoice = seededUnit(jitterSeed + 37) < 0.08;
        const invoiceAmountCents = isFreeConsultation ? 0 : template.amountCents;
        let invoiceStatus = 'payee';
        if (!isFreeConsultation) {
          const statusRoll = seededUnit(jitterSeed + 41);
          if (statusRoll < 0.78) {
            invoiceStatus = 'payee';
          } else if (statusRoll < 0.87) {
            invoiceStatus = 'impayee';
          } else if (statusRoll < 0.93) {
            invoiceStatus = 'partiellement_payee';
          } else {
            invoiceStatus = 'annulee';
          }
        }
        const appointmentStatus = pickFrom(pastAppointmentStatuses, jitterSeed + 43) || 'Termine';
        const consultationResult = insertConsultation.run(
          patientId,
          startedAt,
          normalizedOfficeId,
          practitionerName,
          consultationTitle,
          0,
          null,
          null,
          3 + Math.floor(seededUnit(jitterSeed + 47) * 7),
          Math.max(0, 1 + Math.floor(seededUnit(jitterSeed + 53) * 7)),
          pickFrom(consultationProfiles, jitterSeed + 59) || 'Adulte'
        );
        const consultationId = Number(consultationResult.lastInsertRowid);
        consultationCount += 1;

        replaceConsultationSections(consultationId, {
          motifMainHtml: `<p>${consultationTitle}</p>`,
          testsHtml: '',
          schemaHtml: '',
          treatmentsHtml: '',
          remarksHtml: `<p>Compte rendu de demonstration ${officeLabel} (${index + 1}).</p>`
        });

        insertAppointment.run(
          patientId,
          startedAt,
          encryptSensitiveField(consultationTitle),
          appointmentStatus,
          calendarId,
          consultationId,
          normalizedOfficeId
        );
        appointmentCount += 1;

        if (!shouldSkipInvoice) {
          const issuedAt = startedAt.slice(0, 10);
          const dueDelayDays = invoiceStatus === 'impayee' ? 21 : invoiceStatus === 'partiellement_payee' ? 10 : 7;
          const dueAt = new Date(new Date(startedAt).getTime() + (dueDelayDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
          const invoiceNumber = `DEMO-${now.getFullYear()}-O${String(normalizedOfficeId).padStart(2, '0')}-${String(patientIndex + 1).padStart(2, '0')}${String(index + 1).padStart(2, '0')}`;
          const paymentMethod = invoiceStatus === 'impayee'
            ? (pickFrom(unpaidMethods, jitterSeed + 61) || 'cheque')
            : (pickFrom(paidMethods, jitterSeed + 67) || 'cb');

          const invoiceResult = insertInvoice.run(
            patientId,
            invoiceNumber,
            invoiceAmountCents,
            invoiceStatus,
            issuedAt,
            dueAt,
            encryptSensitiveField(
              isFreeConsultation
                ? `Facture demo ${consultationTitle} - seance gracieuse`
                : `Facture demo ${consultationTitle}`
            ),
            normalizedOfficeId,
            consultationId,
            paymentMethod
          );
          invoiceCount += 1;
          const invoiceId = Number(invoiceResult.lastInsertRowid);

          // Add invoice_payments record for paid/partially paid invoices
          if (invoiceAmountCents > 0 && (invoiceStatus === 'payee' || invoiceStatus === 'partiellement_payee')) {
            const paymentAmountCents = invoiceStatus === 'partiellement_payee'
              ? Math.round(invoiceAmountCents * (0.4 + seededUnit(jitterSeed + 99) * 0.4))
              : invoiceAmountCents;
            const chequeNumber = paymentMethod === 'cheque'
              ? `CHQ${String((patientIndex * 100) + index + 1).padStart(7, '0')}`
              : '';
            insertInvoicePaymentForDemo.run(
              invoiceId,
              issuedAt,
              paymentAmountCents,
              'EUR',
              paymentMethod,
              '',
              chequeNumber,
              '',
              '',
              null
            );
            // Collect cheque/especes for bank remittances
            if (paymentMethod === 'cheque') {
              pendingCheques.push({ invoiceId, amountCents: paymentAmountCents, issuedAt });
            } else if (paymentMethod === 'especes') {
              pendingEspeces.push({ invoiceId, amountCents: paymentAmountCents, issuedAt });
            }
          }
        }
      }

      const futureAppointmentCount = seededUnit(patientSeedBase + 79) < 0.45 ? 1 : 2;
      for (let futureIndex = 0; futureIndex < futureAppointmentCount; futureIndex += 1) {
        const futureSeed = patientSeedBase + 200 + (futureIndex * 19);
        const daysAhead = 3 + Math.floor(seededUnit(futureSeed + 3) * 110);
        const futureStartDate = new Date(now.getTime() + (daysAhead * 24 * 60 * 60 * 1000));
        const futureMinutes = (8 * 60) + Math.round((seededUnit(futureSeed + 7) * ((19 * 60) - (8 * 60))) / 5) * 5;
        const futureHour = Math.floor(futureMinutes / 60);
        const futureMinute = futureMinutes % 60;
        futureStartDate.setHours(futureHour, futureMinute, 0, 0);

        const futureReasonBase = pickFrom(futureAppointmentReasons, futureSeed + 11) || 'Controle de suivi';
        const futureReason = `${futureReasonBase} - ${patient.firstName}`;
        const futureStatus = pickFrom(futureAppointmentStatuses, futureSeed + 13) || 'A confirmer';

        insertAppointment.run(
          patientId,
          futureStartDate.toISOString(),
          encryptSensitiveField(futureReason),
          futureStatus,
          calendarId,
          null,
          normalizedOfficeId
        );
        appointmentCount += 1;
      }
    }

    // Create weekly bank remittances (remises de banques) from collected cheque/especes payments
    const groupByWeek = (payments) => {
      const groups = new Map();
      for (const p of payments) {
        const d = new Date(p.issuedAt);
        const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon...
        const daysToMonday = (dayOfWeek + 6) % 7;
        const monday = new Date(d.getTime() - (daysToMonday * 24 * 60 * 60 * 1000));
        const key = monday.toISOString().slice(0, 10);
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(p);
      }
      return groups;
    };

    const trigram = practitionerName
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 3)
      .padEnd(3, 'X');

    const createDeposits = (payments, type) => {
      const groups = groupByWeek(payments);
      for (const [weekStart, items] of groups.entries()) {
        const totalAmountCents = items.reduce((sum, p) => sum + p.amountCents, 0);
        if (totalAmountCents <= 0) {
          continue;
        }
        const [yyyy, mm, dd] = weekStart.split('-');
        const depositCode = `${trigram}-${yyyy}${mm}${dd}`;
        const title = type === 'cheque' ? 'Remise de cheques' : 'Remise d\'especes';
        const occurredAt = `${weekStart}T10:00:00.000Z`;
        const depositResult = insertAccountingDepositForDemo.run(
          occurredAt,
          normalizedOfficeId,
          null,
          type,
          depositCode,
          '',
          '',
          title,
          totalAmountCents,
          'EUR',
          '',
          0,
          '',
          0,
          null
        );
        const depositId = Number(depositResult.lastInsertRowid);
        depositCount += 1;
        for (const item of items) {
          insertDepositItemForDemo.run(depositId, 'invoice', item.invoiceId, occurredAt);
        }
      }
    };

    createDeposits(pendingCheques, 'cheque');
    createDeposits(pendingEspeces, 'especes');

    for (const contact of directoryContacts) {
      insertDirectoryContact.run(
        normalizedOfficeId,
        contact.kind,
        contact.firstName,
        contact.lastName,
        contact.organization,
        contact.role,
        contact.email,
        contact.mobilePhone,
        contact.landlinePhone,
        contact.address1,
        contact.address2,
        contact.postalCode,
        contact.city,
        contact.country,
        contact.notes,
        normalizedCreatedByUserId,
        normalizedCreatedByUserId
      );
      directoryContactCount += 1;
    }
  });

  tx();

  return {
    patients: patientCount,
    consultations: consultationCount,
    appointments: appointmentCount,
    invoices: invoiceCount,
    deposits: depositCount,
    directoryContacts: directoryContactCount
  };
}

async function installDemoInstanceData() {
  const defaultServiceTypes = [
    { id: null, label: 'Consultation osteopathique', amountHt: 70, vatRate: 0 },
    { id: null, label: 'Consultation pediatrique', amountHt: 65, vatRate: 0 },
    { id: null, label: 'Suivi sportif', amountHt: 75, vatRate: 0 }
  ];
  const defaultPaymentMethods = [
    { id: null, label: 'Carte bleue (CB)', isActive: true },
    { id: null, label: 'Especes', isActive: true },
    { id: null, label: 'Cheque', isActive: true }
  ];
  const officeDefinitions = [
    {
      name: 'Cabinet Osteo Demo Nantes Centre',
      addressLine1: '24 rue de la Demo',
      postalCode: '44000',
      city: 'Nantes',
      phoneMobile: '06 00 00 00 01',
      email: 'nantes@demo.osteosoft',
      website: 'https://demo.osteosoft.local/nantes',
      displayOrder: 1,
      patientSetKey: 'nantes',
      practitionerName: 'Claire Martin'
    },
    {
      name: 'Cabinet Osteo Demo Rezé',
      addressLine1: '8 place du Marche',
      postalCode: '44400',
      city: 'Reze',
      phoneMobile: '06 00 00 00 02',
      email: 'reze@demo.osteosoft',
      website: 'https://demo.osteosoft.local/reze',
      displayOrder: 2,
      patientSetKey: 'reze',
      practitionerName: 'Antoine Rousseau'
    }
  ];
  const demoUsers = [
    {
      reuseBootstrapAdmin: true,
      username: 'admin',
      password: 'admin',
      role: 'admin',
      profileId: SUPER_ADMIN_PROFILE_ID,
      firstName: '',
      lastName: '',
      email: '',
      mobilePhone: '',
      colorHex: '#4d92d1'
    },
    {
      reuseBootstrapAdmin: false,
      assignedOfficeIndex: 0,
      username: 'claire.martin',
      password: 'demo-claire',
      role: 'practitioner',
      profileId: 'cabinet-member',
      firstName: 'Claire',
      lastName: 'Martin',
      email: 'claire.martin@demo.osteosoft',
      mobilePhone: '06 11 22 33 44',
      colorHex: '#4d92d1'
    },
    {
      reuseBootstrapAdmin: false,
      assignedOfficeIndex: 1,
      username: 'antoine.rousseau',
      password: 'demo-antoine',
      role: 'practitioner',
      profileId: 'cabinet-member',
      firstName: 'Antoine',
      lastName: 'Rousseau',
      email: 'antoine.rousseau@demo.osteosoft',
      mobilePhone: '06 55 66 77 88',
      colorHex: '#5d8f5a'
    }
  ];

  resetDatabaseForDemoInstance();
  deleteUsersByUsernames(['assistant', 'secretariat', 'compta', 'claire.martin', 'antoine.rousseau']);

  const insert = db.prepare(`
    INSERT INTO offices (name, default_session_duration_minutes, country, devise, invoice_number_format, invoice_numbering_configuration,
                         invoice_show_insurance_fields, invoice_hide_vat_mention, invoice_template_layout_json, address_line1, address_line2, postal_code, city, phone_mobile,
                         phone_landline, phone_fax, email, website, vat_number, logo_data, opening_hours_json,
                         consultation_profiles_json, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const openingHours = normalizeOfficeOpeningHours({
    monday: [{ start: '09:00', end: '18:00' }],
    tuesday: [{ start: '09:00', end: '18:00' }],
    wednesday: [{ start: '09:00', end: '18:00' }],
    thursday: [{ start: '09:00', end: '18:00' }],
    friday: [{ start: '09:00', end: '17:00' }],
    saturday: [{ start: '09:00', end: '12:00' }],
    sunday: []
  });
  const consultationProfiles = normalizeOfficeConsultationProfiles([
    { id: 'adult', name: 'Adulte', reasons: ['Lombalgie', 'Cervicalgie', 'Suivi postural'], displayOrder: 1 },
    { id: 'child', name: 'Enfant', reasons: ['Suivi croissance', 'Troubles du sommeil'], displayOrder: 2 },
    { id: 'sport', name: 'Sportif', reasons: ['Preparation competition', 'Recuperation'], displayOrder: 3 }
  ]);

  const createdOffices = officeDefinitions.map((office) => {
    const result = insert.run(
      office.name,
      60,
      'France',
      'EUR',
      'AAAA-XXXXXX',
      'Numérotation globale au cabinet',
      0,
      0,
      '{}',
      office.addressLine1,
      '',
      office.postalCode,
      office.city,
      office.phoneMobile,
      '',
      '',
      office.email,
      office.website,
      '',
      null,
      JSON.stringify(openingHours),
      JSON.stringify(consultationProfiles),
      office.displayOrder
    );

    const createdOfficeId = Number(result.lastInsertRowid);
    replaceOfficeBusinessSettings(createdOfficeId, defaultServiceTypes, defaultPaymentMethods);
    createLocalCalendarFromOffice(createdOfficeId, office.name);

    return { ...office, id: createdOfficeId };
  });

  const officeIds = createdOffices.map((office) => office.id);
  const bootstrapAdminUser = db.prepare("SELECT id FROM users WHERE lower(username) = 'admin' LIMIT 1").get();
  if (!bootstrapAdminUser) {
    throw new Error('Compte bootstrap introuvable pour initialiser la demonstration');
  }

  const createdUsers = [];
  for (const demoUser of demoUsers) {
    const passwordHash = await argon2.hash(demoUser.password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    if (demoUser.reuseBootstrapAdmin) {
      db.prepare(
        `UPDATE users
         SET username = ?,
             password_hash = ?,
             role = ?,
             is_active = 1,
             profile_id = ?,
             office_id = ?,
             last_name = ?,
             first_name = ?,
             email = ?,
             mobile_phone = ?,
             country = ?,
             color_hex = ?
         WHERE id = ?`
      ).run(
        demoUser.username,
        passwordHash,
        demoUser.role,
        demoUser.profileId,
        officeIds[0] ?? null,
        demoUser.lastName,
        demoUser.firstName,
        demoUser.email,
        demoUser.mobilePhone,
        '',
        demoUser.colorHex,
        bootstrapAdminUser.id
      );

      createdUsers.push({ id: Number(bootstrapAdminUser.id), ...demoUser });
      continue;
    }

    const result = db.prepare(
      `INSERT INTO users (
        username, password_hash, role, is_active, profile_id, office_id,
        last_name, first_name, email, mobile_phone, country, color_hex
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      demoUser.username,
      passwordHash,
      demoUser.role,
      demoUser.profileId,
      officeIds[demoUser.assignedOfficeIndex] ?? officeIds[0] ?? null,
      demoUser.lastName,
      demoUser.firstName,
      demoUser.email,
      demoUser.mobilePhone,
      'France',
      demoUser.colorHex
    );

    createdUsers.push({ id: Number(result.lastInsertRowid), ...demoUser });
  }

  for (const [index, user] of createdUsers.entries()) {
    if (user.username === 'admin') {
      syncUserOffices(user.id, officeIds);
      continue;
    }

    const scopedOfficeId = officeIds[index - 1] ?? officeIds[0] ?? null;
    syncUserOffices(user.id, scopedOfficeId ? [scopedOfficeId] : []);
  }

  replaceOfficeUserDelegations(createdOffices[0]?.id ?? null, createdUsers[1] ? [
    { userId: createdUsers[1].id, profileId: SUPER_ADMIN_PROFILE_ID }
  ] : []);
  replaceOfficeUserDelegations(createdOffices[1]?.id ?? null, createdUsers[2] ? [
    { userId: createdUsers[2].id, profileId: SUPER_ADMIN_PROFILE_ID }
  ] : []);

  const seeded = createdOffices.reduce(
    (totals, office, index) => {
      const user = createdUsers[index + 1] ?? createdUsers[0] ?? null;
      const officeSeed = seedDemoInstanceDataForOffice(office.id, {
        practitionerName: office.practitionerName,
        patientSetKey: office.patientSetKey,
        officeLabel: office.name,
        createdByUserId: user?.id ?? null
      });

      totals.patients += officeSeed.patients;
      totals.consultations += officeSeed.consultations;
      totals.appointments += officeSeed.appointments;
      totals.invoices += officeSeed.invoices;
      totals.directoryContacts += officeSeed.directoryContacts;
      return totals;
    },
    { patients: 0, consultations: 0, appointments: 0, invoices: 0, directoryContacts: 0 }
  );

  return {
    officeId: createdOffices[0]?.id ?? null,
    officeIds,
    demoUsers: createdUsers.map(({ id, username, password, firstName, lastName }) => ({
      id,
      username,
      password,
      firstName,
      lastName
    })),
    seeded
  };
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

const BACKUP_MANIFEST_FORMAT = 'osteosoft-backup';
const BACKUP_MANIFEST_VERSION = 1;
const MAX_BACKUP_RESTORE_PAYLOAD_BYTES = Number(process.env.MAX_BACKUP_RESTORE_PAYLOAD_BYTES ?? 35 * 1024 * 1024);
const MAX_BACKUP_DOCUMENT_PAYLOAD_BYTES = Number(process.env.MAX_BACKUP_DOCUMENT_PAYLOAD_BYTES ?? 20 * 1024 * 1024);
const BACKUP_COLLECTION_LIMITS = {
  accessProfiles: Number(process.env.MAX_BACKUP_ACCESS_PROFILES ?? 200),
  users: Number(process.env.MAX_BACKUP_USERS ?? 500),
  userOffices: Number(process.env.MAX_BACKUP_USER_OFFICES ?? 3000),
  officeUserDelegations: Number(process.env.MAX_BACKUP_OFFICE_DELEGATIONS ?? 3000),
  patients: Number(process.env.MAX_BACKUP_PATIENTS ?? 150000),
  appointments: Number(process.env.MAX_BACKUP_APPOINTMENTS ?? 300000),
  invoices: Number(process.env.MAX_BACKUP_INVOICES ?? 300000),
  invoiceLineItems: Number(process.env.MAX_BACKUP_INVOICE_LINE_ITEMS ?? 1000000),
  invoicePayments: Number(process.env.MAX_BACKUP_INVOICE_PAYMENTS ?? 500000),
  accountingExpenses: Number(process.env.MAX_BACKUP_ACCOUNTING_EXPENSES ?? 200000),
  accountingDeposits: Number(process.env.MAX_BACKUP_ACCOUNTING_DEPOSITS ?? 200000),
  accountingDepositItems: Number(process.env.MAX_BACKUP_ACCOUNTING_DEPOSIT_ITEMS ?? 500000),
  accountingOperationMeta: Number(process.env.MAX_BACKUP_ACCOUNTING_META ?? 500000),
  consultations: Number(process.env.MAX_BACKUP_CONSULTATIONS ?? 300000),
  consultationReasonItems: Number(process.env.MAX_BACKUP_CONSULTATION_REASON_ITEMS ?? 1200000),
  consultationSections: Number(process.env.MAX_BACKUP_CONSULTATION_SECTIONS ?? 1500000),
  antecedentTypes: Number(process.env.MAX_BACKUP_ANTECEDENT_TYPES ?? 200),
  patientAntecedents: Number(process.env.MAX_BACKUP_PATIENT_ANTECEDENTS ?? 600000),
  serviceTypes: Number(process.env.MAX_BACKUP_SERVICE_TYPES ?? 5000),
  paymentMethods: Number(process.env.MAX_BACKUP_PAYMENT_METHODS ?? 5000),
  localCalendars: Number(process.env.MAX_BACKUP_LOCAL_CALENDARS ?? 5000),
  directoryContacts: Number(process.env.MAX_BACKUP_DIRECTORY_CONTACTS ?? 300000),
  patientDocuments: Number(process.env.MAX_BACKUP_PATIENT_DOCUMENTS ?? 150000),
  config: Number(process.env.MAX_BACKUP_CONFIG_ITEMS ?? 5000),
  patientDrafts: Number(process.env.MAX_BACKUP_PATIENT_DRAFTS ?? 10000),
  auditLogs: Number(process.env.MAX_BACKUP_AUDIT_LOGS ?? 1000000)
};

function parseMajorVersion(version) {
  const normalized = String(version ?? '').trim();
  const match = normalized.match(/^(\d+)/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function computeBackupDataSha256(data) {
  const normalizeForStableHash = (value) => {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeForStableHash(item));
    }

    if (value && typeof value === 'object') {
      const sortedEntries = Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeForStableHash(nestedValue)]);
      return Object.fromEntries(sortedEntries);
    }

    return value;
  };

  const stableData = normalizeForStableHash(data);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableData))
    .digest('hex');
}

function computeBackupDataSha256Legacy(data) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}

function normalizeBackupEnvelope(backupPayload) {
  const data = backupPayload?.data;
  if (!data || typeof data !== 'object') {
    throw new Error('Format de sauvegarde invalide');
  }

  const payloadSizeBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (payloadSizeBytes > MAX_BACKUP_RESTORE_PAYLOAD_BYTES) {
    throw new Error('Sauvegarde trop volumineuse pour restauration');
  }

  for (const [collectionKey, maxItems] of Object.entries(BACKUP_COLLECTION_LIMITS)) {
    const rows = data[collectionKey];
    if (!Array.isArray(rows)) {
      continue;
    }

    if (rows.length > maxItems) {
      throw new Error(`Sauvegarde invalide: volume excessif pour ${collectionKey}`);
    }
  }

  if (Array.isArray(data.patientDocuments)) {
    const documentsPayloadBytes = data.patientDocuments.reduce(
      (total, row) => total + Buffer.byteLength(String(row?.content_cipher ?? ''), 'utf8'),
      0
    );
    if (documentsPayloadBytes > MAX_BACKUP_DOCUMENT_PAYLOAD_BYTES) {
      throw new Error('Sauvegarde invalide: volume de documents excessif');
    }
  }

  const manifest = backupPayload?.manifest && typeof backupPayload.manifest === 'object'
    ? backupPayload.manifest
    : null;

  if (manifest) {
    if (manifest.format !== BACKUP_MANIFEST_FORMAT) {
      throw new Error('Format de manifest invalide');
    }

    if (Number(manifest.manifestVersion) !== BACKUP_MANIFEST_VERSION) {
      throw new Error('Version de manifest non supportee');
    }

    const expectedChecksum = String(manifest.dataSha256 ?? '').toLowerCase();
    const actualChecksum = computeBackupDataSha256(data);
    const legacyChecksum = computeBackupDataSha256Legacy(data);
    const isChecksumValid = expectedChecksum
      && (expectedChecksum === actualChecksum || expectedChecksum === legacyChecksum);

    if (!isChecksumValid) {
      throw new Error('Integrite de la sauvegarde invalide (checksum)');
    }

    const currentAppVersion = db.prepare('SELECT value FROM config WHERE key = ?').get('version')?.value ?? '0.0.2';
    const currentMajor = parseMajorVersion(currentAppVersion);
    const backupMajor = Number.isInteger(Number(manifest.appMajorVersion))
      ? Number(manifest.appMajorVersion)
      : parseMajorVersion(manifest.appVersion);

    if (currentMajor != null && backupMajor != null && backupMajor < currentMajor - 1) {
      throw new Error('Version de sauvegarde trop ancienne pour restauration automatique');
    }
  }

  return {
    data,
    manifest,
    meta: backupPayload?.meta && typeof backupPayload.meta === 'object' ? backupPayload.meta : null
  };
}

function getSetupStatusSnapshot() {
  const offices = Number(db.prepare('SELECT COUNT(*) AS count FROM offices').get()?.count ?? 0);
  const requiresSetup = offices === 0;

  return {
    requiresSetup,
    stats: { offices }
  };
}

function filterBackupDataByOfficeIds(data, officeIds) {
  const normalizedOfficeIds = [...new Set((Array.isArray(officeIds) ? officeIds : [])
    .map((officeId) => Number(officeId))
    .filter((officeId) => Number.isInteger(officeId) && officeId > 0))];

  if (normalizedOfficeIds.length === 0) {
    return {
      ...data,
      accessProfiles: [],
      users: [],
      userOffices: [],
      officeUserDelegations: [],
      patients: [],
      appointments: [],
      invoices: [],
      invoiceLineItems: [],
      invoicePayments: [],
      accountingExpenses: [],
      accountingDeposits: [],
      accountingDepositItems: [],
      accountingOperationMeta: [],
      consultations: [],
      consultationReasonItems: [],
      consultationSections: [],
      patientDocuments: [],
      patientAntecedents: [],
      serviceTypes: [],
      paymentMethods: [],
      localCalendars: [],
      directoryContacts: [],
      config: [],
      patientDrafts: [],
      auditLogs: []
    };
  }

  const officeIdSet = new Set(normalizedOfficeIds);
  const patients = data.patients.filter((row) => officeIdSet.has(Number(row.office_id)));
  const patientIdSet = new Set(patients.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));

  const consultations = data.consultations.filter(
    (row) => officeIdSet.has(Number(row.office_id)) || patientIdSet.has(Number(row.patient_id))
  );
  const consultationIdSet = new Set(consultations.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));

  const appointments = data.appointments.filter(
    (row) =>
      patientIdSet.has(Number(row.patient_id))
      || officeIdSet.has(Number(row.office_id))
      || consultationIdSet.has(Number(row.consultation_id))
  );

  const invoices = data.invoices.filter(
    (row) => officeIdSet.has(Number(row.office_id)) || patientIdSet.has(Number(row.patient_id))
  );
  const invoiceIdSet = new Set(invoices.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));

  const accountingDeposits = data.accountingDeposits.filter((row) => officeIdSet.has(Number(row.office_id)));
  const depositIdSet = new Set(accountingDeposits.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));

  const accountingExpenses = data.accountingExpenses.filter((row) => officeIdSet.has(Number(row.office_id)));
  const expenseIdSet = new Set(accountingExpenses.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));

  const userOffices = data.userOffices.filter((row) => officeIdSet.has(Number(row.office_id)));
  const officeUserDelegations = data.officeUserDelegations.filter((row) => officeIdSet.has(Number(row.office_id)));
  const userIdSet = new Set(
    [
      ...userOffices.map((row) => Number(row.user_id)),
      ...officeUserDelegations.map((row) => Number(row.user_id))
    ].filter((id) => Number.isInteger(id) && id > 0)
  );

  const users = data.users.filter((row) => {
    const userId = Number(row.id);
    const legacyOfficeId = Number(row.office_id);
    return userIdSet.has(userId) || officeIdSet.has(legacyOfficeId);
  });

  const profileIdSet = new Set(users.map((row) => String(row.profile_id ?? '').trim()).filter((id) => id.length > 0));

  return {
    ...data,
    accessProfiles: data.accessProfiles.filter((row) => profileIdSet.has(String(row.id ?? '').trim())),
    users,
    userOffices,
    officeUserDelegations,
    patients,
    appointments,
    invoices,
    invoiceLineItems: data.invoiceLineItems.filter((row) => invoiceIdSet.has(Number(row.invoice_id))),
    invoicePayments: data.invoicePayments.filter((row) => invoiceIdSet.has(Number(row.invoice_id))),
    accountingExpenses,
    accountingDeposits,
    accountingDepositItems: data.accountingDepositItems.filter((row) => depositIdSet.has(Number(row.deposit_id))),
    accountingOperationMeta: data.accountingOperationMeta.filter((row) => {
      const sourceType = String(row.source_type ?? '').trim();
      const sourceId = Number(row.source_id);
      if (!Number.isInteger(sourceId) || sourceId <= 0) {
        return false;
      }
      if (sourceType === 'accounting-deposit') {
        return depositIdSet.has(sourceId);
      }
      if (sourceType === 'accounting-expense') {
        return expenseIdSet.has(sourceId);
      }
      return false;
    }),
    consultations,
    consultationReasonItems: data.consultationReasonItems.filter((row) => consultationIdSet.has(Number(row.consultation_id))),
    consultationSections: data.consultationSections.filter((row) => consultationIdSet.has(Number(row.consultation_id))),
    patientDocuments: data.patientDocuments.filter(
      (row) => patientIdSet.has(Number(row.patient_id)) || officeIdSet.has(Number(row.office_id))
    ),
    patientAntecedents: data.patientAntecedents.filter((row) => patientIdSet.has(Number(row.patient_id))),
    serviceTypes: data.serviceTypes.filter((row) => officeIdSet.has(Number(row.office_id))),
    paymentMethods: data.paymentMethods.filter((row) => officeIdSet.has(Number(row.office_id))),
    localCalendars: data.localCalendars.filter((row) => officeIdSet.has(Number(row.office_id))),
    directoryContacts: data.directoryContacts.filter((row) => officeIdSet.has(Number(row.office_id))),
    config: [],
    patientDrafts: [],
    auditLogs: data.auditLogs.filter((row) => userIdSet.has(Number(row.user_id)))
  };
}

function buildDataBackupSnapshot(options = {}) {
  const appName = db.prepare('SELECT value FROM config WHERE key = ?').get('app_name')?.value ?? 'OsteoSoft';
  const appVersion = db.prepare('SELECT value FROM config WHERE key = ?').get('version')?.value ?? '0.0.2';
  const createdAt = new Date().toISOString();
  const appMajorVersion = parseMajorVersion(appVersion);

  const data = {
    accessProfiles: db.prepare(
      `SELECT id, label, description, rights_json, immutable, created_at, updated_at
       FROM access_profiles
       ORDER BY created_at ASC, id ASC`
    ).all(),
    users: db.prepare(
      `SELECT id, username, role, profile_id, is_active,
              office_id, last_name, first_name, email, mobile_phone, country,
              siret, adeli_code, rpps_code, ape_naf_code, name_suffix_text,
              letter_header, letter_footer, signature_text, color_hex,
              bank_name_cipher, iban_cipher, retrocession_percent, retrocession_recipient,
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
    officeUserDelegations: db.prepare(
      `SELECT office_id, user_id, profile_id, created_at
       FROM office_user_delegations
       ORDER BY office_id ASC, user_id ASC`
    ).all(),
    patients: db.prepare(
      `SELECT id, cipher_full_name, cipher_phone, cipher_medical_notes,
            sex, marital_status, children_count, office_id,
            birth_date, last_visit, consent_signed, consent_signed_at, consent_form_version, consent_withdrawn_at,
            retention_until, is_deleted, created_at, updated_at
       FROM patients
       ORDER BY id ASC`
    ).all(),
    appointments: db.prepare(
      `SELECT id, patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id, office_id,
              practitioner, is_private, private_label_cipher, created_at
       FROM appointments
       ORDER BY id ASC`
    ).all(),
    invoices: db.prepare(
      `SELECT id, patient_id, invoice_number, amount_cents, status,
              issued_at, due_at, notes_cipher, office_id, consultation_id,
              payment_method, created_at
       FROM invoices
       ORDER BY id ASC`
    ).all(),
    invoiceLineItems: db.prepare(
      `SELECT id, invoice_id, label, quantity, unit_amount_ht_cents, vat_rate, display_order, created_at
       FROM invoice_line_items
       ORDER BY invoice_id ASC, display_order ASC, id ASC`
    ).all(),
    invoicePayments: db.prepare(
      `SELECT id, invoice_id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes, created_by, created_at
       FROM invoice_payments
       ORDER BY invoice_id ASC, paid_at ASC, id ASC`
    ).all(),
    accountingExpenses: db.prepare(
      `SELECT id, occurred_at, office_id, owner_user_id, title, amount_cents, currency,
              payment_method, notes, retrocession_percent, retrocession_recipient,
              is_deleted, created_by, created_at
       FROM accounting_expenses
       ORDER BY id ASC`
    ).all(),
    accountingDeposits: db.prepare(
      `SELECT id, occurred_at, office_id, owner_user_id, type, deposit_code, bank_name_cipher,
              account_label, title, amount_cents, currency, notes,
              retrocession_percent, retrocession_recipient, is_deleted, created_by, created_at
       FROM accounting_deposits
       ORDER BY id ASC`
    ).all(),
    accountingDepositItems: db.prepare(
      `SELECT id, deposit_id, source_type, source_id, created_at
       FROM accounting_deposit_items
       ORDER BY deposit_id ASC, id ASC`
    ).all(),
    accountingOperationMeta: db.prepare(
      `SELECT id, source_type, source_id, owner_user_id, retrocession_percent,
              retrocession_recipient, is_deleted, updated_at
       FROM accounting_operation_meta
       ORDER BY source_type ASC, source_id ASC, id ASC`
    ).all(),
    consultations: db.prepare(
      `SELECT id, patient_id, started_at, office_id, practitioner, title, important,
              height_cm, weight_kg, eva_before, eva_after, profile, created_at
       FROM consultations
       ORDER BY id ASC`
    ).all(),
    consultationReasonItems: db.prepare(
      `SELECT id, consultation_id, label, value, important, display_order, created_at
       FROM consultation_reason_items
       ORDER BY consultation_id ASC, display_order ASC, id ASC`
    ).all(),
    consultationSections: db.prepare(
      `SELECT id, consultation_id, section_key, content_cipher, created_at, updated_at
       FROM consultation_sections
       ORDER BY consultation_id ASC, section_key ASC, id ASC`
    ).all(),
    patientDocuments: db.prepare(
      `SELECT id, document_ref, patient_id, consultation_id, office_id, created_by,
              file_name, mime_type, size_bytes, title_cipher, comment_cipher,
              content_cipher, created_at
       FROM patient_documents
       ORDER BY id ASC`
    ).all(),
    antecedentTypes: db.prepare(
      `SELECT id, label, created_at
       FROM antecedent_types
       ORDER BY id ASC`
    ).all(),
    patientAntecedents: db.prepare(
      `SELECT id, patient_id, date_precision, date_display, category, description,
              important, sort_key, created_at, updated_at
       FROM patient_antecedents
       ORDER BY patient_id ASC, sort_key DESC, id DESC`
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
       FROM draft
       ORDER BY user_id ASC, flow_key ASC`
    ).all(),
    auditLogs: db.prepare(
      `SELECT id, user_id, action, entity, entity_id, metadata, created_at
       FROM audit_logs
       ORDER BY id ASC`
    ).all()
  };

  const selectedOfficeIds = Array.isArray(options.officeIds) ? options.officeIds : [];
  const scopedData = selectedOfficeIds.length > 0
    ? filterBackupDataByOfficeIds(data, selectedOfficeIds)
    : data;
  const dataSha256 = computeBackupDataSha256(scopedData);

  return {
    manifest: {
      format: BACKUP_MANIFEST_FORMAT,
      manifestVersion: BACKUP_MANIFEST_VERSION,
      createdAt,
      appVersion,
      appMajorVersion,
      sourceInstance: appName,
      dataSha256
    },
    meta: {
      schemaVersion: 2,
      createdAt,
      appName,
      appVersion
    },
    data: scopedData
  };
}

function restoreDataBackupSnapshot(backupPayload, prehashedUserPasswords = new Map()) {
  const { data: backup } = normalizeBackupEnvelope(backupPayload);

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM audit_logs').run();
    db.prepare('DELETE FROM draft').run();
    db.prepare('DELETE FROM patient_documents').run();
    db.prepare('DELETE FROM consultation_sections').run();
    db.prepare('DELETE FROM consultation_reason_items').run();
    db.prepare('DELETE FROM consultations').run();
    db.prepare('DELETE FROM appointments').run();
    db.prepare('DELETE FROM accounting_deposit_items').run();
    db.prepare('DELETE FROM accounting_deposits').run();
    db.prepare('DELETE FROM accounting_operation_meta').run();
    db.prepare('DELETE FROM accounting_expenses').run();
    db.prepare('DELETE FROM invoice_payments').run();
    db.prepare('DELETE FROM invoice_line_items').run();
    db.prepare('DELETE FROM invoices').run();
    db.prepare('DELETE FROM patients').run();
    db.prepare('DELETE FROM office_user_delegations').run();
    db.prepare('DELETE FROM user_offices').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM access_profiles').run();
    db.prepare('DELETE FROM patient_antecedents').run();
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
         bank_name_cipher, iban_cipher, retrocession_percent, retrocession_recipient,
         default_agenda_view, visible_calendars, default_service, invoice_mentions,
         created_at, must_change_password
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertPatient = db.prepare(
      `INSERT INTO patients (
         id, cipher_full_name, cipher_phone, cipher_medical_notes, sex,
         birth_date, marital_status, children_count, office_id,
         last_visit, consent_signed, consent_signed_at, consent_form_version, consent_withdrawn_at,
         retention_until, is_deleted, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertUserOffice = db.prepare(
      `INSERT INTO user_offices (user_id, office_id, created_at)
       VALUES (?, ?, ?)`
    );
    const insertOfficeUserDelegation = db.prepare(
      `INSERT INTO office_user_delegations (office_id, user_id, profile_id, created_at)
       VALUES (?, ?, ?, ?)`
    );
    const insertAppointment = db.prepare(
      `INSERT INTO appointments (
        id, patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id, office_id,
        practitioner, is_private, private_label_cipher, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertInvoice = db.prepare(
      `INSERT INTO invoices (
        id, patient_id, invoice_number, amount_cents, status,
        issued_at, due_at, notes_cipher, office_id, consultation_id,
        payment_method, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
     const insertInvoiceLineItem = db.prepare(
      `INSERT INTO invoice_line_items (id, invoice_id, label, quantity, unit_amount_ht_cents, vat_rate, display_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
     );
     const insertInvoicePayment = db.prepare(
      `INSERT INTO invoice_payments (id, invoice_id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
     );
     const insertAccountingExpense = db.prepare(
      `INSERT INTO accounting_expenses (
        id, occurred_at, office_id, owner_user_id, title, amount_cents, currency,
        payment_method, notes, retrocession_percent, retrocession_recipient,
        is_deleted, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
     );
     const insertAccountingDeposit = db.prepare(
      `INSERT INTO accounting_deposits (
        id, occurred_at, office_id, owner_user_id, type, deposit_code, bank_name_cipher,
        account_label, title, amount_cents, currency, notes,
        retrocession_percent, retrocession_recipient, is_deleted, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
     );
     const insertAccountingDepositItem = db.prepare(
      `INSERT INTO accounting_deposit_items (id, deposit_id, source_type, source_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
     );
     const insertAccountingOperationMeta = db.prepare(
      `INSERT INTO accounting_operation_meta (
        id, source_type, source_id, owner_user_id, retrocession_percent,
        retrocession_recipient, is_deleted, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
     );
    const insertConsultation = db.prepare(
      `INSERT INTO consultations (
         id, patient_id, started_at, office_id, practitioner, title, important,
         height_cm, weight_kg, eva_before, eva_after, profile, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
     const insertConsultationReasonItem = db.prepare(
      `INSERT INTO consultation_reason_items (id, consultation_id, label, value, important, display_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
     );
    const insertConsultationSection = db.prepare(
      `INSERT INTO consultation_sections (id, consultation_id, section_key, content_cipher, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertPatientDocument = db.prepare(
      `INSERT INTO patient_documents (
         id, document_ref, patient_id, consultation_id, office_id, created_by,
         file_name, mime_type, size_bytes, title_cipher, comment_cipher,
         content_cipher, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAntecedentType = db.prepare(
      `INSERT INTO antecedent_types (id, label, created_at)
       VALUES (?, ?, ?)`
    );
    const insertPatientAntecedent = db.prepare(
      `INSERT INTO patient_antecedents (
         id, patient_id, date_precision, date_display, category, description,
         important, sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertServiceType = db.prepare(
      `INSERT INTO service_types (id, office_id, label, amount_ht_cents, vat_rate, display_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertPaymentMethod = db.prepare(
      `INSERT INTO payment_methods (id, office_id, system_key, label, is_active, display_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
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
      `INSERT INTO draft (user_id, flow_key, draft_json, step, updated_at)
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
      const normalizedUsername = String(row.username ?? '').trim();
      if (!normalizedUsername) {
        continue;
      }
      const isAdminAccount = normalizedUsername.toLowerCase() === 'admin';
      let officeId = row.office_id != null ? Number(row.office_id) : null;

      if ((!Number.isInteger(officeId) || officeId <= 0) && typeof row.cabinet_name === 'string' && row.cabinet_name.trim()) {
        const office = db.prepare('SELECT id FROM offices WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1').get(row.cabinet_name);
        officeId = office ? Number(office.id) : null;
      }

      if (!Number.isInteger(officeId) || officeId <= 0) {
        officeId = null;
      }

      const userId = Number(row.id);
      const entry = prehashedUserPasswords.get(userId);
      if (!entry) {
        throw new Error(`Mot de passe temporaire manquant pour l'utilisateur ${userId}`);
      }
      const { hash: restoredPasswordHash } = entry;

      insertUser.run(
        userId,
        normalizedUsername,
        restoredPasswordHash,
        isAdminAccount ? 'admin' : (row.role ?? 'practitioner'),
        isAdminAccount ? 'super-admin' : (row.profile_id ?? 'super-admin'),
        isAdminAccount ? 1 : (Number(row.is_active) ? 1 : 0),
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
        restoreCipherField(row.bank_name_cipher ?? row.bank_name ?? ''),
        restoreCipherField(row.iban_cipher ?? row.iban ?? ''),
        Number(row.retrocession_percent) || 0,
        row.retrocession_recipient ?? '',
        row.default_agenda_view ?? 'Semaine',
        row.visible_calendars ?? 'Tous les calendriers',
        row.default_service ?? 'Aucune prestation',
        row.invoice_mentions ?? '',
        row.created_at ?? new Date().toISOString(),
        1
      );
    }

    for (const row of Array.isArray(backup.userOffices) ? backup.userOffices : []) {
      insertUserOffice.run(
        Number(row.user_id),
        Number(row.office_id),
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.officeUserDelegations) ? backup.officeUserDelegations : []) {
      insertOfficeUserDelegation.run(
        Number(row.office_id),
        Number(row.user_id),
        String(row.profile_id ?? '').trim() || 'super-admin',
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
        String(row.system_key ?? '').trim(),
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
        String(row.marital_status ?? 'Non renseigne'),
        Number(row.children_count) || 0,
        row.office_id != null ? Number(row.office_id) : null,
        row.last_visit ?? null,
        Number(row.consent_signed) ? 1 : 0,
        row.consent_signed_at ?? null,
        String(row.consent_form_version ?? '1.0'),
        row.consent_withdrawn_at ?? null,
        row.retention_until ?? null,
        Number(row.is_deleted) ? 1 : 0,
        row.created_at ?? new Date().toISOString(),
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.patientAntecedents) ? backup.patientAntecedents : []) {
      insertPatientAntecedent.run(
        Number(row.id),
        Number(row.patient_id),
        String(row.date_precision ?? 'date').trim() || 'date',
        restoreCipherField(String(row.date_display ?? '').trim()),
        String(row.category ?? '').trim(),
        restoreCipherField(String(row.description ?? '').trim()),
        Number(row.important) ? 1 : 0,
        Number(row.sort_key) || 0,
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
        row.office_id != null ? Number(row.office_id) : null,
        String(row.practitioner ?? ''),
        Number(row.is_private) ? 1 : 0,
        String(row.private_label_cipher ?? ''),
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
        row.office_id != null ? Number(row.office_id) : null,
        row.consultation_id != null ? Number(row.consultation_id) : null,
        String(row.payment_method ?? ''),
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.invoiceLineItems) ? backup.invoiceLineItems : []) {
      insertInvoiceLineItem.run(
        Number(row.id),
        Number(row.invoice_id),
        String(row.label ?? ''),
        Number(row.quantity) || 1,
        Number(row.unit_amount_ht_cents) || 0,
        Number(row.vat_rate) || 0,
        Number(row.display_order) || 0,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.invoicePayments) ? backup.invoicePayments : []) {
      insertInvoicePayment.run(
        Number(row.id),
        Number(row.invoice_id),
        String(row.paid_at ?? new Date().toISOString()),
        Number(row.amount_cents) || 0,
        String(row.currency ?? 'EUR'),
        String(row.payment_method ?? ''),
        restoreCipherField(row.bank_name_cipher ?? row.bank_name ?? ''),
        String(row.cheque_number ?? ''),
        String(row.reference ?? ''),
        String(row.notes ?? ''),
        row.created_by != null ? Number(row.created_by) : null,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.accountingExpenses) ? backup.accountingExpenses : []) {
      insertAccountingExpense.run(
        Number(row.id),
        String(row.occurred_at ?? new Date().toISOString()),
        row.office_id != null ? Number(row.office_id) : null,
        row.owner_user_id != null ? Number(row.owner_user_id) : null,
        String(row.title ?? ''),
        Number(row.amount_cents) || 0,
        String(row.currency ?? 'EUR'),
        String(row.payment_method ?? ''),
        String(row.notes ?? ''),
        Number(row.retrocession_percent) || 0,
        String(row.retrocession_recipient ?? ''),
        Number(row.is_deleted) ? 1 : 0,
        row.created_by != null ? Number(row.created_by) : null,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.accountingDeposits) ? backup.accountingDeposits : []) {
      insertAccountingDeposit.run(
        Number(row.id),
        String(row.occurred_at ?? new Date().toISOString()),
        row.office_id != null ? Number(row.office_id) : null,
        row.owner_user_id != null ? Number(row.owner_user_id) : null,
        row.type === 'especes' ? 'especes' : 'cheque',
        String(row.deposit_code ?? ''),
        restoreCipherField(row.bank_name_cipher ?? row.bank_name ?? ''),
        String(row.account_label ?? ''),
        String(row.title ?? ''),
        Number(row.amount_cents) || 0,
        String(row.currency ?? 'EUR'),
        String(row.notes ?? ''),
        Number(row.retrocession_percent) || 0,
        String(row.retrocession_recipient ?? ''),
        Number(row.is_deleted) ? 1 : 0,
        row.created_by != null ? Number(row.created_by) : null,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.accountingDepositItems) ? backup.accountingDepositItems : []) {
      insertAccountingDepositItem.run(
        Number(row.id),
        Number(row.deposit_id),
        String(row.source_type ?? ''),
        Number(row.source_id) || 0,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.accountingOperationMeta) ? backup.accountingOperationMeta : []) {
      insertAccountingOperationMeta.run(
        Number(row.id),
        String(row.source_type ?? ''),
        Number(row.source_id) || 0,
        row.owner_user_id != null ? Number(row.owner_user_id) : null,
        Number(row.retrocession_percent) || 0,
        String(row.retrocession_recipient ?? ''),
        Number(row.is_deleted) ? 1 : 0,
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.consultations) ? backup.consultations : []) {
      insertConsultation.run(
        Number(row.id),
        Number(row.patient_id),
        row.started_at ?? new Date().toISOString(),
        row.office_id != null ? Number(row.office_id) : null,
        row.practitioner ?? '',
        row.title ?? '',
        Number(row.important) ? 1 : 0,
        row.height_cm ?? null,
        row.weight_kg ?? null,
        Number(row.eva_before) || 0,
        Number(row.eva_after) || 0,
        row.profile ?? 'Adulte',
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.consultationReasonItems) ? backup.consultationReasonItems : []) {
      insertConsultationReasonItem.run(
        Number(row.id),
        Number(row.consultation_id),
        String(row.label ?? '').trim(),
        restoreCipherField(String(row.value ?? '').trim()),
        Number(row.important) ? 1 : 0,
        Number(row.display_order) || 0,
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.consultationSections) ? backup.consultationSections : []) {
      insertConsultationSection.run(
        Number(row.id),
        Number(row.consultation_id),
        String(row.section_key ?? '').trim(),
        String(row.content_cipher ?? ''),
        row.created_at ?? new Date().toISOString(),
        row.updated_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.patientDocuments) ? backup.patientDocuments : []) {
      insertPatientDocument.run(
        Number(row.id),
        String(row.document_ref ?? ''),
        Number(row.patient_id),
        row.consultation_id != null ? Number(row.consultation_id) : null,
        row.office_id != null ? Number(row.office_id) : null,
        row.created_by != null ? Number(row.created_by) : null,
        String(row.file_name ?? ''),
        String(row.mime_type ?? 'application/octet-stream'),
        Number(row.size_bytes) || 0,
        row.title_cipher ?? null,
        row.comment_cipher ?? null,
        String(row.content_cipher ?? ''),
        row.created_at ?? new Date().toISOString()
      );
    }

    for (const row of Array.isArray(backup.patientDrafts) ? backup.patientDrafts : []) {
      insertPatientDraft.run(
        Number(row.user_id),
        row.flow_key,
        restoreCipherField(row.draft_json),
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
      theme_mode,
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
      ${columnExpr('theme_mode', "'system'")},
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
        bank_name_cipher TEXT NOT NULL DEFAULT '',
        iban_cipher TEXT NOT NULL DEFAULT '',
        retrocession_percent REAL NOT NULL DEFAULT 0,
        retrocession_recipient TEXT NOT NULL DEFAULT '',
        default_agenda_view TEXT NOT NULL DEFAULT 'Semaine',
        visible_calendars TEXT NOT NULL DEFAULT 'Tous les calendriers',
        default_service TEXT NOT NULL DEFAULT 'Aucune prestation',
        invoice_mentions TEXT NOT NULL DEFAULT '',
        must_change_password INTEGER NOT NULL DEFAULT 0,
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
        bank_name, iban, bank_name_cipher, iban_cipher, retrocession_percent, retrocession_recipient,
        default_agenda_view, visible_calendars, default_service, invoice_mentions,
        must_change_password, include_free_consultations, show_consultation_hour,
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
        '', /* bank_name_cipher - will be populated by SEC-3 startup encryption migration */
        '', /* iban_cipher - will be populated by SEC-3 startup encryption migration */
        coalesce(u.retrocession_percent, 0),
        coalesce(u.retrocession_recipient, ''),
        coalesce(nullif(trim(u.default_agenda_view), ''), 'Semaine'),
        coalesce(nullif(trim(u.visible_calendars), ''), 'Tous les calendriers'),
        coalesce(nullif(trim(u.default_service), ''), 'Aucune prestation'),
        coalesce(u.invoice_mentions, ''),
        coalesce(u.must_change_password, 0),
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
     SET cipher_medical_notes = ?,
         marital_status = ?,
         children_count = ?,
         updated_at = CURRENT_TIMESTAMP
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
    const maritalStatus = String(parsedNotes.maritalStatus ?? 'Non renseigne').trim() || 'Non renseigne';
    const childrenCount = Math.max(0, Number.parseInt(String(parsedNotes.childrenCount ?? '0'), 10) || 0);

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
      maritalStatus,
      childrenCount,
      isDeceased: Boolean(parsedNotes.isDeceased)
    };
  };

  const migrate = db.transaction(() => {
    const rows = db.prepare(
      `SELECT id, cipher_full_name, cipher_phone, cipher_medical_notes, sex,
              marital_status, children_count
       FROM patients
       WHERE is_deleted = 0`
    ).all();

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
      const normalizedMaritalStatus = String(normalizedNotes.maritalStatus ?? 'Non renseigne').trim() || 'Non renseigne';
      const normalizedChildrenCount = Number.isFinite(Number(normalizedNotes.childrenCount))
        ? Math.max(0, Number(normalizedNotes.childrenCount))
        : 0;

      if (
        normalizedNotesJson !== currentNotes
        || String(row.marital_status ?? '').trim() !== normalizedMaritalStatus
        || Number(row.children_count ?? 0) !== normalizedChildrenCount
      ) {
        updateNotes.run(
          encryptSensitiveField(normalizedNotesJson),
          normalizedMaritalStatus,
          normalizedChildrenCount,
          row.id
        );
      }
    }
  });

  migrate();
}

async function ensureSeedData() {
  migrateUserPreferenceTable();

  db.exec(`
    CREATE TABLE IF NOT EXISTS patient_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_ref TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      consultation_id INTEGER,
      office_id INTEGER,
      created_by INTEGER,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      title_cipher TEXT,
      comment_cipher TEXT,
      content_cipher TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE SET NULL,
      FOREIGN KEY(office_id) REFERENCES offices(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

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
  ensureColumn('users', 'bank_name_cipher', "bank_name_cipher TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'iban_cipher', "iban_cipher TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'retrocession_percent', 'retrocession_percent REAL NOT NULL DEFAULT 0');
  ensureColumn('users', 'retrocession_recipient', "retrocession_recipient TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'default_agenda_view', "default_agenda_view TEXT NOT NULL DEFAULT 'Semaine'");
  ensureColumn('users', 'visible_calendars', "visible_calendars TEXT NOT NULL DEFAULT 'Tous les calendriers'");
  ensureColumn('users', 'default_service', "default_service TEXT NOT NULL DEFAULT 'Aucune prestation'");
  ensureColumn('users', 'invoice_mentions', "invoice_mentions TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'include_free_consultations', 'include_free_consultations INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'show_consultation_hour', 'show_consultation_hour INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'failed_login_attempts', 'failed_login_attempts INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'locked_until', 'locked_until TEXT');
  ensureColumn('appointments', 'local_calendar_id', 'local_calendar_id INTEGER');
  ensureColumn('appointments', 'office_id', 'office_id INTEGER');
  ensureColumn('appointments', 'consultation_id', 'consultation_id INTEGER');
  ensureColumn('appointments', 'practitioner', "practitioner TEXT NOT NULL DEFAULT ''");
  ensureColumn('appointments', 'is_private', 'is_private INTEGER NOT NULL DEFAULT 0');
  ensureColumn('appointments', 'private_label_cipher', "private_label_cipher TEXT NOT NULL DEFAULT ''");
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
  ensureColumn('offices', 'invoice_template_layout_json', "invoice_template_layout_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('offices', 'opening_hours_json', `opening_hours_json TEXT NOT NULL DEFAULT '{"monday":[],"tuesday":[],"wednesday":[],"thursday":[],"friday":[],"saturday":[],"sunday":[]}'`);
  ensureColumn('offices', 'consultation_profiles_json', "consultation_profiles_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('offices', 'payment_reminder_letter_title', "payment_reminder_letter_title TEXT NOT NULL DEFAULT ''");
  ensureColumn('offices', 'payment_reminder_letter_content', "payment_reminder_letter_content TEXT NOT NULL DEFAULT ''");
  ensureColumn('offices', 'patient_letters_json', "patient_letters_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('offices', 'siret', "siret TEXT NOT NULL DEFAULT ''");
  ensureColumn('offices', 'adeli_code', "adeli_code TEXT NOT NULL DEFAULT ''");
  ensureColumn('offices', 'rpps_code', "rpps_code TEXT NOT NULL DEFAULT ''");
  ensureColumn('offices', 'ape_naf_code', "ape_naf_code TEXT NOT NULL DEFAULT ''");
  ensureColumn('consultations', 'office_id', 'office_id INTEGER');
  ensureColumn('patients', 'office_id', 'office_id INTEGER');
  ensureColumn('patients', 'marital_status', "marital_status TEXT NOT NULL DEFAULT 'Non renseigne'");
  ensureColumn('patients', 'children_count', 'children_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('service_types', 'office_id', 'office_id INTEGER');
  ensureColumn('payment_methods', 'office_id', 'office_id INTEGER');
  ensureColumn('invoice_payments', 'bank_name', "bank_name TEXT NOT NULL DEFAULT ''");
  ensureColumn('invoice_payments', 'bank_name_cipher', "bank_name_cipher TEXT NOT NULL DEFAULT ''");
  ensureColumn('invoice_payments', 'cheque_number', "cheque_number TEXT NOT NULL DEFAULT ''");
  ensureColumn('accounting_deposits', 'bank_name_cipher', "bank_name_cipher TEXT NOT NULL DEFAULT ''");
  ensureColumn('patient_payment_credits', 'bank_name_cipher', "bank_name_cipher TEXT NOT NULL DEFAULT ''");
  ensureColumn('user_preference', 'slot_duration_minutes', 'slot_duration_minutes INTEGER NOT NULL DEFAULT 15');
  ensureColumn('user_preference', 'display_height', 'display_height INTEGER NOT NULL DEFAULT 14');
  ensureColumn('user_preference', 'theme_mode', "theme_mode TEXT NOT NULL DEFAULT 'system'");

  // SEC-3: encrypt bank_name and iban fields at rest (one-time migration of existing plaintext data)
  try {
    const encryptExistingColumn = (table, cipherCol, plaintextCol, extraWhere = '') => {
      const where = extraWhere ? ` AND (${extraWhere})` : '';
      const rows = db.prepare(`SELECT id, ${plaintextCol} FROM ${table} WHERE ${cipherCol} = '' AND ${plaintextCol} != ''${where}`).all();
      if (rows.length === 0) {
        return;
      }
      const stmt = db.prepare(`UPDATE ${table} SET ${cipherCol} = ? WHERE id = ?`);
      for (const row of rows) {
        stmt.run(encryptSensitiveField(String(row[plaintextCol])), row.id);
      }
      console.log(`✓ SEC-3: encrypted ${rows.length} existing ${table}.${cipherCol} values`);
    };
    encryptExistingColumn('users', 'bank_name_cipher', 'bank_name');
    encryptExistingColumn('users', 'iban_cipher', 'iban');
    encryptExistingColumn('invoice_payments', 'bank_name_cipher', 'bank_name');
    encryptExistingColumn('accounting_deposits', 'bank_name_cipher', 'bank_name');
    encryptExistingColumn('patient_payment_credits', 'bank_name_cipher', 'bank_name');
    // SEC-3: clear plaintext columns now that cipher columns are populated
    db.prepare(`UPDATE users SET bank_name = '', iban = '' WHERE bank_name != '' OR iban != ''`).run();
    db.prepare(`UPDATE invoice_payments SET bank_name = '' WHERE bank_name != ''`).run();
    db.prepare(`UPDATE patient_payment_credits SET bank_name = '' WHERE bank_name != ''`).run();
    // accounting_deposits has no plaintext bank_name column used by new writes; only bank_name_cipher
  } catch (err) {
    console.warn('SEC-3 encryption migration failed:', err.message);
  }

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
      theme_mode,
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
          'system',
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
      theme_mode = CASE
        WHEN theme_mode IN ('system', 'light', 'dark') THEN theme_mode
        ELSE 'system'
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

  const superAdminProfileId = SUPER_ADMIN_PROFILE_ID;
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
      id: 'cabinet-member',
      label: 'Cabinet uniquement',
      description: 'Aucun droit applicatif global. Les acces sont definis par cabinet.',
      immutable: 0,
      rights: buildAccessRights(false)
    },
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
    ['Carte bleu (CB)', 1, 1],
    ['Espèces', 1, 2],
    ['Chèque', 1, 3]
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

    // Always ensure default payment methods have proper system_keys and active status.
    // This is important for offices that were created before the system_key column was added.
    ensureDefaultOfficePaymentMethods(officeId);
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

  db.prepare(
    `UPDATE users
     SET profile_id = ?,
         role = 'admin',
         is_active = 1
     WHERE username = ?`
  ).run(superAdminProfileId, 'admin');


  const officeCount = Number(db.prepare('SELECT COUNT(*) as count FROM offices').get()?.count ?? 0);
  if (officeCount === 0) {
    // Keep first-run setup deterministic: no business entities until the first office is configured or restored.
    clearBusinessDataForInitialSetup();
  }
}

const FR_DATE_FORMATTER = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

function formatDateFr(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return FR_DATE_FORMATTER.format(date);
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

function buildAntecedentSortKey(precision, display) {
  if (precision === 'year') {
    const year = Number(display);
    if (!Number.isInteger(year) || year < 1800 || year > 2999) {
      return null;
    }
    return year * 10000 + 1231;
  }

  if (precision === 'month') {
    const [monthStr, yearStr] = String(display).split('/');
    const month = Number(monthStr);
    const year = Number(yearStr);
    if (!Number.isInteger(month) || !Number.isInteger(year) || month < 1 || month > 12 || year < 1800 || year > 2999) {
      return null;
    }
    return year * 10000 + month * 100 + 31;
  }

  const [dayStr, monthStr, yearStr] = String(display).split('/');
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year) ||
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < 1800 ||
    year > 2999
  ) {
    return null;
  }
  return year * 10000 + month * 100 + day;
}

function parsePatientAntecedentsFromMedicalHistory(medicalHistoryRaw) {
  const raw = String(medicalHistoryRaw ?? '').trim();
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item) => {
      const precision = item?.datePrecision === 'year' || item?.datePrecision === 'month' || item?.datePrecision === 'date'
        ? item.datePrecision
        : 'date';
      const dateDisplay = String(item?.date ?? '').trim();
      const category = String(item?.category ?? '').trim();
      const description = String(item?.description ?? '').trim();
      const sortKey = buildAntecedentSortKey(precision, dateDisplay);
      if (!category || !dateDisplay || sortKey == null) {
        return null;
      }

      return {
        datePrecision: precision,
        dateDisplay,
        category,
        description,
        important: Boolean(item?.important),
        sortKey
      };
    })
    .filter(Boolean)
    .slice(0, 400);
}

function normalizeConsultationReasonItems(rawItems) {
  return Array.isArray(rawItems)
    ? rawItems
      .map((item) => ({
        label: String(item?.label ?? '').trim(),
        value: String(item?.value ?? '').trim(),
        important: Boolean(item?.important)
      }))
      .filter((item, index, all) => item.label && all.findIndex((candidate) => candidate.label === item.label) === index)
    : [];
}

const CONSULTATION_SECTION_KEYS = ['motifMainHtml', 'testsHtml', 'schemaHtml', 'treatmentsHtml', 'remarksHtml'];

function buildEmptyConsultationSections() {
  return {
    motifMainHtml: '',
    testsHtml: '',
    schemaHtml: '',
    treatmentsHtml: '',
    remarksHtml: ''
  };
}

function normalizeConsultationSectionsPayload(rawSections) {
  const source = rawSections && typeof rawSections === 'object' ? rawSections : {};
  const normalized = buildEmptyConsultationSections();

  for (const key of CONSULTATION_SECTION_KEYS) {
    normalized[key] = String(source[key] ?? '');
  }

  return normalized;
}

function hasConsultationSectionsContent(sections) {
  return CONSULTATION_SECTION_KEYS.some((key) => String(sections?.[key] ?? '').trim().length > 0);
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

function getDefaultCalendarForUser(userId, officeIdFilter = null) {
  const accessibleCalendarIds = getAccessibleCalendarIdsForUser(userId, officeIdFilter);
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

function resolveConsultationSchedulingContextFromRaw(consultationNoteRaw, options = {}) {
  const raw = String(consultationNoteRaw ?? '').trim();
  if (!raw) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const normalizedReasonItems = normalizeConsultationReasonItems(data.reasonItems);

  const hasContent =
    String(data.title ?? '').trim() ||
    normalizedReasonItems.length > 0 ||
    String(data.motifMainHtml ?? '').trim() ||
    String(data.testsHtml ?? '').trim() ||
    String(data.schemaHtml ?? '').trim() ||
    String(data.treatmentsHtml ?? '').trim() ||
    String(data.remarksHtml ?? '').trim();

  if (!hasContent) {
    return null;
  }

  const userId = Number(options.userId);
  const requestedOfficeId = Number(options.officeId);
  const draftOfficeId = Number(data.officeId);
  const preferRequestedOffice = options.preferRequestedOffice === true;

  let localCalendarId = null;
  let slotDurationMinutes = 60;
  let alignedStartIso = String(data.startedAt ?? new Date().toISOString());
  let consultationOfficeId = preferRequestedOffice
    ? (Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 ? requestedOfficeId : null)
    : (Number.isInteger(draftOfficeId) && draftOfficeId > 0
      ? draftOfficeId
      : (Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 ? requestedOfficeId : null));

  if (consultationOfficeId != null) {
    const exists = db.prepare('SELECT id FROM offices WHERE id = ?').get(consultationOfficeId);
    if (!exists) {
      consultationOfficeId = null;
    }
  }

  if (Number.isInteger(userId) && userId > 0) {
    const defaultCalendar = getDefaultCalendarForUser(userId, consultationOfficeId);
    if (defaultCalendar) {
      localCalendarId = defaultCalendar.id;

      if (defaultCalendar.officeId != null) {
        if (consultationOfficeId == null) {
          consultationOfficeId = Number(defaultCalendar.officeId);
        }

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

  return {
    alignedStartIso,
    consultationOfficeId,
    localCalendarId,
    slotDurationMinutes
  };
}

function findOverlappingAppointmentForOffice(officeId, localCalendarId, startsAtIso, durationMinutes) {
  const startDate = new Date(startsAtIso);
  if (Number.isNaN(startDate.getTime())) {
    return null;
  }
  const endDate = new Date(startDate.getTime() + (durationMinutes * 60 * 1000));

  let rows = [];
  if (Number.isInteger(officeId) && Number(officeId) > 0) {
    rows = db
      .prepare(
        `SELECT id, starts_at
         FROM appointments
         WHERE office_id = ?
         ORDER BY datetime(starts_at) ASC, id ASC`
      )
      .all(Number(officeId));
  } else if (Number.isInteger(localCalendarId) && Number(localCalendarId) > 0) {
    rows = db
      .prepare(
        `SELECT id, starts_at
         FROM appointments
         WHERE local_calendar_id = ?
         ORDER BY datetime(starts_at) ASC, id ASC`
      )
      .all(Number(localCalendarId));
  } else {
    return null;
  }

  for (const row of rows) {
    const currentStart = new Date(row.starts_at);
    if (Number.isNaN(currentStart.getTime())) {
      continue;
    }

    const currentEnd = new Date(currentStart.getTime() + (durationMinutes * 60 * 1000));
    if (currentStart < endDate && currentEnd > startDate) {
      return {
        id: Number(row.id),
        startsAt: String(row.starts_at)
      };
    }
  }

  return null;
}

function updatePatientRetentionFields(patientId, consultationDateIso) {
  db.prepare(
    `UPDATE patients SET
       last_visit = CASE WHEN last_visit IS NULL OR date(?) > last_visit THEN date(?) ELSE last_visit END,
       retention_until = CASE WHEN retention_until IS NULL OR date(?, '+10 years') > retention_until THEN date(?, '+10 years') ELSE retention_until END
     WHERE id = ?`
  ).run(consultationDateIso, consultationDateIso, consultationDateIso, consultationDateIso, patientId);
}

function insertConsultationFromNote(patientId, consultationNoteRaw, options = {}) {
  const raw = String(consultationNoteRaw ?? '').trim();
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  const normalizedReasonItems = Array.isArray(data.reasonItems)
    ? data.reasonItems
      .map((item) => ({
        label: String(item?.label ?? '').trim(),
        value: String(item?.value ?? '').trim(),
        important: Boolean(item?.important)
      }))
      .filter((item, index, all) => item.label && all.findIndex((candidate) => candidate.label === item.label) === index)
    : [];

  const hasContent =
    String(data.title ?? '').trim() ||
    normalizedReasonItems.length > 0 ||
    String(data.motifMainHtml ?? '').trim() ||
    String(data.testsHtml ?? '').trim() ||
    String(data.schemaHtml ?? '').trim() ||
    String(data.treatmentsHtml ?? '').trim() ||
    String(data.remarksHtml ?? '').trim();

  if (!hasContent) return null;

  const userId = Number(options.userId);
  const linkStrategy = options.linkStrategy === 'create-new' ? 'create-new' : 'attach-existing';
  const requestedOfficeId = Number(options.officeId);
  const draftOfficeId = Number(data.officeId);

  let localCalendarId = null;
  let slotDurationMinutes = 60;
  let alignedStartIso = String(data.startedAt ?? new Date().toISOString());
  let consultationOfficeId = Number.isInteger(draftOfficeId) && draftOfficeId > 0
    ? draftOfficeId
    : (Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 ? requestedOfficeId : null);

  if (consultationOfficeId != null) {
    const exists = db.prepare('SELECT id FROM offices WHERE id = ?').get(consultationOfficeId);
    if (!exists) {
      consultationOfficeId = null;
    }
  }

  if (Number.isInteger(userId) && userId > 0) {
    const defaultCalendar = getDefaultCalendarForUser(userId, consultationOfficeId);
    if (defaultCalendar) {
      localCalendarId = defaultCalendar.id;
      if (defaultCalendar.officeId != null) {
        if (consultationOfficeId == null) {
          consultationOfficeId = Number(defaultCalendar.officeId);
        }
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
        (patient_id, started_at, office_id, practitioner, title, important, height_cm, weight_kg,
         eva_before, eva_after, profile)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      patientId,
      alignedStartIso,
      consultationOfficeId,
      String(data.practitioner ?? '').trim(),
      String(data.title ?? '').trim(),
      data.important ? 1 : 0,
      typeof data.heightCm === 'number' ? data.heightCm : null,
      typeof data.weightKg === 'number' ? data.weightKg : null,
      typeof data.evaBefore === 'number' ? data.evaBefore : 0,
      typeof data.evaAfter === 'number' ? data.evaAfter : 0,
      String(data.profile ?? 'Adulte').trim() || 'Adulte'
    );

    const consultationId = Number(createdConsultation.lastInsertRowid);
    replaceConsultationReasonItems(consultationId, normalizedReasonItems);
    replaceConsultationSections(consultationId, {
      motifMainHtml: data.motifMainHtml,
      testsHtml: data.testsHtml,
      schemaHtml: data.schemaHtml,
      treatmentsHtml: data.treatmentsHtml,
      remarksHtml: data.remarksHtml
    });

    updatePatientRetentionFields(patientId, alignedStartIso);

    const title = String(data.title ?? '').trim();
    const reason = title || 'Consultation';

    const overlappingAppointmentId = findOverlappingAppointmentForPatient(
      patientId,
      localCalendarId,
      alignedStartIso,
      slotDurationMinutes
    );

    if (overlappingAppointmentId && linkStrategy === 'attach-existing') {
      db
        .prepare('UPDATE appointments SET consultation_id = ?, office_id = coalesce(office_id, ?) WHERE id = ?')
        .run(consultationId, consultationOfficeId, overlappingAppointmentId);
      return {
        consultationId,
        appointmentId: overlappingAppointmentId,
        linkedToExisting: true,
        officeId: consultationOfficeId
      };
    }

    const createdAppointment = db
      .prepare(
        `INSERT INTO appointments (patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id, office_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        patientId,
        alignedStartIso,
        encryptSensitiveField(reason),
        'A confirmer',
        localCalendarId,
        consultationId,
        consultationOfficeId
      );

    return {
      consultationId,
      appointmentId: Number(createdAppointment.lastInsertRowid),
      linkedToExisting: false,
      officeId: consultationOfficeId
    };
  } catch { /* table might not exist on first run – will be created on restart */ }

  return null;
}

const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

async function validateDocumentMimeType(contentBase64) {
  const buffer = Buffer.from(contentBase64, 'base64');
  const detected = await fileTypeFromBuffer(buffer);
  const actualMime = detected?.mime ?? null;

  if (actualMime !== null && !ALLOWED_DOCUMENT_MIME_TYPES.has(actualMime)) {
    throw Object.assign(new Error(`Type de fichier non autorisé: ${actualMime}`), { statusCode: 415 });
  }

  if (actualMime !== null) {
    return actualMime;
  }

  return 'application/octet-stream';
}

async function normalizeConsultationDocumentsPayload(rawDocuments) {
  const input = Array.isArray(rawDocuments) ? rawDocuments : [];
  const seenRefs = new Set();
  const normalized = [];

  for (const item of input) {
    const fileName = String(item?.fileName ?? '').trim();
    const contentBase64 = String(item?.contentBase64 ?? '').trim();
    if (!fileName || !contentBase64) {
      continue;
    }

    const documentRef = String(item?.documentRef ?? '').trim() || `doc-${crypto.randomUUID()}`;
    if (seenRefs.has(documentRef)) {
      continue;
    }
    seenRefs.add(documentRef);

    const mimeType = await validateDocumentMimeType(contentBase64);

    normalized.push({
      documentRef,
      fileName,
      mimeType,
      sizeBytes: Math.max(0, Number(item?.sizeBytes) || 0),
      title: String(item?.title ?? '').trim(),
      comment: String(item?.comment ?? '').trim(),
      contentBase64
    });
  }

  return normalized;
}

async function storeConsultationDocuments(patientId, consultationId, officeId, createdByUserId, rawDocuments) {
  const documents = await normalizeConsultationDocumentsPayload(rawDocuments);
  return insertNormalizedDocuments(patientId, consultationId, officeId, createdByUserId, documents);
}

function insertNormalizedDocuments(patientId, consultationId, officeId, createdByUserId, documents) {
  if (!documents.length) {
    return [];
  }

  const insertDocument = db.prepare(
    `INSERT INTO patient_documents
      (document_ref, patient_id, consultation_id, office_id, created_by, file_name, mime_type, size_bytes, title_cipher, comment_cipher, content_cipher)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction((items) => {
    for (const doc of items) {
      insertDocument.run(
        doc.documentRef,
        patientId,
        consultationId,
        officeId,
        createdByUserId,
        doc.fileName,
        doc.mimeType,
        doc.sizeBytes,
        doc.title ? encryptSensitiveField(doc.title) : null,
        doc.comment ? encryptSensitiveField(doc.comment) : null,
        encryptSensitiveField(doc.contentBase64)
      );
    }
  });

  insertMany(documents);
  return documents.map((doc) => ({
    documentRef: doc.documentRef,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes
  }));
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

function replacePatientAntecedents(patientId, medicalHistoryRaw) {
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return;
  }

  const antecedents = parsePatientAntecedentsFromMedicalHistory(medicalHistoryRaw);
  const replaceMany = db.transaction((id, items) => {
    db.prepare('DELETE FROM patient_antecedents WHERE patient_id = ?').run(id);

    if (!items.length) {
      return;
    }

    const insertAntecedent = db.prepare(
      `INSERT INTO patient_antecedents
        (patient_id, date_precision, date_display, category, description, important, sort_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const item of items) {
      insertAntecedent.run(
        id,
        item.datePrecision,
        encryptSensitiveField(item.dateDisplay),
        item.category,
        encryptSensitiveField(item.description),
        item.important ? 1 : 0,
        item.sortKey
      );
    }
  });

  replaceMany(patientId, antecedents);
}

function replaceConsultationReasonItems(consultationId, reasonItems) {
  if (!Number.isInteger(consultationId) || consultationId <= 0) {
    return;
  }

  const normalized = normalizeConsultationReasonItems(reasonItems);
  const replaceMany = db.transaction((id, items) => {
    db.prepare('DELETE FROM consultation_reason_items WHERE consultation_id = ?').run(id);

    if (!items.length) {
      return;
    }

    const insertItem = db.prepare(
      `INSERT INTO consultation_reason_items (consultation_id, label, value, important, display_order)
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const [index, item] of items.entries()) {
      insertItem.run(
        id,
        item.label,
        encryptSensitiveField(item.value),
        item.important ? 1 : 0,
        index
      );
    }
  });

  replaceMany(consultationId, normalized);
}

function replaceConsultationSections(consultationId, sections) {
  if (!Number.isInteger(consultationId) || consultationId <= 0) {
    return;
  }

  const normalized = normalizeConsultationSectionsPayload(sections);
  const replaceMany = db.transaction((id, nextSections) => {
    db.prepare('DELETE FROM consultation_sections WHERE consultation_id = ?').run(id);

    if (!hasConsultationSectionsContent(nextSections)) {
      return;
    }

    const insertSection = db.prepare(
      `INSERT INTO consultation_sections (consultation_id, section_key, content_cipher)
       VALUES (?, ?, ?)`
    );

    for (const key of CONSULTATION_SECTION_KEYS) {
      const content = String(nextSections[key] ?? '');
      if (!content.trim()) {
        continue;
      }

      insertSection.run(
        id,
        key,
        encryptSensitiveField(content)
      );
    }
  });

  replaceMany(consultationId, normalized);
}

function getConsultationReasonItems(consultationId) {
  if (!Number.isInteger(consultationId) || consultationId <= 0) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT label, value, important
       FROM consultation_reason_items
       WHERE consultation_id = ?
       ORDER BY display_order ASC, id ASC`
    )
    .all(consultationId);

  if (rows.length > 0) {
    return rows
      .map((row) => ({
        label: String(row.label ?? '').trim(),
        value: safeDecryptField(row.value).trim(),
        important: Boolean(row.important)
      }))
      .filter((item) => item.label.length > 0);
  }

  return [];
}

function getConsultationSections(consultationId) {
  if (!Number.isInteger(consultationId) || consultationId <= 0) {
    return buildEmptyConsultationSections();
  }

  const rows = db
    .prepare(
      `SELECT section_key, content_cipher
       FROM consultation_sections
       WHERE consultation_id = ?
       ORDER BY id ASC`
    )
    .all(consultationId);

  if (rows.length > 0) {
    const sections = buildEmptyConsultationSections();
    for (const row of rows) {
      const key = String(row.section_key ?? '').trim();
      if (!CONSULTATION_SECTION_KEYS.includes(key)) {
        continue;
      }

      try {
        sections[key] = decryptSensitiveField(row.content_cipher);
      } catch {
        sections[key] = '';
      }
    }
    return sections;
  }

  return buildEmptyConsultationSections();
}

function getPatientAntecedentItems(patientId, medicalHistoryRaw = null) {
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT category, description, important
       FROM patient_antecedents
       WHERE patient_id = ?
       ORDER BY sort_key DESC, id DESC`
    )
    .all(patientId);

  if (rows.length > 0) {
    return rows
      .map((row) => ({
        category: String(row.category ?? '').trim(),
        label: safeDecryptField(row.description).trim(),
        important: Boolean(row.important)
      }))
      .filter((item) => item.category.length > 0 || item.label.length > 0);
  }

  const fallback = parseStatisticsAntecedents(medicalHistoryRaw);
  if (fallback.length > 0) {
    replacePatientAntecedents(patientId, medicalHistoryRaw);
  }

  return fallback;
}

function buildConsultationReasonItemsMap(rows) {
  const consultationIds = [...new Set(
    rows
      .map((row) => Number(row?.id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )];

  const map = new Map();
  if (consultationIds.length === 0) {
    return map;
  }

  const placeholders = consultationIds.map(() => '?').join(', ');
  const relationRows = db
    .prepare(
      `SELECT consultation_id, label, value, important
       FROM consultation_reason_items
       WHERE consultation_id IN (${placeholders})
       ORDER BY consultation_id ASC, display_order ASC, id ASC`
    )
    .all(...consultationIds);

  for (const row of relationRows) {
    const consultationId = Number(row.consultation_id);
    const items = map.get(consultationId) ?? [];
    items.push({
      label: String(row.label ?? '').trim(),
      value: safeDecryptField(row.value).trim(),
      important: Boolean(row.important)
    });
    map.set(consultationId, items.filter((item) => item.label.length > 0));
  }

  for (const row of rows) {
    const consultationId = Number(row?.id);
    if (!Number.isInteger(consultationId) || consultationId <= 0 || map.has(consultationId)) {
      continue;
    }

    map.set(consultationId, []);
  }

  return map;
}

function buildConsultationSectionsMap(rows) {
  const consultationIds = [...new Set(
    rows
      .map((row) => Number(row?.id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )];

  const map = new Map();
  if (consultationIds.length === 0) {
    return map;
  }

  const placeholders = consultationIds.map(() => '?').join(', ');
  const relationRows = db
    .prepare(
      `SELECT consultation_id, section_key, content_cipher
       FROM consultation_sections
       WHERE consultation_id IN (${placeholders})
       ORDER BY consultation_id ASC, id ASC`
    )
    .all(...consultationIds);

  for (const row of relationRows) {
    const consultationId = Number(row.consultation_id);
    const key = String(row.section_key ?? '').trim();
    if (!CONSULTATION_SECTION_KEYS.includes(key)) {
      continue;
    }

    const sections = map.get(consultationId) ?? buildEmptyConsultationSections();
    try {
      sections[key] = decryptSensitiveField(row.content_cipher);
    } catch {
      sections[key] = '';
    }
    map.set(consultationId, sections);
  }

  for (const row of rows) {
    const consultationId = Number(row?.id);
    if (!Number.isInteger(consultationId) || consultationId <= 0 || map.has(consultationId)) {
      continue;
    }

    map.set(consultationId, buildEmptyConsultationSections());
  }

  return map;
}

function buildPatientAntecedentsMap(rows) {
  const patientIds = [...new Set(
    rows
      .map((row) => Number(row?.id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )];

  const map = new Map();
  if (patientIds.length === 0) {
    return map;
  }

  const placeholders = patientIds.map(() => '?').join(', ');
  const relationRows = db
    .prepare(
      `SELECT patient_id, category, description, important
       FROM patient_antecedents
       WHERE patient_id IN (${placeholders})
       ORDER BY patient_id ASC, sort_key DESC, id DESC`
    )
    .all(...patientIds);

  for (const row of relationRows) {
    const patientId = Number(row.patient_id);
    const items = map.get(patientId) ?? [];
    items.push({
      category: String(row.category ?? '').trim(),
      label: safeDecryptField(row.description).trim(),
      important: Boolean(row.important)
    });
    map.set(patientId, items.filter((item) => item.category.length > 0 || item.label.length > 0));
  }

  for (const row of rows) {
    const patientId = Number(row?.id);
    if (!Number.isInteger(patientId) || patientId <= 0 || map.has(patientId)) {
      continue;
    }

    const notes = parsePatientNotesFromCipher(row.cipher_medical_notes);
    const fallback = parseStatisticsAntecedents(notes.medicalHistory);
    if (fallback.length > 0) {
      replacePatientAntecedents(patientId, String(notes.medicalHistory ?? ''));
      map.set(patientId, fallback);
    }
  }

  return map;
}

function normalizeAuditValue(value) {
  return String(value ?? '').trim();
}

function normalizeBase64Payload(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) {
    return '';
  }

  const marker = 'base64,';
  const markerIndex = raw.indexOf(marker);
  const payload = markerIndex >= 0 ? raw.slice(markerIndex + marker.length) : raw;
  return payload.replace(/\s+/g, '');
}

function getBase64DecodedByteLength(base64Payload) {
  if (!base64Payload) {
    return 0;
  }

  try {
    return Buffer.from(base64Payload, 'base64').length;
  } catch {
    return 0;
  }
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
    maritalStatus: 'Statut marital',
    childrenCount: "Nombre d'enfants",
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
      beforeCipher: encryptSensitiveField(before),
      afterCipher: encryptSensitiveField(after)
    });
  }

  return changes;
}

// Routes that remain accessible even when must_change_password is set
const ROUTES_ALLOWED_WITH_MUST_CHANGE_PASSWORD = new Set([
  '/api/auth/logout',
  '/api/auth/me',
  '/api/profile/me',
]);

function authMiddleware(req, res, next) {
  const token = req.cookies[SESSION_COOKIE_NAME];

  if (!token) {
    writeAuthSecurityLog(req, 'unauthenticated_request_blocked', {
      reason: 'missing_session_cookie',
      statusCode: 401
    });
    return res.status(401).json({ message: 'Session absente' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = payload;

    // Enforce must_change_password: fast-path from JWT flag (mcp=true) or fallback DB
    // check for tokens issued before this flag was introduced. The DB check is only
    // performed when the JWT already signals mcp or when the flag is absent (legacy token).
    if (!ROUTES_ALLOWED_WITH_MUST_CHANGE_PASSWORD.has(req.path)) {
      const jwtMcp = payload.mcp;
      if (jwtMcp === true || jwtMcp === undefined) {
        // mcp=true  → JWT signals flag; confirm with DB in case it was cleared
        // mcp=undefined → legacy token without flag; DB check for backward compat
        const userFlags = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(payload.sub);
        if (userFlags?.must_change_password === 1) {
          return res.status(403).json({ message: 'Changement de mot de passe requis', mustChangePassword: true });
        }
      }
      // mcp === false → no restriction, skip DB check
    }

    return next();
  } catch {
    writeAuthSecurityLog(req, 'unauthenticated_request_blocked', {
      reason: 'invalid_session_cookie',
      statusCode: 401
    });
    return res.status(401).json({ message: 'Session invalide' });
  }
}

function adminOnlyMiddleware(req, res, next) {
  if (req.user.role === 'admin') {
    return next();
  }

  const access = getUserAccessContext(req.user.sub);
  if (access?.profileId === SUPER_ADMIN_PROFILE_ID) {
    req.userAccess = access;
    return next();
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Acces refuse' });
  }

  return next();
}

function isLoopbackAddress(address) {
  const value = String(address ?? '').trim();
  if (!value) {
    return false;
  }

  return value === '::1' || value === '127.0.0.1' || value === '::ffff:127.0.0.1';
}

function writeSetupSecurityLog(req, event, details = {}) {
  try {
    const remoteAddress = String(req.socket?.remoteAddress ?? req.ip ?? '').trim() || null;
    const forwardedFor = String(req.headers?.['x-forwarded-for'] ?? '').trim() || null;
    const userAgent = String(req.headers?.['user-agent'] ?? '').trim() || null;

    writeAuditLog(null, 'SECURITY', 'setup', null, {
      event,
      method: req.method,
      route: req.originalUrl,
      remoteAddress,
      forwardedFor,
      userAgent,
      ...details
    });
  } catch (error) {
    console.warn('Unable to write setup security log:', error instanceof Error ? error.message : error);
  }
}

function setupBootstrapGuard(req, res, next) {
  const setupStatus = getSetupStatusSnapshot();
  if (!setupStatus.requiresSetup) {
    writeSetupSecurityLog(req, 'setup_guard_blocked', {
      reason: 'setup_not_required',
      requiresSetup: false
    });
    return res.status(403).json({ message: 'La configuration initiale n\'est disponible qu\'au premier demarrage' });
  }

  if (allowRemoteSetup) {
    return next();
  }

  const remoteAddress = req.socket?.remoteAddress ?? req.ip;
  if (!isLoopbackAddress(remoteAddress)) {
    writeSetupSecurityLog(req, 'setup_guard_blocked', {
      reason: 'remote_access_forbidden',
      allowRemoteSetup
    });
    return res.status(403).json({
      message: 'Configuration initiale autorisee uniquement en local. Definissez ALLOW_REMOTE_SETUP=true pour autoriser l\'acces distant.'
    });
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

  const delegatedRightsRows = db
    .prepare(
      `SELECT p.rights_json
       FROM office_user_delegations oud
       INNER JOIN access_profiles p ON p.id = oud.profile_id
       WHERE oud.user_id = ?`
    )
    .all(userId);

  const delegatedRights = delegatedRightsRows.map((delegation) => {
    try {
      return delegation.rights_json ? JSON.parse(delegation.rights_json) : {};
    } catch {
      return {};
    }
  });

  const hasGlobalOfficeAccess = row.role === 'admin' || row.profile_id === SUPER_ADMIN_PROFILE_ID;
  let offices = hasGlobalOfficeAccess
    ? db
      .prepare('SELECT id, name FROM offices ORDER BY lower(name) ASC, id ASC')
      .all()
      .map((office) => ({ id: Number(office.id), name: String(office.name ?? '').trim() }))
    : getUserOfficeOptions(row.id);

  if (hasGlobalOfficeAccess && offices.length === 0) {
    // Legacy fallback: old datasets may have offices marked inactive by mistake.
    offices = db
      .prepare('SELECT id, name FROM offices ORDER BY lower(name) ASC, id ASC')
      .all()
      .map((office) => ({ id: Number(office.id), name: String(office.name ?? '').trim() }));
  }

  offices = offices.filter((office) => Number.isInteger(office.id) && office.id > 0 && office.name.length > 0);
  const officeIds = offices.map((office) => office.id);

  return {
    id: row.id,
    username: row.username,
    role: row.role,
    profileId: row.profile_id ?? null,
    profileLabel: row.profile_label ?? null,
    officeIds,
    offices,
    rights: hasGlobalOfficeAccess
      ? buildAccessRights(true)
      : mergeAccessRights(delegatedRights.length > 0 ? delegatedRights : [parsedRights])
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

    if (access.role === 'admin' || access.profileId === SUPER_ADMIN_PROFILE_ID) {
      req.userAccess = access;
      return next();
    }

    if (!hasPermission(access.rights, permissionId)) {
      writeAuthSecurityLog(req, 'authorization_denied', {
        userId: access.id,
        username: access.username,
        profileId: access.profileId,
        permissionId,
        reason: 'missing_permission'
      });
      return res.status(403).json({ message: 'Droit insuffisant' });
    }

    req.userAccess = access;
    return next();
  };
}

function requireAnyPermission(permissionIds) {
  const normalizedPermissionIds = Array.isArray(permissionIds)
    ? permissionIds.map((permissionId) => String(permissionId ?? '').trim()).filter((permissionId) => permissionId.length > 0)
    : [];

  return (req, res, next) => {
    const access = getUserAccessContext(req.user.sub);
    if (!access) {
      return res.status(401).json({ message: 'Session invalide' });
    }

    if (access.role === 'admin' || access.profileId === SUPER_ADMIN_PROFILE_ID) {
      req.userAccess = access;
      return next();
    }

    const hasAnyPermission = normalizedPermissionIds.some((permissionId) => hasPermission(access.rights, permissionId));
    if (!hasAnyPermission) {
      writeAuthSecurityLog(req, 'authorization_denied', {
        userId: access.id,
        username: access.username,
        profileId: access.profileId,
        permissionIds: normalizedPermissionIds,
        reason: 'missing_any_permission'
      });
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
  maritalStatus: z.enum(['Non renseigne', 'Celibataire', 'Marie(e)', 'Pacse(e)', 'Divorce(e)', 'Veuf(ve)']).optional().default('Non renseigne'),
  childrenCount: z.number().int().min(0).max(50).optional().default(0),
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
  consultationDocuments: z.array(
    z.object({
      documentRef: z.string().max(120).optional(),
      fileName: z.string().min(1).max(255),
      mimeType: z.string().max(120).optional().default('application/octet-stream'),
      sizeBytes: z.number().int().nonnegative().optional().default(0),
      title: z.string().max(200).optional().default(''),
      comment: z.string().max(2000).optional().default(''),
      contentBase64: z.string().min(1).max(20_000_000)
    })
  ).optional().default([]),
  consultationLinkStrategy: z.enum(['attach-existing', 'create-new']).optional()
});

const updateConsultationSchema = z.object({
  startedAt: z.string().min(1).max(40),
  practitioner: z.string().max(160).optional().default(''),
  title: z.string().max(200).optional().default(''),
  important: z.boolean().optional().default(false),
  heightCm: z.number().nonnegative().max(300).nullable().optional().default(null),
  weightKg: z.number().nonnegative().max(500).nullable().optional().default(null),
  evaBefore: z.number().int().min(0).max(10).optional().default(0),
  evaAfter: z.number().int().min(0).max(10).optional().default(0),
  profile: z.string().max(120).optional().default('Adulte'),
  reasonItems: z.array(
    z.object({
      label: z.string().max(160),
      value: z.string().max(1000).optional().default(''),
      important: z.boolean().optional().default(false)
    })
  ).optional().default([]),
  motifMainHtml: z.string().max(50_000).optional().default(''),
  testsHtml: z.string().max(50_000).optional().default(''),
  schemaHtml: z.string().max(50_000).optional().default(''),
  treatmentsHtml: z.string().max(50_000).optional().default(''),
  remarksHtml: z.string().max(50_000).optional().default('')
});

const createPatientConsultationSchema = updateConsultationSchema.extend({
  officeId: z.number().int().positive().nullable().optional().default(null),
  consultationDocuments: z.array(
    z.object({
      documentRef: z.string().max(80).optional(),
      fileName: z.string().min(1).max(260),
      mimeType: z.string().max(120).optional().default('application/octet-stream'),
      sizeBytes: z.number().int().nonnegative().optional().default(0),
      title: z.string().max(200).optional().default(''),
      comment: z.string().max(2000).optional().default(''),
      contentBase64: z.string().min(1).max(20_000_000)
    })
  ).optional().default([])
});

const newConsultationDraftSchema = z.object({
  step: z.number().int().min(1).max(1).optional().default(1),
  payload: createPatientConsultationSchema
});

const patientDraftSchema = z.object({
  step: z.number().int().min(1).max(5),
  payload: createPatientSchema
});

const officeDraftSchema = z.object({
  step: z.number().int().min(1).max(7),
  payload: z.record(z.string(), z.unknown())
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
  maritalStatus: z.enum(['Non renseigne', 'Celibataire', 'Marie(e)', 'Pacse(e)', 'Divorce(e)', 'Veuf(ve)']).optional(),
  childrenCount: z.number().int().min(0).max(50).optional(),
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

const addOfficeDelegationSchema = z.object({
  userId: z.number().int().positive(),
  profileId: z.string().min(1).max(80)
});

const updateOfficeDelegationSchema = z.object({
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

const updateMyProfileSchema = userAccountFieldsSchema.omit({
  isActive: true,
  profileId: true,
  role: true,
  officeId: true,
  officeIds: true
});

const backupManifestSchema = z.object({
  format: z.literal(BACKUP_MANIFEST_FORMAT),
  manifestVersion: z.number().int().min(1),
  createdAt: z.string().min(1),
  appVersion: z.string().min(1),
  appMajorVersion: z.number().int().min(0).optional(),
  sourceInstance: z.string().optional(),
  dataSha256: z.string().regex(/^[a-f0-9]{64}$/i)
});

const backupDataSchema = z.object({
  accessProfiles: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  users: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  userOffices: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  officeUserDelegations: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  patients: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  appointments: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  invoices: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  invoiceLineItems: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  invoicePayments: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  accountingExpenses: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  accountingDeposits: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  accountingDepositItems: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  accountingOperationMeta: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  consultations: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  consultationReasonItems: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  consultationSections: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  antecedentTypes: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  patientAntecedents: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  serviceTypes: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  paymentMethods: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  localCalendars: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  directoryContacts: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  patientDocuments: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  config: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  patientDrafts: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  auditLogs: z.array(z.record(z.string(), z.unknown())).optional().default([])
});

const dataRestoreSchema = z.object({
  meta: z.record(z.string(), z.unknown()).optional(),
  manifest: backupManifestSchema.optional(),
  data: backupDataSchema
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
  themeMode: z.enum(['system', 'light', 'dark']),
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

if (trustedProxies !== false) {
  app.set('trust proxy', trustedProxies);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
      }
    }
  })
);
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:4200',
    credentials: true
  })
);

// Routes that accept large file payloads (documents, backups, imports, logos)
// Patterns are kept strict (bounded \d{1,10}) to avoid runaway regex on malformed paths
const LARGE_BODY_ROUTE_PATTERNS = [
  /^\/api\/data-management\/restore$/,
  /^\/api\/data-management\/import$/,
  /^\/api\/data-management\/webosteo-import$/,
  /^\/api\/patients\/\d{1,10}\/documents$/,
  /^\/api\/patients\/\d{1,10}\/consultations$/,
  /^\/api\/patients\/\d{1,10}\/consultation-drafts\/new-consultation$/,
  /^\/api\/offices(\/\d{1,10})?$/,
  /^\/api\/setup\/office$/,
];

function resolveBodyLimit(path) {
  return LARGE_BODY_ROUTE_PATTERNS.some((pattern) => pattern.test(path))
    ? largeRequestBodyLimit
    : requestBodyLimit;
}

// Pre-create parser instances once at startup; selected per-request based on route
const jsonParserDefault = express.json({ limit: requestBodyLimit });
const jsonParserLarge = express.json({ limit: largeRequestBodyLimit });
const urlencodedParserDefault = express.urlencoded({ limit: requestBodyLimit, extended: true });
const urlencodedParserLarge = express.urlencoded({ limit: largeRequestBodyLimit, extended: true });

app.use((req, res, next) => {
  const isLargeRoute = LARGE_BODY_ROUTE_PATTERNS.some((pattern) => pattern.test(req.path));
  const jsonParser = isLargeRoute ? jsonParserLarge : jsonParserDefault;
  const urlencodedParser = isLargeRoute ? urlencodedParserLarge : urlencodedParserDefault;
  jsonParser(req, res, (jsonErr) => {
    if (jsonErr) {
      return next(jsonErr);
    }
    urlencodedParser(req, res, next);
  });
});
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  handler: (req, res) => {
    writeAuthSecurityLog(req, 'login_rate_limit_blocked', {
      reason: 'rate_limit',
      statusCode: 429,
      windowMs: 10 * 60 * 1000,
      maxAttempts: 15,
      attemptedUsername: String(req.body?.username ?? '').trim().slice(0, 120) || null
    });
    return res.status(429).json({ message: 'Trop de tentatives de connexion. Reessayez plus tard.' });
  }
});

const setupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  handler: (req, res) => {
    writeSetupSecurityLog(req, 'setup_rate_limit_blocked', {
      reason: 'rate_limit',
      windowMs: 10 * 60 * 1000,
      maxAttempts: 10
    });
    return res.status(429).json({ message: 'Trop de tentatives de configuration initiale. Reessayez plus tard.' });
  }
});

app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    if (!req.user?.sub || !shouldAutoTraceRequest(req)) {
      return;
    }

    const route = String(req.originalUrl ?? '').split('?')[0];
    const durationMs = Math.max(0, Date.now() - startedAt);
    const statusCode = Number(res.statusCode) || 0;

    writeAuditLog(req.user.sub, 'REQUEST', 'user-action', null, {
      source: 'auto',
      method: String(req.method ?? '').toUpperCase(),
      route,
      statusCode,
      success: statusCode > 0 && statusCode < 400,
      durationMs
    });
  });

  return next();
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/config', (_req, res) => {
  const appName = db.prepare('SELECT value FROM config WHERE key = ?').get('app_name');
  res.json({
    app_name: appName?.value ?? 'OsteoSoft'
    // version intentionally omitted from public endpoint
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

app.get('/api/profile/me', authMiddleware, (req, res) => {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.created_at, u.role, u.is_active, u.profile_id, p.label AS profile_label,
              u.office_id, o.name AS office_name, u.last_name, u.first_name, u.email, u.mobile_phone, u.country,
              u.siret, u.adeli_code, u.rpps_code, u.ape_naf_code, u.name_suffix_text,
              u.letter_header, u.letter_footer, u.signature_text, u.color_hex,
              u.bank_name_cipher, u.iban_cipher, u.retrocession_percent, u.retrocession_recipient,
              u.default_agenda_view, u.visible_calendars, u.default_service, u.invoice_mentions,
              u.include_free_consultations, u.show_consultation_hour,
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
    .get(req.user.sub);

  if (!row) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  return res.json({ profile: mapUserAccountRow(row) });
});

app.put('/api/profile/me', authMiddleware, async (req, res) => {
  const parsed = updateMyProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;
  const currentUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.user.sub);

  if (!currentUser) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  const username = payload.username.trim();
  if (!username) {
    return res.status(400).json({ message: 'Le login est obligatoire' });
  }

  const usernameConflict = db
    .prepare('SELECT id FROM users WHERE lower(username) = lower(?) AND id <> ?')
    .get(username, req.user.sub);

  if (usernameConflict) {
    return res.status(409).json({ message: 'Un utilisateur avec ce login existe deja' });
  }

  if (currentUser.username === 'admin' && username !== 'admin') {
    return res.status(403).json({ message: 'Le login du compte admin ne peut pas être modifié' });
  }

  db.prepare(
    `UPDATE users
     SET username = ?,
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
         bank_name_cipher = ?,
         iban_cipher = ?,
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
    payload.bankName.trim() ? encryptSensitiveField(payload.bankName.trim()) : '',
    payload.iban.trim() ? encryptSensitiveField(payload.iban.trim()) : '',
    Number(payload.retrocessionPercent) || 0,
    payload.retrocessionRecipient.trim(),
    payload.defaultAgendaView.trim() || 'Semaine',
    payload.visibleCalendars.trim() || 'Tous les calendriers',
    payload.defaultService.trim() || 'Aucune prestation',
    payload.invoiceMentions.trim(),
    payload.includeFreeConsultations ? 1 : 0,
    payload.showConsultationHour ? 1 : 0,
    req.user.sub
  );

  const nextPassword = payload.password.trim();
  if (nextPassword) {
    const passwordHash = await argon2.hash(nextPassword, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(passwordHash, req.user.sub);

    // Re-issue session cookie so the new JWT no longer carries mcp=true
    const updatedUser = db.prepare('SELECT id, role, username, must_change_password FROM users WHERE id = ?').get(req.user.sub);
    if (updatedUser) {
      const newToken = signTokenForSession(updatedUser, false);
      res.cookie(SESSION_COOKIE_NAME, newToken, buildSessionCookieOptions(false));
    }
  }

  writeAuditLog(req.user.sub, 'UPDATE', 'users', String(req.user.sub), {
    username,
    updatedPassword: Boolean(nextPassword)
  });

  return res.status(204).send();
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

app.get('/api/offices', authMiddleware, requirePermission('read-office-settings'), (req, res) => {
  const isGlobalOfficeAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  const scopedOfficeIds = getScopedOfficeOptions(req.userAccess, isGlobalOfficeAdmin)
    .map((office) => Number(office.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (!isGlobalOfficeAdmin && scopedOfficeIds.length === 0) {
    return res.json({ offices: [] });
  }

  const selectOfficesSql = `
    SELECT id, name, default_session_duration_minutes as defaultSessionDurationMinutes, country, devise,
           invoice_number_format as invoiceNumberFormat, invoice_numbering_configuration as invoiceNumberingConfiguration,
           invoice_show_insurance_fields as invoiceShowInsuranceFields, invoice_hide_vat_mention as invoiceHideVatMention,
           invoice_template_layout_json as invoiceTemplateLayoutJson,
           address_line1 as addressLine1, address_line2 as addressLine2,
           postal_code as postalCode, city, phone_mobile as phoneMobile,
           phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
           vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson,
           consultation_profiles_json as consultationProfilesJson,
           payment_reminder_letter_title as paymentReminderLetterTitle,
           payment_reminder_letter_content as paymentReminderLetterContent,
           patient_letters_json as patientLettersJson,
           is_active as isActive,
           display_order as displayOrder, created_at as createdAt, updated_at as updatedAt
    FROM offices`;

  let offices = [];
  if (isGlobalOfficeAdmin) {
    offices = db.prepare(`${selectOfficesSql} ORDER BY display_order ASC, created_at DESC`).all() || [];
  } else {
    const placeholders = scopedOfficeIds.map(() => '?').join(', ');
    offices = db.prepare(`${selectOfficesSql} WHERE id IN (${placeholders}) ORDER BY display_order ASC, created_at DESC`).all(...scopedOfficeIds) || [];
  }
  
  return res.json({
    offices: offices.map(mapOfficeRow)
  });
});

app.post('/api/offices', authMiddleware, requirePermission('create-office'), (req, res) => {
  if (!isApplicationSuperAdmin(req.userAccess)) {
    writeAuthSecurityLog(req, 'authorization_denied', {
      userId: req.user.sub,
      permissionId: 'create-office',
      reason: 'application_super_admin_required'
    });
    return res.status(403).json({ message: 'Acces reserve aux super administrateurs application' });
  }

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
    paymentReminderLetterTemplate,
    patientLetterTemplates,
    invoiceTemplateLayoutJson,
    openingHours,
    consultationProfiles,
    officeUserDelegations,
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
  const normalizedInvoiceTemplateLayoutJson = normalizeInvoiceTemplateLayoutJson(invoiceTemplateLayoutJson);
  const normalizedConsultationProfiles = normalizeOfficeConsultationProfiles(consultationProfiles);
  const normalizedPaymentReminderLetterTitle = normalizeOfficeLetterTitle(
    paymentReminderLetterTemplate?.title ?? DEFAULT_PAYMENT_REMINDER_LETTER_TITLE
  );
  const normalizedPaymentReminderLetterContent = normalizeOfficeLetterContent(
    paymentReminderLetterTemplate?.content ?? DEFAULT_PAYMENT_REMINDER_LETTER_CONTENT
  );
  const normalizedPatientLettersJson = JSON.stringify(normalizePatientLetterTemplates(patientLetterTemplates));

  try {
    const maxOrder = db.prepare(`SELECT MAX(display_order) as maxOrder FROM offices`).get() || {};
    const displayOrder = (maxOrder.maxOrder || 0) + 1;

    const insert = db.prepare(`
      INSERT INTO offices (name, default_session_duration_minutes, country, devise, invoice_number_format, invoice_numbering_configuration,
                           invoice_show_insurance_fields, invoice_hide_vat_mention, invoice_template_layout_json, address_line1, address_line2, postal_code, city, phone_mobile,
                           phone_landline, phone_fax, email, website, vat_number, logo_data, opening_hours_json,
                           consultation_profiles_json, payment_reminder_letter_title, payment_reminder_letter_content,
                           patient_letters_json, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      name, normalizedDefaultSessionDurationMinutes, normalizedCountry, normalizedDevise,
      normalizedInvoiceNumberFormat, normalizedInvoiceNumberingConfiguration, normalizedInvoiceShowInsuranceFields, normalizedInvoiceHideVatMention,
      normalizedInvoiceTemplateLayoutJson,
      addressLine1 || null, addressLine2 || null, postalCode || null, city || null,
      phoneMobile || null, phoneLandline || null, phoneFax || null, email || null,
      website || null, vatNumber || null, logoData || null, JSON.stringify(normalizedOpeningHours),
      JSON.stringify(normalizedConsultationProfiles),
      normalizedPaymentReminderLetterTitle,
      normalizedPaymentReminderLetterContent,
      normalizedPatientLettersJson,
      displayOrder
    );

    const createdOfficeId = Number(result.lastInsertRowid);
    replaceOfficeBusinessSettings(createdOfficeId, serviceTypes, paymentMethods);
    replaceOfficeUserDelegations(createdOfficeId, officeUserDelegations);

    createLocalCalendarFromOffice(createdOfficeId, name);

    // Clean up the draft after successful creation
    db.prepare(
      `DELETE FROM draft
       WHERE user_id = ? AND flow_key = 'new_office'`
    ).run(req.user.sub);

    writeAuditLog(req.user.id, 'CREATE', 'office', result.lastInsertRowid, {
      name, city, defaultSessionDurationMinutes: normalizedDefaultSessionDurationMinutes
    });

    const office = db.prepare(`
          SELECT id, name, default_session_duration_minutes as defaultSessionDurationMinutes, country, devise,
            invoice_number_format as invoiceNumberFormat, invoice_numbering_configuration as invoiceNumberingConfiguration,
            invoice_show_insurance_fields as invoiceShowInsuranceFields, invoice_hide_vat_mention as invoiceHideVatMention,
            invoice_template_layout_json as invoiceTemplateLayoutJson,
            address_line1 as addressLine1, address_line2 as addressLine2,
             postal_code as postalCode, city, phone_mobile as phoneMobile,
             phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
             vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson,
             consultation_profiles_json as consultationProfilesJson,
             payment_reminder_letter_title as paymentReminderLetterTitle,
             payment_reminder_letter_content as paymentReminderLetterContent,
             patient_letters_json as patientLettersJson,
             is_active as isActive,
             display_order as displayOrder, created_at as createdAt, updated_at as updatedAt
      FROM offices WHERE id = ?
    `).get(result.lastInsertRowid);

    return res.json({ office: mapOfficeRow(office) });
  } catch (err) {
    console.error('Error creating office:', err);
    return res.status(500).json({ message: 'Erreur lors de la création du cabinet' });
  }
});

app.put('/api/offices/:id', authMiddleware, requirePermission('update-office-settings'), (req, res) => {
  const officeId = Number(req.params.id);

  if (!Number.isInteger(officeId) || officeId <= 0) {
    return res.status(400).json({ message: 'ID de cabinet invalide' });
  }

  const isGlobalOfficeAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  if (!isGlobalOfficeAdmin) {
    const scopedOfficeIds = new Set(
      getScopedOfficeOptions(req.userAccess, false)
        .map((office) => Number(office.id))
        .filter((id) => Number.isInteger(id) && id > 0)
    );

    if (!scopedOfficeIds.has(officeId)) {
      writeAuthSecurityLog(req, 'authorization_denied', {
        userId: req.user.sub,
        permissionId: 'update-office-settings',
        officeId,
        reason: 'office_scope_denied'
      });
      return res.status(403).json({ message: 'Acces interdit a ce cabinet' });
    }
  }

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
    paymentReminderLetterTemplate,
    patientLetterTemplates,
    invoiceTemplateLayoutJson,
    openingHours,
    consultationProfiles,
    officeUserDelegations,
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
  const normalizedInvoiceTemplateLayoutJson = normalizeInvoiceTemplateLayoutJson(invoiceTemplateLayoutJson);
  const normalizedConsultationProfiles = normalizeOfficeConsultationProfiles(consultationProfiles);
  const normalizedPaymentReminderLetterTitle = normalizeOfficeLetterTitle(paymentReminderLetterTemplate?.title);
  const normalizedPaymentReminderLetterContent = normalizeOfficeLetterContent(paymentReminderLetterTemplate?.content);
  const normalizedPatientLettersJson = JSON.stringify(normalizePatientLetterTemplates(patientLetterTemplates));

  try {
    const update = db.prepare(`
      UPDATE offices
        SET name = ?, default_session_duration_minutes = ?, country = ?, devise = ?, invoice_number_format = ?,
          invoice_numbering_configuration = ?, invoice_show_insurance_fields = ?, invoice_hide_vat_mention = ?, invoice_template_layout_json = ?, address_line1 = ?, address_line2 = ?, postal_code = ?, city = ?,
          phone_mobile = ?, phone_landline = ?, phone_fax = ?, email = ?, website = ?,
          vat_number = ?, logo_data = ?, opening_hours_json = ?, consultation_profiles_json = ?,
          payment_reminder_letter_title = ?, payment_reminder_letter_content = ?,
          patient_letters_json = ?,
          is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    update.run(
      name, normalizedDefaultSessionDurationMinutes, normalizedCountry, normalizedDevise,
      normalizedInvoiceNumberFormat, normalizedInvoiceNumberingConfiguration, normalizedInvoiceShowInsuranceFields, normalizedInvoiceHideVatMention,
      normalizedInvoiceTemplateLayoutJson,
      addressLine1 || null, addressLine2 || null, postalCode || null, city || null,
      phoneMobile || null, phoneLandline || null, phoneFax || null, email || null,
      website || null, vatNumber || null, logoData || null, JSON.stringify(normalizedOpeningHours),
      JSON.stringify(normalizedConsultationProfiles),
      normalizedPaymentReminderLetterTitle,
      normalizedPaymentReminderLetterContent,
      normalizedPatientLettersJson,
      isActive ? 1 : 0,
      officeId
    );

    replaceOfficeBusinessSettings(officeId, serviceTypes, paymentMethods);
    replaceOfficeUserDelegations(officeId, officeUserDelegations);

    writeAuditLog(req.user.id, 'UPDATE', 'office', officeId, { name, city, defaultSessionDurationMinutes: normalizedDefaultSessionDurationMinutes });

    const office = db.prepare(`
          SELECT id, name, default_session_duration_minutes as defaultSessionDurationMinutes, country, devise,
            invoice_number_format as invoiceNumberFormat, invoice_numbering_configuration as invoiceNumberingConfiguration,
            invoice_show_insurance_fields as invoiceShowInsuranceFields, invoice_hide_vat_mention as invoiceHideVatMention,
            invoice_template_layout_json as invoiceTemplateLayoutJson,
            address_line1 as addressLine1, address_line2 as addressLine2,
             postal_code as postalCode, city, phone_mobile as phoneMobile,
             phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
             vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson,
                  consultation_profiles_json as consultationProfilesJson,
                  payment_reminder_letter_title as paymentReminderLetterTitle,
                  payment_reminder_letter_content as paymentReminderLetterContent,
                  patient_letters_json as patientLettersJson,
                  is_active as isActive,
             display_order as displayOrder, created_at as createdAt, updated_at as updatedAt
      FROM offices WHERE id = ?
    `).get(officeId);

    return res.json({ office: mapOfficeRow(office) });
  } catch (err) {
    console.error('Error updating office:', err);
    return res.status(500).json({ message: 'Erreur lors de la mise à jour du cabinet' });
  }
});

app.delete('/api/offices/:id', authMiddleware, requirePermission('delete-office'), (req, res) => {
  if (!isApplicationSuperAdmin(req.userAccess)) {
    writeAuthSecurityLog(req, 'authorization_denied', {
      userId: req.user.sub,
      permissionId: 'delete-office',
      officeId: Number(req.params.id),
      reason: 'application_super_admin_required'
    });
    return res.status(403).json({ message: 'Acces reserve aux super administrateurs application' });
  }

  const officeId = Number(req.params.id);

  if (!Number.isInteger(officeId) || officeId <= 0) {
    return res.status(400).json({ message: 'ID de cabinet invalide' });
  }

  const isGlobalOfficeAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  if (!isGlobalOfficeAdmin) {
    const scopedOfficeIds = new Set(
      getScopedOfficeOptions(req.userAccess, false)
        .map((office) => Number(office.id))
        .filter((id) => Number.isInteger(id) && id > 0)
    );

    if (!scopedOfficeIds.has(officeId)) {
      writeAuthSecurityLog(req, 'authorization_denied', {
        userId: req.user.sub,
        permissionId: 'delete-office',
        officeId,
        reason: 'office_scope_denied'
      });
      return res.status(403).json({ message: 'Acces interdit a ce cabinet' });
    }
  }

  try {
    const existing = db.prepare('SELECT id FROM offices WHERE id = ?').get(officeId);
    if (!existing) {
      return res.status(404).json({ message: 'Cabinet introuvable' });
    }

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

app.post('/api/offices/reorder', authMiddleware, requirePermission('reorder-offices'), (req, res) => {
  const { officeIds } = req.body;
  if (!Array.isArray(officeIds)) {
    return res.status(400).json({ message: 'officeIds doit être un tableau' });
  }

  const isGlobalOfficeAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  if (!isGlobalOfficeAdmin) {
    writeAuthSecurityLog(req, 'authorization_denied', {
      userId: req.user.sub,
      permissionId: 'reorder-offices',
      reason: 'global_admin_required'
    });
    return res.status(403).json({ message: 'Reorganisation reservee aux administrateurs globaux' });
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
            invoice_template_layout_json as invoiceTemplateLayoutJson,
            address_line1 as addressLine1, address_line2 as addressLine2,
             postal_code as postalCode, city, phone_mobile as phoneMobile,
             phone_landline as phoneLandline, phone_fax as phoneFax, email, website,
             siret, adeli_code as adeliCode, rpps_code as rppsCode, ape_naf_code as apeNafCode,
             vat_number as vatNumber, logo_data as logoData, opening_hours_json as openingHoursJson,
             consultation_profiles_json as consultationProfilesJson, is_active as isActive,
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

// ---- Delegation CRUD routes ----

function checkOfficeScopeOrRespond(req, res, officeId, permissionId) {
  const isGlobalOfficeAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  if (isGlobalOfficeAdmin) {
    return true;
  }

  const scopedOfficeIds = new Set(
    getScopedOfficeOptions(req.userAccess, false)
      .map((office) => Number(office.id))
      .filter((id) => Number.isInteger(id) && id > 0)
  );

  if (!scopedOfficeIds.has(officeId)) {
    writeAuthSecurityLog(req, 'authorization_denied', {
      userId: req.user.sub,
      permissionId,
      officeId,
      reason: 'office_scope_denied'
    });
    res.status(403).json({ message: 'Acces interdit a ce cabinet' });
    return false;
  }

  return true;
}

app.get('/api/offices/:id/delegations', authMiddleware, requirePermission('read-office-settings'), (req, res) => {
  const officeId = Number(req.params.id);
  if (!Number.isInteger(officeId) || officeId <= 0) {
    return res.status(400).json({ message: 'ID de cabinet invalide' });
  }

  if (!checkOfficeScopeOrRespond(req, res, officeId, 'read-office-settings')) {
    return;
  }

  const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(officeId);
  if (!office) {
    return res.status(404).json({ message: 'Cabinet introuvable' });
  }

  const delegations = readOfficeUserDelegations(officeId);
  return res.json({ delegations });
});

app.post('/api/offices/:id/delegations', authMiddleware, requirePermission('update-office-settings'), (req, res) => {
  const officeId = Number(req.params.id);
  if (!Number.isInteger(officeId) || officeId <= 0) {
    return res.status(400).json({ message: 'ID de cabinet invalide' });
  }

  if (!checkOfficeScopeOrRespond(req, res, officeId, 'update-office-settings')) {
    return;
  }

  const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(officeId);
  if (!office) {
    return res.status(404).json({ message: 'Cabinet introuvable' });
  }

  const parsed = addOfficeDelegationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const { userId, profileId } = parsed.data;

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  const profile = db.prepare('SELECT id FROM access_profiles WHERE id = ?').get(profileId);
  if (!profile) {
    return res.status(404).json({ message: 'Profil introuvable' });
  }

  const existing = db.prepare('SELECT id FROM office_user_delegations WHERE office_id = ? AND user_id = ?').get(officeId, userId);
  if (existing) {
    return res.status(409).json({ message: 'Cet utilisateur possède déjà une délégation dans ce cabinet' });
  }

  try {
    db.prepare(
      'INSERT INTO office_user_delegations (office_id, user_id, profile_id) VALUES (?, ?, ?)'
    ).run(officeId, userId, profileId);

    writeAuditLog(req.user.sub, 'CREATE', 'office_user_delegations', officeId, { userId, profileId });

    const delegations = readOfficeUserDelegations(officeId);
    return res.status(201).json({ delegations });
  } catch (err) {
    console.error('Error adding office delegation:', err);
    return res.status(500).json({ message: 'Erreur lors de l\'ajout de la délégation' });
  }
});

app.put('/api/offices/:id/delegations/:userId', authMiddleware, requirePermission('update-office-settings'), (req, res) => {
  const officeId = Number(req.params.id);
  const userId = Number(req.params.userId);

  if (!Number.isInteger(officeId) || officeId <= 0 || !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  if (!checkOfficeScopeOrRespond(req, res, officeId, 'update-office-settings')) {
    return;
  }

  const parsed = updateOfficeDelegationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const { profileId } = parsed.data;

  const profile = db.prepare('SELECT id FROM access_profiles WHERE id = ?').get(profileId);
  if (!profile) {
    return res.status(404).json({ message: 'Profil introuvable' });
  }

  const existing = db.prepare('SELECT id FROM office_user_delegations WHERE office_id = ? AND user_id = ?').get(officeId, userId);
  if (!existing) {
    return res.status(404).json({ message: 'Délégation introuvable' });
  }

  try {
    db.prepare(
      'UPDATE office_user_delegations SET profile_id = ? WHERE office_id = ? AND user_id = ?'
    ).run(profileId, officeId, userId);

    writeAuditLog(req.user.sub, 'UPDATE', 'office_user_delegations', officeId, { userId, profileId });

    const delegations = readOfficeUserDelegations(officeId);
    return res.json({ delegations });
  } catch (err) {
    console.error('Error updating office delegation:', err);
    return res.status(500).json({ message: 'Erreur lors de la mise à jour de la délégation' });
  }
});

app.delete('/api/offices/:id/delegations/:userId', authMiddleware, requirePermission('update-office-settings'), (req, res) => {
  const officeId = Number(req.params.id);
  const userId = Number(req.params.userId);

  if (!Number.isInteger(officeId) || officeId <= 0 || !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  if (!checkOfficeScopeOrRespond(req, res, officeId, 'update-office-settings')) {
    return;
  }

  const existing = db.prepare('SELECT id FROM office_user_delegations WHERE office_id = ? AND user_id = ?').get(officeId, userId);
  if (!existing) {
    return res.status(404).json({ message: 'Délégation introuvable' });
  }

  try {
    db.prepare('DELETE FROM office_user_delegations WHERE office_id = ? AND user_id = ?').run(officeId, userId);

    writeAuditLog(req.user.sub, 'DELETE', 'office_user_delegations', officeId, { userId });

    const delegations = readOfficeUserDelegations(officeId);
    return res.json({ delegations });
  } catch (err) {
    console.error('Error deleting office delegation:', err);
    return res.status(500).json({ message: 'Erreur lors de la suppression de la délégation' });
  }
});

app.get('/api/offices/:id/delegations/export', authMiddleware, requirePermission('read-office-settings'), (req, res) => {
  const officeId = Number(req.params.id);
  if (!Number.isInteger(officeId) || officeId <= 0) {
    return res.status(400).json({ message: 'ID de cabinet invalide' });
  }

  if (!checkOfficeScopeOrRespond(req, res, officeId, 'read-office-settings')) {
    return;
  }

  const office = db.prepare('SELECT id, name FROM offices WHERE id = ?').get(officeId);
  if (!office) {
    return res.status(404).json({ message: 'Cabinet introuvable' });
  }

  const delegations = readOfficeUserDelegations(officeId);

  const header = ['cabinet', 'utilisateur', 'profil'];
  const lines = [header.join(';')];
  for (const d of delegations) {
    lines.push([office.name, d.displayName, d.profileLabel].map((value) => serializeCsvCell(value, ';')).join(';'));
  }

  const officeName = String(office.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `delegations-${officeName || officeId}-${stamp}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  writeAuditLog(req.user.sub, 'EXPORT', 'office_user_delegations', officeId, { count: delegations.length });
  return res.status(200).send(`\uFEFF${lines.join('\n')}`);
});

app.get('/api/setup/status', (_req, res) => {
  const { requiresSetup } = getSetupStatusSnapshot();
  return res.json({ requiresSetup, hasEncryptionKey: !!rawDataKey });
});

const DATA_IMPORT_PATIENTS_SHEET = 'Patients';
const DATA_IMPORT_CONTACTS_SHEET = 'Contacts';
const DATA_IMPORT_CONSULTATIONS_SHEET = 'Consultations';

const DATA_IMPORT_PATIENT_HEADERS = [
  'lastName',
  'firstName',
  'sex',
  'birthDate',
  'mobilePhone',
  'landlinePhone',
  'email',
  'address1',
  'address2',
  'postalCode',
  'city',
  'country',
  'maritalStatus',
  'childrenCount',
  'occupationOrSchool',
  'hobbies',
  'primaryDoctor',
  'socialSecurityNumber',
  'referredBy',
  'manualPreference',
  'generalRemarks',
  'medicalHistory',
  'relatedPeople',
  'isDeceased'
];

const DATA_IMPORT_CONTACT_HEADERS = [
  'kind',
  'firstName',
  'lastName',
  'organization',
  'role',
  'email',
  'mobilePhone',
  'landlinePhone',
  'address1',
  'address2',
  'postalCode',
  'city',
  'country',
  'notes'
];

const DATA_IMPORT_CONSULTATION_HEADERS = [
  'patientLastName',
  'patientFirstName',
  'patientBirthDate',
  'startedAt',
  'practitioner',
  'title',
  'profile',
  'important',
  'heightCm',
  'weightKg',
  'evaBefore',
  'evaAfter',
  'motifMainHtml',
  'testsHtml',
  'schemaHtml',
  'treatmentsHtml',
  'remarksHtml'
];

const DATA_IMPORT_PATIENT_SAMPLE = {
  lastName: 'Durand',
  firstName: 'Marie',
  sex: 'Femme',
  birthDate: '1990-05-14',
  mobilePhone: '0611223344',
  landlinePhone: '',
  email: 'marie.durand@example.com',
  address1: '12 rue des Lilas',
  address2: '',
  postalCode: '44000',
  city: 'Nantes',
  country: 'France',
  maritalStatus: 'Marie(e)',
  childrenCount: '2',
  occupationOrSchool: 'Enseignante',
  hobbies: 'Yoga',
  primaryDoctor: 'Dr Leroy',
  socialSecurityNumber: '',
  referredBy: 'Doctolib',
  manualPreference: 'Droitier',
  generalRemarks: '',
  medicalHistory: 'Lombalgie chronique',
  relatedPeople: '',
  isDeceased: 'false'
};

const DATA_IMPORT_CONTACT_SAMPLE = {
  kind: 'person',
  firstName: 'Paul',
  lastName: 'Martin',
  organization: '',
  role: 'Medecin traitant',
  email: 'paul.martin@example.com',
  mobilePhone: '0601020304',
  landlinePhone: '',
  address1: '20 avenue de la Gare',
  address2: '',
  postalCode: '44000',
  city: 'Nantes',
  country: 'France',
  notes: 'Correspondant principal'
};

const DATA_IMPORT_CONSULTATION_SAMPLE = {
  patientLastName: 'Durand',
  patientFirstName: 'Marie',
  patientBirthDate: '1990-05-14',
  startedAt: '2026-04-22T09:30:00.000Z',
  practitioner: 'Dr Lucas',
  title: 'Consultation de suivi',
  profile: 'Adulte',
  important: 'false',
  heightCm: '168',
  weightKg: '62',
  evaBefore: '6',
  evaAfter: '2',
  motifMainHtml: 'Lombalgie persistante',
  testsHtml: '',
  schemaHtml: '',
  treatmentsHtml: '',
  remarksHtml: 'Bonne evolution'
};

const dataImportPayloadSchema = z.object({
  officeId: z.number().int().positive(),
  format: z.enum(['csv', 'xlsx']),
  dataset: z.enum(['patients', 'directory-contacts', 'mixed']),
  fileName: z.string().trim().min(1).max(260),
  contentBase64: z.string().trim().min(1).max(60_000_000)
});

const DATA_IMPORT_ALLOWED_EXTENSIONS = {
  csv: ['.csv'],
  xlsx: ['.xlsx', '.xlsm', '.xlsb', '.xls']
};

const DATA_IMPORT_ALLOWED_MIME_TYPES = {
  csv: new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel']),
  xlsx: new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    'application/vnd.ms-excel'
  ])
};

function sanitizeSpreadsheetCellValue(value) {
  const raw = String(value ?? '');
  return /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
}

function serializeCsvCell(value, separator = ';') {
  const safe = sanitizeSpreadsheetCellValue(value);
  if (safe.includes(separator) || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function sanitizeSpreadsheetRecord(record, headers) {
  return headers.reduce((result, header) => {
    result[header] = sanitizeSpreadsheetCellValue(record?.[header]);
    return result;
  }, {});
}

function extractDataUrlMimeType(contentBase64) {
  const value = String(contentBase64 ?? '').trim();
  const match = value.match(/^data:([^;,\s]+)(?:;[^,]*)?,/i);
  if (!match) {
    return '';
  }
  return String(match[1] ?? '').trim().toLowerCase();
}

function validateDataImportFileMetadata(format, fileName, contentBase64) {
  const normalizedFormat = String(format ?? '').trim().toLowerCase();
  const extension = path.extname(String(fileName ?? '').trim().toLowerCase());
  const allowedExtensions = DATA_IMPORT_ALLOWED_EXTENSIONS[normalizedFormat] ?? [];
  if (!allowedExtensions.includes(extension)) {
    return `Extension de fichier invalide pour le format ${normalizedFormat.toUpperCase()}`;
  }

  const mimeType = extractDataUrlMimeType(contentBase64);
  if (!mimeType) {
    return null;
  }

  const allowedMimeTypes = DATA_IMPORT_ALLOWED_MIME_TYPES[normalizedFormat];
  if (!allowedMimeTypes || !allowedMimeTypes.has(mimeType)) {
    return `Type MIME invalide pour le format ${normalizedFormat.toUpperCase()}`;
  }

  return null;
}

function normalizeDataImportFieldName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function getDataImportFieldValue(row, aliases) {
  if (!row || typeof row !== 'object') {
    return '';
  }

  const byNormalizedKey = new Map(
    Object.entries(row).map(([key, value]) => [normalizeDataImportFieldName(key), String(value ?? '').trim()])
  );

  for (const alias of aliases) {
    const value = byNormalizedKey.get(normalizeDataImportFieldName(alias));
    if (typeof value === 'string') {
      return value;
    }
  }

  return '';
}

function isDataImportRowEmpty(row) {
  return Object.values(row ?? {}).every((value) => String(value ?? '').trim() === '');
}

const ALLOWED_IMPORT_MIME_TYPES = new Map([
  ['csv', new Set(['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'])],
  ['xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream'])]
]);

async function validateImportFileType(buffer, format, fileName) {
  const lowerName = String(fileName ?? '').toLowerCase();
  if (format === 'csv' && !lowerName.endsWith('.csv')) {
    throw Object.assign(new Error('Le fichier doit avoir l\'extension .csv pour ce format'), { statusCode: 400 });
  }
  if (format === 'xlsx' && !lowerName.endsWith('.xlsx')) {
    throw Object.assign(new Error('Le fichier doit avoir l\'extension .xlsx pour ce format'), { statusCode: 400 });
  }

  if (format === 'xlsx') {
    const detected = await fileTypeFromBuffer(buffer);
    const actualMime = detected?.mime ?? null;
    if (actualMime === null || !ALLOWED_IMPORT_MIME_TYPES.get('xlsx').has(actualMime)) {
      throw Object.assign(new Error(`Type de fichier non autorisé: ${actualMime ?? 'inconnu'}`), { statusCode: 415 });
    }
  }
}

function parseDataImportWorkbook(buffer, format) {
  if (format === 'csv') {
    const csvText = buffer.toString('utf8');
    return XLSX.read(csvText, { type: 'string', raw: false });
  }

  return XLSX.read(buffer, { type: 'buffer', raw: false });
}

function getDataImportSheetRows(workbook, sheetName) {
  const actualName = workbook.SheetNames.find((name) => name.toLowerCase() === sheetName.toLowerCase());
  if (!actualName) {
    return [];
  }

  const sheet = workbook.Sheets[actualName];
  if (!sheet) {
    return [];
  }

  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

function getDataImportRows(workbook, dataset) {
  if (dataset === 'patients') {
    const patientRows = getDataImportSheetRows(workbook, DATA_IMPORT_PATIENTS_SHEET);
    const consultationRows = getDataImportSheetRows(workbook, DATA_IMPORT_CONSULTATIONS_SHEET);
    if (patientRows.length > 0) {
      return { patientRows, contactRows: [], consultationRows };
    }

    const fallback = workbook.SheetNames[0] ? XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '', raw: false }) : [];
    return { patientRows: fallback, contactRows: [], consultationRows };
  }

  if (dataset === 'directory-contacts') {
    const contactRows = getDataImportSheetRows(workbook, DATA_IMPORT_CONTACTS_SHEET);
    if (contactRows.length > 0) {
      return { patientRows: [], contactRows, consultationRows: [] };
    }

    const fallback = workbook.SheetNames[0] ? XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '', raw: false }) : [];
    return { patientRows: [], contactRows: fallback, consultationRows: [] };
  }

  return {
    patientRows: getDataImportSheetRows(workbook, DATA_IMPORT_PATIENTS_SHEET),
    contactRows: getDataImportSheetRows(workbook, DATA_IMPORT_CONTACTS_SHEET),
    consultationRows: getDataImportSheetRows(workbook, DATA_IMPORT_CONSULTATIONS_SHEET)
  };
}

function buildDataImportTemplateCsv(dataset) {
  if (dataset === 'directory-contacts') {
    return `${DATA_IMPORT_CONTACT_HEADERS.join(',')}\n${DATA_IMPORT_CONTACT_HEADERS.map((header) => serializeCsvCell(DATA_IMPORT_CONTACT_SAMPLE[header], ',')).join(',')}\n`;
  }

  return `${DATA_IMPORT_PATIENT_HEADERS.join(',')}\n${DATA_IMPORT_PATIENT_HEADERS.map((header) => serializeCsvCell(DATA_IMPORT_PATIENT_SAMPLE[header], ',')).join(',')}\n`;
}

function buildDataImportTemplateWorkbook(dataset) {
  const workbook = XLSX.utils.book_new();

  if (dataset !== 'directory-contacts') {
    const patientSheet = XLSX.utils.json_to_sheet([sanitizeSpreadsheetRecord(DATA_IMPORT_PATIENT_SAMPLE, DATA_IMPORT_PATIENT_HEADERS)], {
      header: DATA_IMPORT_PATIENT_HEADERS,
      skipHeader: false
    });
    XLSX.utils.book_append_sheet(workbook, patientSheet, DATA_IMPORT_PATIENTS_SHEET);

    const consultationSheet = XLSX.utils.json_to_sheet([sanitizeSpreadsheetRecord(DATA_IMPORT_CONSULTATION_SAMPLE, DATA_IMPORT_CONSULTATION_HEADERS)], {
      header: DATA_IMPORT_CONSULTATION_HEADERS,
      skipHeader: false
    });
    XLSX.utils.book_append_sheet(workbook, consultationSheet, DATA_IMPORT_CONSULTATIONS_SHEET);
  }

  if (dataset !== 'patients') {
    const contactSheet = XLSX.utils.json_to_sheet([sanitizeSpreadsheetRecord(DATA_IMPORT_CONTACT_SAMPLE, DATA_IMPORT_CONTACT_HEADERS)], {
      header: DATA_IMPORT_CONTACT_HEADERS,
      skipHeader: false
    });
    XLSX.utils.book_append_sheet(workbook, contactSheet, DATA_IMPORT_CONTACTS_SHEET);
  }

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function buildDataImportPatientKey(lastName, firstName, birthDate) {
  return [
    String(lastName ?? '').trim().toLowerCase(),
    String(firstName ?? '').trim().toLowerCase(),
    String(birthDate ?? '').trim()
  ].join('|');
}

function parseImportedNullableNumber(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    return null;
  }

  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseImportedBoundedInt(rawValue, min, max, fallback) {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  if (parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

function normalizeImportedBoolean(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'oui' || value === 'yes';
}

function normalizeImportedSex(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (value === 'f' || value === 'femme' || value === 'female') {
    return 'Femme';
  }
  if (value === 'm' || value === 'homme' || value === 'male') {
    return 'Homme';
  }
  return 'Non renseigne';
}

function normalizeImportedMaritalStatus(rawValue) {
  const value = String(rawValue ?? '').trim();
  const accepted = ['Non renseigne', 'Celibataire', 'Marie(e)', 'Pacse(e)', 'Divorce(e)', 'Veuf(ve)'];
  return accepted.includes(value) ? value : 'Non renseigne';
}

function normalizeImportedManualPreference(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (value === 'droitier') {
    return 'Droitier';
  }
  if (value === 'gaucher') {
    return 'Gaucher';
  }
  return 'Non renseigne';
}

const DATA_CLEANUP_KINDS = new Set(['cities', 'banks', 'referred-by', 'primary-doctors']);

function normalizeCleanupKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function titleCaseCleanupValue(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b\p{L}/gu, (char) => char.toUpperCase());
}

function getDataCleanupItems(kind, allowedOfficeIds = []) {
  const normalizedKind = String(kind ?? '').trim();
  if (!DATA_CLEANUP_KINDS.has(normalizedKind)) {
    return [];
  }

  const scopedOfficeIds = [...new Set((Array.isArray(allowedOfficeIds) ? allowedOfficeIds : [])
    .map((officeId) => Number(officeId))
    .filter((officeId) => Number.isInteger(officeId) && officeId > 0))];
  if (scopedOfficeIds.length === 0) {
    return [];
  }

  const placeholders = scopedOfficeIds.map(() => '?').join(', ');

  if (normalizedKind === 'cities') {
    const rows = db
      .prepare(`SELECT cipher_medical_notes FROM patients WHERE is_deleted = 0 AND office_id IN (${placeholders})`)
      .all(...scopedOfficeIds);
    const grouped = new Map();

    for (const row of rows) {
      const notes = parsePatientNotesFromCipher(row.cipher_medical_notes);
      const city = String(notes.city ?? '').trim();
      const postalCode = String(notes.postalCode ?? '').trim();
      if (!city && !postalCode) {
        continue;
      }

      const key = `${normalizeCleanupKey(city)}|${normalizeCleanupKey(postalCode)}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.set(key, {
          key,
          count: 1,
          value: city,
          postalCode
        });
      }
    }

    return Array.from(grouped.values())
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'fr', { sensitivity: 'base' }));
  }

  if (normalizedKind === 'banks') {
    const grouped = new Map();
    const sources = [
      db
        .prepare(
          `SELECT u.bank_name_cipher AS value
           FROM users u
           WHERE u.bank_name_cipher <> ''
             AND (
               u.office_id IN (${placeholders})
               OR EXISTS (SELECT 1 FROM user_offices uo WHERE uo.user_id = u.id AND uo.office_id IN (${placeholders}))
             )`
        )
        .all(...scopedOfficeIds, ...scopedOfficeIds),
      db
        .prepare(
          `SELECT ip.bank_name_cipher AS value
           FROM invoice_payments ip
           INNER JOIN invoices i ON i.id = ip.invoice_id
           INNER JOIN patients p ON p.id = i.patient_id
           WHERE ip.bank_name_cipher <> ''
             AND p.office_id IN (${placeholders})`
        )
        .all(...scopedOfficeIds),
      db
        .prepare(
          `SELECT bank_name_cipher AS value
           FROM accounting_deposits
           WHERE bank_name_cipher <> ''
             AND office_id IN (${placeholders})`
        )
        .all(...scopedOfficeIds)
    ];

    for (const sourceRows of sources) {
      for (const row of sourceRows) {
        const value = safeDecryptField(String(row.value ?? '')).trim();
        if (!value) {
          continue;
        }
        const key = normalizeCleanupKey(value);
        const existing = grouped.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          grouped.set(key, { key, count: 1, value });
        }
      }
    }

    return Array.from(grouped.values())
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'fr', { sensitivity: 'base' }));
  }

  const notesRows = db
    .prepare(`SELECT cipher_medical_notes FROM patients WHERE is_deleted = 0 AND office_id IN (${placeholders})`)
    .all(...scopedOfficeIds);
  const grouped = new Map();
  const noteKey = normalizedKind === 'primary-doctors' ? 'primaryDoctor' : 'referredBy';

  for (const row of notesRows) {
    const notes = parsePatientNotesFromCipher(row.cipher_medical_notes);
    const value = String(notes[noteKey] ?? '').trim();
    if (!value) {
      continue;
    }
    const key = normalizeCleanupKey(value);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { key, count: 1, value });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'fr', { sensitivity: 'base' }));
}

function applyDataCleanupChanges(kind, rawChanges, allowedOfficeIds = [], actorUserId = null) {
  const normalizedKind = String(kind ?? '').trim();
  if (!DATA_CLEANUP_KINDS.has(normalizedKind) || !Array.isArray(rawChanges)) {
    return 0;
  }

  const scopedOfficeIds = [...new Set((Array.isArray(allowedOfficeIds) ? allowedOfficeIds : [])
    .map((officeId) => Number(officeId))
    .filter((officeId) => Number.isInteger(officeId) && officeId > 0))];
  if (scopedOfficeIds.length === 0) {
    return 0;
  }

  const placeholders = scopedOfficeIds.map(() => '?').join(', ');

  const changes = rawChanges
    .map((item) => ({
      sourceValue: String(item?.sourceValue ?? '').trim(),
      replacementValue: String(item?.replacementValue ?? '').trim(),
      sourcePostalCode: String(item?.sourcePostalCode ?? '').trim(),
      replacementPostalCode: String(item?.replacementPostalCode ?? '').trim()
    }))
    .filter((item) => item.sourceValue.length > 0 && item.replacementValue.length > 0);

  if (changes.length === 0) {
    return 0;
  }

  let updatedCount = 0;

  if (normalizedKind === 'banks') {
    const scopedUsers = db.prepare(
      `SELECT id, bank_name_cipher FROM users
       WHERE (
         office_id IN (${placeholders})
         OR EXISTS (SELECT 1 FROM user_offices uo WHERE uo.user_id = users.id AND uo.office_id IN (${placeholders}))
       )`
    ).all(...scopedOfficeIds, ...scopedOfficeIds);

    const scopedPayments = db.prepare(
      `SELECT ip.id, ip.bank_name_cipher
       FROM invoice_payments ip
       INNER JOIN invoices i ON i.id = ip.invoice_id
       INNER JOIN patients p ON p.id = i.patient_id
       WHERE ip.bank_name_cipher <> ''
         AND p.office_id IN (${placeholders})`
    ).all(...scopedOfficeIds);

    const scopedDeposits = db.prepare(
      `SELECT id, bank_name_cipher FROM accounting_deposits
       WHERE bank_name_cipher <> ''
         AND office_id IN (${placeholders})`
    ).all(...scopedOfficeIds);

    const updateUserBank = db.prepare(`UPDATE users SET bank_name_cipher = ? WHERE id = ?`);
    const updatePaymentBank = db.prepare(`UPDATE invoice_payments SET bank_name_cipher = ? WHERE id = ?`);
    const updateDepositBank = db.prepare(`UPDATE accounting_deposits SET bank_name_cipher = ? WHERE id = ?`);

    for (const change of changes) {
      const sourceKey = change.sourceValue.toLowerCase().trim();
      for (const user of scopedUsers) {
        if (safeDecryptField(user.bank_name_cipher).toLowerCase().trim() === sourceKey) {
          updateUserBank.run(encryptSensitiveField(change.replacementValue), user.id);
          updatedCount += 1;
        }
      }
      for (const payment of scopedPayments) {
        if (safeDecryptField(payment.bank_name_cipher).toLowerCase().trim() === sourceKey) {
          updatePaymentBank.run(encryptSensitiveField(change.replacementValue), payment.id);
          updatedCount += 1;
        }
      }
      for (const deposit of scopedDeposits) {
        if (safeDecryptField(deposit.bank_name_cipher).toLowerCase().trim() === sourceKey) {
          updateDepositBank.run(encryptSensitiveField(change.replacementValue), deposit.id);
          updatedCount += 1;
        }
      }
    }
  } else {
    const noteKey = normalizedKind === 'cities'
      ? 'city'
      : (normalizedKind === 'primary-doctors' ? 'primaryDoctor' : 'referredBy');

    const rows = db
      .prepare(`SELECT id, cipher_medical_notes FROM patients WHERE is_deleted = 0 AND office_id IN (${placeholders})`)
      .all(...scopedOfficeIds);
    const updateNotes = db.prepare(
      `UPDATE patients
       SET cipher_medical_notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );

    for (const row of rows) {
      const notes = parsePatientNotesFromCipher(row.cipher_medical_notes);
      const currentValue = String(notes[noteKey] ?? '').trim();
      if (!currentValue) {
        continue;
      }

      let matched = null;
      for (const change of changes) {
        if (normalizeCleanupKey(currentValue) !== normalizeCleanupKey(change.sourceValue)) {
          continue;
        }

        if (normalizedKind === 'cities') {
          const currentPostalCode = String(notes.postalCode ?? '').trim();
          if (normalizeCleanupKey(currentPostalCode) !== normalizeCleanupKey(change.sourcePostalCode)) {
            continue;
          }
        }

        matched = change;
        break;
      }

      if (!matched) {
        continue;
      }

      const nextNotes = {
        ...notes,
        [noteKey]: matched.replacementValue
      };

      if (normalizedKind === 'cities' && matched.replacementPostalCode) {
        nextNotes.postalCode = matched.replacementPostalCode;
      }

      updateNotes.run(encryptSensitiveField(JSON.stringify(nextNotes)), Number(row.id));
      updatedCount += 1;
    }
  }

  if (updatedCount > 0) {
    const normalizedActorUserId = Number(actorUserId);
    const auditUserId = Number.isInteger(normalizedActorUserId) && normalizedActorUserId > 0
      ? normalizedActorUserId
      : null;

    writeAuditLog(auditUserId, 'UPDATE', 'data-cleanup', normalizedKind, {
      kind: normalizedKind,
      changedItems: changes.length,
      updatedCount
    });
  }

  return updatedCount;
}

app.get('/api/data-management/cleanup', authMiddleware, requirePermission('manage-data-cleanup'), (req, res) => {
  const kind = String(req.query.kind ?? '').trim();
  if (!DATA_CLEANUP_KINDS.has(kind)) {
    return res.status(400).json({ message: 'Type de nettoyage invalide' });
  }

  const allowedOfficeIds = getDataManagementScopedOfficeIds(req.userAccess);
  const items = getDataCleanupItems(kind, allowedOfficeIds);
  return res.json({ kind, items });
});

app.post('/api/data-management/cleanup/apply', authMiddleware, requirePermission('manage-data-cleanup'), (req, res) => {
  const kind = String(req.body?.kind ?? '').trim();
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];

  if (!DATA_CLEANUP_KINDS.has(kind)) {
    return res.status(400).json({ message: 'Type de nettoyage invalide' });
  }

  const allowedOfficeIds = getDataManagementScopedOfficeIds(req.userAccess);
  const updatedCount = applyDataCleanupChanges(kind, changes, allowedOfficeIds, req.user.sub);
  return res.json({ kind, updatedCount });
});

app.get('/api/data-management/retention-status', authMiddleware, requirePermission('manage-data-rgpd'), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = db.prepare(
    `SELECT id, retention_until
     FROM patients
     WHERE is_deleted = 0
       AND retention_until IS NOT NULL
       AND retention_until <= ?
     ORDER BY retention_until ASC`
  ).all(in30Days);

  const expiringSoon = rows.map((row) => ({
    id: row.id,
    retentionUntil: row.retention_until,
    isExpired: row.retention_until < today
  }));

  writeAuditLog(req.user.sub, 'READ_LIST', 'data-management-retention', null, { count: expiringSoon.length });
  return res.json({ expiringSoon });
});

app.get('/api/data-management/consent-status', authMiddleware, requirePermission('manage-data-rgpd'), (req, res) => {
  const rows = db.prepare(
    `SELECT id
     FROM patients
     WHERE is_deleted = 0
       AND consent_signed = 1
       AND consent_withdrawn_at IS NULL
       AND consent_form_version != ?
     ORDER BY id ASC`
  ).all(CURRENT_CONSENT_FORM_VERSION);

  const outdated = rows.map((row) => ({ id: row.id }));

  writeAuditLog(req.user.sub, 'READ_LIST', 'data-management-consent', null, { count: outdated.length, currentVersion: CURRENT_CONSENT_FORM_VERSION });
  return res.json({ outdated, currentVersion: CURRENT_CONSENT_FORM_VERSION });
});

app.get('/api/data-management/import-template', authMiddleware, requirePermission('manage-data-import'), (req, res) => {
  const format = String(req.query.format ?? 'csv').trim().toLowerCase();
  const dataset = String(req.query.dataset ?? 'patients').trim().toLowerCase();

  if (!['csv', 'xlsx'].includes(format)) {
    return res.status(400).json({ message: 'Format de template invalide' });
  }

  if (!['patients', 'directory-contacts', 'mixed'].includes(dataset)) {
    return res.status(400).json({ message: 'Jeu de donnees invalide' });
  }

  if (format === 'csv' && dataset === 'mixed') {
    return res.status(400).json({ message: 'Le mode mixte requiert un template XLSX multi-feuilles' });
  }

  if (format === 'csv') {
    const csvContent = buildDataImportTemplateCsv(dataset);
    const fileName = `osteosoft-template-${dataset}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(`\uFEFF${csvContent}`);
  }

  const workbookBuffer = buildDataImportTemplateWorkbook(dataset);
  const fileName = `osteosoft-template-${dataset}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(workbookBuffer);
});

app.post('/api/data-management/import', authMiddleware, requirePermission('manage-data-import'), async (req, res) => {
  const parsed = dataImportPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload d\'import invalide' });
  }

  const payload = parsed.data;
  const metadataValidationError = validateDataImportFileMetadata(payload.format, payload.fileName, payload.contentBase64);
  if (metadataValidationError) {
    return res.status(400).json({ message: metadataValidationError });
  }

  const allowedOfficeIds = new Set(getDataManagementScopedOfficeIds(req.userAccess));

  if (!allowedOfficeIds.has(payload.officeId)) {
    return res.status(403).json({ message: 'Acces refuse au cabinet cible' });
  }

  const officeExists = db.prepare('SELECT id FROM offices WHERE id = ?').get(payload.officeId);
  if (!officeExists) {
    return res.status(404).json({ message: 'Cabinet cible introuvable' });
  }

  try {
    const normalizedBase64 = payload.contentBase64.includes(',')
      ? payload.contentBase64.slice(payload.contentBase64.indexOf(',') + 1)
      : payload.contentBase64;
    const fileBuffer = Buffer.from(normalizedBase64, 'base64');
    if (fileBuffer.length === 0) {
      return res.status(400).json({ message: 'Fichier importe vide ou invalide' });
    }
    await validateImportFileType(fileBuffer, payload.format, payload.fileName);
    const workbook = parseDataImportWorkbook(fileBuffer, payload.format);
    const { patientRows, contactRows, consultationRows } = getDataImportRows(workbook, payload.dataset);

    const errors = [];
    let importedPatients = 0;
    let importedContacts = 0;
    let importedConsultations = 0;
    let skippedRows = 0;
    const importedPatientIdByKey = new Map();

    for (let index = 0; index < patientRows.length; index += 1) {
      const row = patientRows[index];
      const rowLabel = `Patients ligne ${index + 2}`;

      if (isDataImportRowEmpty(row)) {
        skippedRows += 1;
        continue;
      }

      const patientPayload = {
        sex: normalizeImportedSex(getDataImportFieldValue(row, ['sex', 'sexe'])),
        lastName: getDataImportFieldValue(row, ['lastName', 'lastname', 'nom']),
        firstName: getDataImportFieldValue(row, ['firstName', 'firstname', 'prenom']),
        birthDate: getDataImportFieldValue(row, ['birthDate', 'dateNaissance', 'datenaissance']),
        mobilePhone: getDataImportFieldValue(row, ['mobilePhone', 'telephonePortable', 'portable']),
        landlinePhone: getDataImportFieldValue(row, ['landlinePhone', 'telephoneFixe', 'fixe']),
        email: getDataImportFieldValue(row, ['email']),
        address1: getDataImportFieldValue(row, ['address1', 'adresse1']),
        address2: getDataImportFieldValue(row, ['address2', 'adresse2']),
        postalCode: getDataImportFieldValue(row, ['postalCode', 'codePostal']),
        city: getDataImportFieldValue(row, ['city', 'ville']),
        country: getDataImportFieldValue(row, ['country', 'pays']) || 'France',
        maritalStatus: normalizeImportedMaritalStatus(getDataImportFieldValue(row, ['maritalStatus', 'situationMatrimoniale'])),
        childrenCount: Number(getDataImportFieldValue(row, ['childrenCount', 'nombreEnfants']) || 0),
        occupationOrSchool: getDataImportFieldValue(row, ['occupationOrSchool', 'profession']),
        hobbies: getDataImportFieldValue(row, ['hobbies', 'loisirs']),
        primaryDoctor: getDataImportFieldValue(row, ['primaryDoctor', 'medecinTraitant']),
        socialSecurityNumber: getDataImportFieldValue(row, ['socialSecurityNumber', 'numeroSecuriteSociale']),
        referredBy: getDataImportFieldValue(row, ['referredBy', 'adressePar', 'orientePar']),
        manualPreference: normalizeImportedManualPreference(getDataImportFieldValue(row, ['manualPreference', 'lateralite'])),
        generalRemarks: getDataImportFieldValue(row, ['generalRemarks', 'remarques']),
        relatedPeople: getDataImportFieldValue(row, ['relatedPeople', 'personnesLiees']),
        isDeceased: normalizeImportedBoolean(getDataImportFieldValue(row, ['isDeceased', 'decede'])),
        medicalHistory: getDataImportFieldValue(row, ['medicalHistory', 'antecedents']),
        consultationNote: '',
        consultationDocuments: []
      };

      const validated = createPatientSchema.safeParse(patientPayload);
      if (!validated.success) {
        errors.push({ row: rowLabel, message: validated.error.issues[0]?.message ?? 'Donnees patient invalides' });
        skippedRows += 1;
        continue;
      }

      try {
        const patient = validated.data;
        const lastName = patient.lastName.trim();
        const firstName = patient.firstName.trim();
        const fullName = `${lastName} ${firstName}`.trim();
        const mobilePhone = patient.mobilePhone.trim();
        const landlinePhone = patient.landlinePhone.trim();
        const mainPhone = mobilePhone || landlinePhone || 'Non renseigne';

        const retentionDate = new Date();
        retentionDate.setFullYear(retentionDate.getFullYear() + 10);
        const retentionUntil = retentionDate.toISOString().slice(0, 10);
        const normalizedRelatedPeople = formatRelatedPeople(parseRelatedPeople(patient.relatedPeople));

        const medicalRecord = {
          generalRemarks: patient.generalRemarks.trim(),
          medicalHistory: patient.medicalHistory.trim(),
          consultationNote: '',
          relatedPeople: normalizedRelatedPeople,
          mobilePhone,
          landlinePhone,
          email: patient.email.trim(),
          address1: patient.address1.trim(),
          address2: patient.address2.trim(),
          postalCode: patient.postalCode.trim(),
          city: patient.city.trim(),
          country: patient.country.trim() || 'France',
          maritalStatus: patient.maritalStatus,
          childrenCount: patient.childrenCount,
          occupationOrSchool: patient.occupationOrSchool.trim(),
          hobbies: patient.hobbies.trim(),
          primaryDoctor: patient.primaryDoctor.trim(),
          socialSecurityNumber: patient.socialSecurityNumber.trim(),
          referredBy: patient.referredBy.trim(),
          manualPreference: normalizeManualPreference(patient.manualPreference),
          isDeceased: Boolean(patient.isDeceased)
        };

        const birthDate = patient.birthDate.trim();
        const inserted = db
          .prepare(
            `INSERT INTO patients
             (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, marital_status, children_count, last_visit, consent_signed, consent_signed_at, consent_form_version, retention_until, office_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            encryptSensitiveField(fullName),
            encryptSensitiveField(mainPhone),
            encryptSensitiveField(JSON.stringify(medicalRecord)),
            patient.sex === 'Femme' ? 'F' : patient.sex === 'Homme' ? 'M' : 'Non renseigne',
            birthDate || null,
            patient.maritalStatus,
            patient.childrenCount,
            null,
            1,
            new Date().toISOString(),
            CURRENT_CONSENT_FORM_VERSION,
            retentionUntil,
            payload.officeId
          );

        importedPatientIdByKey.set(
          buildDataImportPatientKey(lastName, firstName, birthDate || ''),
          Number(inserted.lastInsertRowid)
        );

        storeAntecedentTypes(extractAntecedentCategories(patient.medicalHistory));
        replacePatientAntecedents(Number(inserted.lastInsertRowid), patient.medicalHistory);
        importedPatients += 1;
      } catch (error) {
        errors.push({ row: rowLabel, message: error instanceof Error ? error.message : 'Echec insertion patient' });
        skippedRows += 1;
      }
    }

    const consultationPatientLookup = new Map(importedPatientIdByKey);
    if (consultationRows.length > 0) {
      const patientRowsForOffice = db
        .prepare(
          `SELECT id, cipher_full_name, birth_date
           FROM patients
           WHERE is_deleted = 0
             AND office_id = ?`
        )
        .all(payload.officeId);

      for (const patientRow of patientRowsForOffice) {
        const fullName = decryptSensitiveField(patientRow.cipher_full_name);
        const parts = fullName.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          continue;
        }

        const lastName = parts[0] ?? '';
        const firstName = parts.slice(1).join(' ');
        const key = buildDataImportPatientKey(lastName, firstName, String(patientRow.birth_date ?? ''));
        if (!consultationPatientLookup.has(key)) {
          consultationPatientLookup.set(key, Number(patientRow.id));
        }
      }
    }

    for (let index = 0; index < consultationRows.length; index += 1) {
      const row = consultationRows[index];
      const rowLabel = `Consultations ligne ${index + 2}`;

      if (isDataImportRowEmpty(row)) {
        skippedRows += 1;
        continue;
      }

      const patientLastName = getDataImportFieldValue(row, ['patientLastName', 'nomPatient', 'patientNom']);
      const patientFirstName = getDataImportFieldValue(row, ['patientFirstName', 'prenomPatient', 'patientPrenom']);
      const patientBirthDate = getDataImportFieldValue(row, ['patientBirthDate', 'dateNaissancePatient']);
      const startedAt = getDataImportFieldValue(row, ['startedAt', 'dateHeure', 'dateConsultation']);

      if (!patientLastName || !patientFirstName || !startedAt) {
        errors.push({ row: rowLabel, message: 'patientLastName, patientFirstName et startedAt sont obligatoires' });
        skippedRows += 1;
        continue;
      }

      const patientKey = buildDataImportPatientKey(patientLastName, patientFirstName, patientBirthDate);
      const patientId = consultationPatientLookup.get(patientKey);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        errors.push({ row: rowLabel, message: 'Patient introuvable pour la consultation (nom/prenom/date de naissance)' });
        skippedRows += 1;
        continue;
      }

      const payloadConsultation = {
        startedAt,
        officeId: payload.officeId,
        practitioner: getDataImportFieldValue(row, ['practitioner', 'praticien']),
        title: getDataImportFieldValue(row, ['title', 'titre']),
        important: normalizeImportedBoolean(getDataImportFieldValue(row, ['important', 'importantFlag'])),
        heightCm: parseImportedNullableNumber(getDataImportFieldValue(row, ['heightCm', 'tailleCm'])),
        weightKg: parseImportedNullableNumber(getDataImportFieldValue(row, ['weightKg', 'poidsKg'])),
        evaBefore: parseImportedBoundedInt(getDataImportFieldValue(row, ['evaBefore', 'evaAvant']), 0, 10, 0),
        evaAfter: parseImportedBoundedInt(getDataImportFieldValue(row, ['evaAfter', 'evaApres']), 0, 10, 0),
        profile: getDataImportFieldValue(row, ['profile', 'profil']) || 'Adulte',
        reasonItems: [],
        motifMainHtml: getDataImportFieldValue(row, ['motifMainHtml', 'motif']),
        testsHtml: getDataImportFieldValue(row, ['testsHtml', 'tests']),
        schemaHtml: getDataImportFieldValue(row, ['schemaHtml', 'schema']),
        treatmentsHtml: getDataImportFieldValue(row, ['treatmentsHtml', 'traitements']),
        remarksHtml: getDataImportFieldValue(row, ['remarksHtml', 'remarques']),
        consultationDocuments: []
      };

      const validatedConsultation = createPatientConsultationSchema.safeParse(payloadConsultation);
      if (!validatedConsultation.success) {
        errors.push({ row: rowLabel, message: validatedConsultation.error.issues[0]?.message ?? 'Donnees consultation invalides' });
        skippedRows += 1;
        continue;
      }

      try {
        const consultation = validatedConsultation.data;
        const normalizedReasonItems = normalizeConsultationReasonItems(consultation.reasonItems);

        const inserted = db.prepare(
          `INSERT INTO consultations
            (patient_id, started_at, office_id, practitioner, title, important,
             height_cm, weight_kg, eva_before, eva_after, profile)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          consultation.startedAt,
          payload.officeId,
          consultation.practitioner.trim(),
          consultation.title.trim(),
          consultation.important ? 1 : 0,
          consultation.heightCm,
          consultation.weightKg,
          consultation.evaBefore,
          consultation.evaAfter,
          consultation.profile.trim() || 'Adulte'
        );

        const consultationId = Number(inserted.lastInsertRowid);
        replaceConsultationReasonItems(consultationId, normalizedReasonItems);
        replaceConsultationSections(consultationId, {
          motifMainHtml: consultation.motifMainHtml,
          testsHtml: consultation.testsHtml,
          schemaHtml: consultation.schemaHtml,
          treatmentsHtml: consultation.treatmentsHtml,
          remarksHtml: consultation.remarksHtml
        });

        importedConsultations += 1;
      } catch (error) {
        errors.push({ row: rowLabel, message: error instanceof Error ? error.message : 'Echec insertion consultation' });
        skippedRows += 1;
      }
    }

    for (let index = 0; index < contactRows.length; index += 1) {
      const row = contactRows[index];
      const rowLabel = `Contacts ligne ${index + 2}`;

      if (isDataImportRowEmpty(row)) {
        skippedRows += 1;
        continue;
      }

      const firstName = getDataImportFieldValue(row, ['firstName', 'firstname', 'prenom']);
      const lastName = getDataImportFieldValue(row, ['lastName', 'lastname', 'nom']);
      const organization = getDataImportFieldValue(row, ['organization', 'societe', 'organisation']);
      if (!firstName && !lastName && !organization) {
        errors.push({ row: rowLabel, message: 'Renseignez au moins un nom ou une organisation' });
        skippedRows += 1;
        continue;
      }

      const kindRaw = getDataImportFieldValue(row, ['kind', 'type']).toLowerCase();
      const kind = kindRaw === 'company' || kindRaw === 'societe' ? 'company' : 'person';

      try {
        db
          .prepare(
            `INSERT INTO directory_contacts (
               office_id, kind, first_name, last_name, organization, role,
               email, mobile_phone, landline_phone,
               address_line1, address_line2, postal_code, city, country,
               notes, created_by, updated_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            payload.officeId,
            kind,
            firstName.slice(0, 120),
            lastName.slice(0, 120),
            organization.slice(0, 200),
            getDataImportFieldValue(row, ['role', 'fonction']).slice(0, 120),
            getDataImportFieldValue(row, ['email']).slice(0, 160),
            getDataImportFieldValue(row, ['mobilePhone', 'telephonePortable', 'portable']).slice(0, 50),
            getDataImportFieldValue(row, ['landlinePhone', 'telephoneFixe', 'fixe']).slice(0, 50),
            getDataImportFieldValue(row, ['address1', 'adresse1']).slice(0, 200),
            getDataImportFieldValue(row, ['address2', 'adresse2']).slice(0, 200),
            getDataImportFieldValue(row, ['postalCode', 'codePostal']).slice(0, 20),
            getDataImportFieldValue(row, ['city', 'ville']).slice(0, 120),
            (getDataImportFieldValue(row, ['country', 'pays']) || 'France').slice(0, 80),
            getDataImportFieldValue(row, ['notes', 'commentaires']).slice(0, 4000),
            req.user.sub,
            req.user.sub
          );
        importedContacts += 1;
      } catch (error) {
        errors.push({ row: rowLabel, message: error instanceof Error ? error.message : 'Echec insertion contact' });
        skippedRows += 1;
      }
    }

    writeAuditLog(req.user.sub, 'IMPORT', 'data-management', String(payload.officeId), {
      dataset: payload.dataset,
      format: payload.format,
      importedPatients,
      importedContacts,
      importedConsultations,
      skippedRows,
      errorCount: errors.length
    });

    return res.json({
      importedPatients,
      importedContacts,
      importedConsultations,
      skippedRows,
      errorCount: errors.length,
      errors: errors.slice(0, 100)
    });
  } catch (error) {
    const statusCode = error?.statusCode ?? 400;
    const message = error instanceof Error ? error.message : 'Impossible de traiter le fichier d\'import';
    return res.status(statusCode).json({ message });
  }
});

app.get('/api/data-management/backup', authMiddleware, requirePermission('manage-data-backup-restore'), async (req, res) => {
  const scopedOfficeIds = getDataManagementScopedOfficeIds(req.userAccess);
  const snapshot = buildDataBackupSnapshot(
    isApplicationSuperAdmin(req.userAccess)
      ? {}
      : { officeIds: scopedOfficeIds }
  );
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `osteosoft-backup-${now}.zip`;

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(snapshot.manifest, null, 2));
  zip.file('data.json', JSON.stringify(snapshot.data, null, 2));
  zip.file('meta.json', JSON.stringify(snapshot.meta, null, 2));

  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(archive);
});

app.post('/api/setup/office', setupLimiter, setupBootstrapGuard, async (req, res) => {

  const {
    name,
    defaultSessionDurationMinutes,
    country,
    devise,
    invoiceNumberFormat,
    numberingConfiguration,
    alwaysShowSocialSecurityAndMutuelle,
    addressLine1,
    addressLine2,
    postalCode,
    city,
    phoneMobile,
    phoneLandline,
    phoneFax,
    email,
    website,
    logoData,
    openingHours,
    consultationProfiles,
    serviceTypes,
    paymentMethods,
    adminPassword,
    encryptionKey
  } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: 'Le nom du cabinet est obligatoire' });
  }

  if (!isStrongPassword(adminPassword)) {
    return res.status(400).json({
      message: 'Le mot de passe admin doit contenir au moins 12 caracteres, une majuscule, une minuscule, un chiffre et un caractere special.'
    });
  }

  if (!rawDataKey) {
    if (!encryptionKey || typeof encryptionKey !== 'string' || !encryptionKey.trim()) {
      return res.status(400).json({ message: 'La cle de chiffrement est obligatoire.' });
    }
    let keyBuffer;
    try {
      keyBuffer = Buffer.from(encryptionKey.trim(), 'base64');
    } catch {
      return res.status(400).json({ message: 'La cle de chiffrement doit etre encodee en base64.' });
    }
    if (keyBuffer.length !== 32) {
      return res.status(400).json({ message: 'La cle de chiffrement doit decoder en exactement 32 octets (base64 de 32 bytes).' });
    }
    dataKey = keyBuffer;
    try {
      updateEnvFile('OSTEOSOFT_DATA_KEY', encryptionKey.trim());
    } catch (envErr) {
      console.warn('Could not persist encryption key to .env file:', envErr.message);
    }
  }

  const normalizedOpeningHours = normalizeOfficeOpeningHours(openingHours);
  const normalizedDefaultSessionDurationMinutes = normalizeOfficeDefaultSessionDurationMinutes(defaultSessionDurationMinutes);
  const normalizedCountry = String(country ?? '').trim() || 'France';
  const normalizedDevise = normalizeOfficeDevise(devise);
  const normalizedInvoiceNumberFormat = normalizeOfficeInvoiceNumberFormat(invoiceNumberFormat);
  const normalizedInvoiceNumberingConfiguration = normalizeOfficeInvoiceNumberingConfiguration(numberingConfiguration);
  const normalizedInvoiceShowInsuranceFields = alwaysShowSocialSecurityAndMutuelle ? 1 : 0;
  const normalizedConsultationProfiles = normalizeOfficeConsultationProfiles(consultationProfiles);

  try {
    clearBusinessDataForInitialSetup();

    const insert = db.prepare(`
      INSERT INTO offices (name, default_session_duration_minutes, country, devise, invoice_number_format, invoice_numbering_configuration,
                           invoice_show_insurance_fields, invoice_hide_vat_mention, invoice_template_layout_json, address_line1, address_line2, postal_code, city, phone_mobile,
                           phone_landline, phone_fax, email, website, vat_number, logo_data, opening_hours_json,
                           consultation_profiles_json, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      name.trim(), normalizedDefaultSessionDurationMinutes, normalizedCountry, normalizedDevise,
      normalizedInvoiceNumberFormat, normalizedInvoiceNumberingConfiguration, normalizedInvoiceShowInsuranceFields, 0,
      '{}',
      addressLine1 || null, addressLine2 || null, postalCode || null, city || null,
      phoneMobile || null, phoneLandline || null, phoneFax || null, email || null,
      website || null, null, logoData || null, JSON.stringify(normalizedOpeningHours),
      JSON.stringify(normalizedConsultationProfiles), 1
    );

    const createdOfficeId = Number(result.lastInsertRowid);
    replaceOfficeBusinessSettings(createdOfficeId, serviceTypes, paymentMethods);
    createLocalCalendarFromOffice(createdOfficeId, name.trim());

    const adminPasswordHash = await argon2.hash(String(adminPassword).trim(), {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    const existingAdminUser = db.prepare("SELECT id FROM users WHERE lower(username) = 'admin' LIMIT 1").get();
    let adminUserId = Number(existingAdminUser?.id ?? 0);

    if (!Number.isInteger(adminUserId) || adminUserId <= 0) {
      const insertAdmin = db
        .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run('admin', adminPasswordHash, 'admin');
      adminUserId = Number(insertAdmin.lastInsertRowid);
    }

    db.prepare(
      `UPDATE users
       SET password_hash = ?,
           profile_id = ?,
           role = 'admin',
           is_active = 1,
           office_id = ?
       WHERE id = ?`
    ).run(adminPasswordHash, SUPER_ADMIN_PROFILE_ID, createdOfficeId, adminUserId);

    // Assign admin user to the new office
    const adminUser = db.prepare("SELECT id FROM users WHERE lower(username) = 'admin' LIMIT 1").get();
    if (adminUser) {
      db.prepare('INSERT OR IGNORE INTO user_offices (user_id, office_id) VALUES (?, ?)').run(adminUser.id, createdOfficeId);
    }

    return res.status(201).json({ officeId: createdOfficeId });
  } catch (err) {
    console.error('Error creating setup office:', err);
    return res.status(500).json({ message: 'Erreur lors de la creation du cabinet' });
  }
});

app.post('/api/setup/demo', setupLimiter, setupBootstrapGuard, async (_req, res) => {

  try {
    const result = await installDemoInstanceData();
    return res.status(201).json(result);
  } catch (err) {
    console.error('Error creating setup demo instance:', err);
    return res.status(500).json({ message: 'Erreur lors de la creation de l\'instance de demonstration' });
  }
});

app.post('/api/data-management/reset-demo', authMiddleware, adminOnlyMiddleware, async (_req, res) => {
  try {
    const result = await installDemoInstanceData();
    return res.status(201).json(result);
  } catch (err) {
    console.error('Error resetting demo instance:', err);
    return res.status(500).json({ message: 'Erreur lors de la reinitialisation de l\'instance de demonstration' });
  }
});

app.post('/api/data-management/restore', authMiddleware, requirePermission('manage-data-backup-restore'), async (req, res) => {
  if (!isApplicationSuperAdmin(req.userAccess)) {
    return res.status(403).json({
      message: 'Restauration globale reservee au super administrateur application. Utilisez un compte super administrateur application pour restaurer une sauvegarde complete.'
    });
  }

  const parsed = dataRestoreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Fichier de sauvegarde invalide' });
  }

  try {
    const usersInBackup = Array.isArray(parsed.data?.data?.users) ? parsed.data.data.users : [];
    const prehashedUserPasswords = new Map();
    const tempPasswords = [];

    for (const row of usersInBackup) {
      const userId = Number(row?.id);
      if (!Number.isInteger(userId) || userId <= 0) {
        continue;
      }
      const normalizedUsername = String(row?.username ?? '').trim();
      if (!normalizedUsername) {
        continue;
      }
      const tempPassword = crypto.randomBytes(8).toString('hex');
      const hash = await argon2.hash(tempPassword, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16,
        timeCost: 3,
        parallelism: 1
      });
      prehashedUserPasswords.set(userId, { hash, tempPassword });
      tempPasswords.push({ userId, username: normalizedUsername, tempPassword });
    }

    restoreDataBackupSnapshot(parsed.data, prehashedUserPasswords);
    return res.status(200).json({ tempPasswords });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'La restauration de la sauvegarde a echoue';
    return res.status(400).json({ message });
  }
});

app.post('/api/data-management/webosteo-import', authMiddleware, requirePermission('manage-data-import'), async (req, res) => {
  const parsedBody = z.object({
    officeId: z.number().int().positive(),
    contentBase64: z.string().min(1),
    fileName: z.string().min(1).max(260)
  }).safeParse(req.body);

  if (!parsedBody.success) {
    return res.status(400).json({ message: 'Payload d\'import WebOsteo invalide' });
  }

  const { officeId, contentBase64, fileName } = parsedBody.data;

  const allowedOfficeIds = new Set(getDataManagementScopedOfficeIds(req.userAccess));
  if (!allowedOfficeIds.has(officeId)) {
    return res.status(403).json({ message: 'Acces refuse au cabinet cible' });
  }

  const officeExists = db.prepare('SELECT id FROM offices WHERE id = ?').get(officeId);
  if (!officeExists) {
    return res.status(404).json({ message: 'Cabinet cible introuvable' });
  }

  const normalizedBase64 = contentBase64.includes(',')
    ? contentBase64.slice(contentBase64.indexOf(',') + 1)
    : contentBase64;
  const fileBuffer = Buffer.from(normalizedBase64, 'base64');
  if (fileBuffer.length === 0) {
    return res.status(400).json({ message: 'Fichier importe vide ou invalide' });
  }

  const lowerFileName = fileName.toLowerCase();
  if (!lowerFileName.endsWith('.bck') && !lowerFileName.endsWith('.data') && !lowerFileName.endsWith('.sqlite') && !lowerFileName.endsWith('.db')) {
    return res.status(400).json({ message: 'Format invalide. Utilisez un fichier .bck (archive WebOsteo) ou .data/.sqlite' });
  }

  const tempDbPath = path.join(dataDir, `webosteo-import-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  let weoDb = null;

  try {
    // Extract SQLite from ZIP if .bck, otherwise use directly
    let sqliteBuffer = fileBuffer;
    if (lowerFileName.endsWith('.bck')) {
      const zip = await JSZip.loadAsync(fileBuffer);
      const sqliteEntry = zip.file('webosteo.data') || zip.file(/\.data$/i)[0] || zip.file(/\.sqlite$/i)[0] || zip.file(/\.db$/i)[0];
      if (!sqliteEntry) {
        return res.status(400).json({ message: 'Archive .bck invalide: fichier de base de donnees WebOsteo introuvable dans l\'archive' });
      }
      sqliteBuffer = await sqliteEntry.async('nodebuffer');
    }

    fs.writeFileSync(tempDbPath, sqliteBuffer);
    weoDb = new Database(tempDbPath, { readonly: true });

    // Helper: safely get a string field
    const str = (val) => String(val ?? '').trim();
    const num = (val) => { const n = Number(val); return Number.isFinite(n) ? n : 0; };

    // Parse WebOsteo date YYYYMMDD -> YYYY-MM-DD
    function parseWeoDate(raw) {
      const s = str(raw);
      if (s.length === 8 && /^\d{8}$/.test(s)) {
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
      }
      return null;
    }

    // Parse WebOsteo datetime YYYYMMDDHHmm -> ISO
    const DEFAULT_TIME_FOR_DATE_ONLY = '08:00:00';
    function parseWeoDateTime(raw) {
      const s = str(raw);
      if (s.length >= 12 && /^\d{12}/.test(s)) {
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00.000Z`;
      }
      if (s.length === 8 && /^\d{8}$/.test(s)) {
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${DEFAULT_TIME_FOR_DATE_ONLY}.000Z`;
      }
      return null;
    }

    // Map WebOsteo marital status to OsteoSoft
    function mapMaritalStatus(raw) {
      const v = str(raw).toLowerCase();
      if (v === 'c' || v === 'cel' || v === 'celibataire') return 'Celibataire';
      if (v === 'm' || v === 'marie' || v === 'married') return 'Marie(e)';
      if (v === 'p' || v === 'pacs' || v === 'pacse') return 'Pacse(e)';
      if (v === 'd' || v === 'div' || v === 'divorce') return 'Divorce(e)';
      if (v === 'v' || v === 'veuf' || v === 'veuve') return 'Veuf(ve)';
      return 'Non renseigne';
    }

    // Map sex
    function mapSex(raw) {
      const v = str(raw).toLowerCase();
      if (v === 'f') return 'F';
      if (v === 'm') return 'M';
      return 'Non renseigne';
    }

    // Build name recovery map from agenda.libelle for each patient
    function buildNameRecoveryMap() {
      const map = new Map(); // patientId -> { nom, prenom }
      try {
        const agendaRows = weoDb.prepare('SELECT patient, libelle FROM agenda WHERE patient IS NOT NULL AND libelle IS NOT NULL AND libelle != \'\'').all();
        for (const row of agendaRows) {
          const pid = str(row.patient);
          if (!pid || map.has(pid)) continue;
          const libelle = str(row.libelle);
          // Pattern: "NOM [NOM2...] Prenom [- comment]" where NOM is all-uppercase
          // Strip comment after " - "
          const mainPart = libelle.split(' - ')[0].split('PATIENT SUPPRIME')[0].trim();
          const tokens = mainPart.split(/\s+/).filter(Boolean);
          if (tokens.length < 2) continue;
          // Collect leading uppercase tokens as nom
          const nomTokens = [];
          let i = 0;
          while (i < tokens.length && /^[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÆŒÇ\-']+$/.test(tokens[i])) {
            nomTokens.push(tokens[i]);
            i++;
          }
          if (nomTokens.length === 0 || i >= tokens.length) continue;
          const nom = nomTokens.join(' ');
          const prenom = tokens.slice(i).join(' ');
          if (nom && prenom) {
            map.set(pid, { nom, prenom });
          }
        }
      } catch { /* ignore */ }
      return map;
    }

    const nameRecovery = buildNameRecoveryMap();

    const errors = [];
    const tempPasswords = {};
    const userLoginToUsername = new Map(); // WebOsteo login -> OsteoSoft username
    const weoPatientIdToOsteoId = new Map(); // WebOsteo patient.id -> OsteoSoft patients.id
    const weoConsultationIdToOsteoId = new Map(); // WebOsteo consultation.id -> OsteoSoft consultations.id

    let importedUsers = 0;
    let importedPatients = 0;
    let importedConsultations = 0;
    let importedAppointments = 0;
    let importedInvoices = 0;
    let importedContacts = 0;

    // ---- Utilisateurs ----
    let weoUsers = [];
    try { weoUsers = weoDb.prepare('SELECT * FROM utilisateur').all(); } catch { /* table may not exist */ }

    for (const wu of weoUsers) {
      try {
        const username = str(wu.login);
        if (!username) continue;
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) {
          userLoginToUsername.set(username, username);
          continue;
        }

        const tempPassword = crypto.randomBytes(8).toString('hex');
        const hash = await argon2.hash(tempPassword, {
          type: argon2.argon2id,
          memoryCost: 2 ** 16,
          timeCost: 3,
          parallelism: 1
        });

        const role = str(wu.admin) === '1' ? 'admin' : 'user';
        const isActive = str(wu.enabled).toLowerCase() !== 'non' ? 1 : 0;
        const retro = num(wu.retro_defaut);

        const inserted = db.prepare(
          `INSERT INTO users (username, password_hash, role, is_active, office_id, last_name, first_name, email, mobile_phone, country, siret, adeli_code, rpps_code, ape_naf_code, color_hex, retrocession_percent, must_change_password)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
          username,
          hash,
          role,
          isActive,
          officeId,
          str(wu.nom).slice(0, 100),
          str(wu.prenom).slice(0, 100),
          str(wu.email).slice(0, 150),
          str(wu.telephone1).slice(0, 50),
          str(wu.pays) || 'France',
          str(wu.siret).slice(0, 30),
          str(wu.adeli).slice(0, 40),
          str(wu.rpps).slice(0, 40),
          str(wu.ape).slice(0, 40),
          str(wu.couleur) || '#4d92d1',
          retro
        );

        tempPasswords[username] = tempPassword;
        userLoginToUsername.set(username, username);
        importedUsers += 1;
      } catch (err) {
        errors.push({ entity: 'utilisateur', message: `Login ${str(wu.login)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Patients ----
    let weoPatients = [];
    try { weoPatients = weoDb.prepare('SELECT * FROM patient').all(); } catch { /* ignore */ }

    const retentionDate = new Date();
    retentionDate.setFullYear(retentionDate.getFullYear() + 10);
    const retentionUntil = retentionDate.toISOString().slice(0, 10);
    const now = new Date().toISOString();

    for (const wp of weoPatients) {
      try {
        const pid = str(wp.id);
        if (!pid) continue;

        // Recover name from agenda if possible
        const recovered = nameRecovery.get(pid);
        const lastName = recovered ? recovered.nom : '[Non dechiffre]';
        const firstName = recovered ? recovered.prenom : str(wp.prenom) || '[Non dechiffre]';
        const fullName = `${lastName} ${firstName}`.trim();
        const birthDate = parseWeoDate(wp.date_naissance);

        // Idempotency: skip if same name+birthdate already exists in this office
        const existingRows = db.prepare(
          'SELECT id, cipher_full_name FROM patients WHERE birth_date = ? AND office_id = ? AND is_deleted = 0'
        ).all(birthDate, officeId);
        let duplicate = false;
        for (const er of existingRows) {
          try {
            const existingName = decryptSensitiveField(er.cipher_full_name);
            if (existingName.trim().toLowerCase() === fullName.toLowerCase()) {
              weoPatientIdToOsteoId.set(pid, Number(er.id));
              duplicate = true;
              break;
            }
          } catch { /* ignore decrypt error */ }
        }
        if (duplicate) continue;

        const sex = mapSex(wp.sexe);
        const maritalStatus = mapMaritalStatus(wp.statut_marital);
        const childrenCount = Math.max(0, num(wp.nombre_enfant));

        const medicalRecord = {
          generalRemarks: [str(wp.remarques_antecedents), str(wp.remarques)].filter(Boolean).join('\n').trim(),
          medicalHistory: '',
          consultationNote: '',
          relatedPeople: '',
          mobilePhone: '',
          landlinePhone: '',
          email: '',
          address1: '',
          address2: '',
          postalCode: '',
          city: '',
          country: str(wp.pays) || 'France',
          maritalStatus,
          childrenCount,
          occupationOrSchool: str(wp.profession),
          hobbies: str(wp.activites),
          primaryDoctor: str(wp.medecin),
          socialSecurityNumber: str(wp.secu),
          referredBy: str(wp.envoye_par),
          manualPreference: 'Non renseigne',
          isDeceased: Number(wp.decede) === 1
        };

        const inserted = db.prepare(
          `INSERT INTO patients
           (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, marital_status, children_count, last_visit, consent_signed, consent_signed_at, consent_form_version, retention_until, office_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          encryptSensitiveField(fullName),
          encryptSensitiveField('Non renseigne'),
          encryptSensitiveField(JSON.stringify(medicalRecord)),
          sex,
          birthDate,
          maritalStatus,
          childrenCount,
          null,
          1,
          now,
          CURRENT_CONSENT_FORM_VERSION,
          retentionUntil,
          officeId
        );

        const newOsteoId = Number(inserted.lastInsertRowid);
        weoPatientIdToOsteoId.set(pid, newOsteoId);
        importedPatients += 1;
      } catch (err) {
        errors.push({ entity: 'patient', message: `ID ${str(wp.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Antecedents ----
    let weoAntecedents = [];
    let weoAntecedentPatients = [];
    try {
      weoAntecedents = weoDb.prepare('SELECT * FROM antecedent').all();
      weoAntecedentPatients = weoDb.prepare('SELECT * FROM antecedent_patient').all();
    } catch { /* ignore */ }

    const antecedentById = new Map();
    for (const a of weoAntecedents) {
      antecedentById.set(str(a.id), a);
    }

    for (const ap of weoAntecedentPatients) {
      try {
        const patientId = weoPatientIdToOsteoId.get(str(ap.patient));
        if (!patientId) continue;
        const antecedent = antecedentById.get(str(ap.antecedent));
        if (!antecedent) continue;

        const category = str(antecedent.nom) || str(antecedent.type) || 'Antecedent';
        const description = str(ap.comment) || str(antecedent.nom) || '';
        const important = Number(ap.important) === 1 ? 1 : 0;
        const sortKey = Number(antecedent.ordre) || 99;

        storeAntecedentTypes([category]);

        db.prepare(
          `INSERT INTO patient_antecedents (patient_id, date_precision, date_display, category, description, important, sort_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          'date',
          encryptSensitiveField(''),
          category,
          encryptSensitiveField(description),
          important,
          sortKey
        );
      } catch (err) {
        errors.push({ entity: 'antecedent', message: err instanceof Error ? err.message : 'Erreur' });
      }
    }

    // ---- Consultations ----
    let weoConsultations = [];
    try { weoConsultations = weoDb.prepare('SELECT * FROM consultation').all(); } catch { /* ignore */ }

    for (const wc of weoConsultations) {
      try {
        const patientId = weoPatientIdToOsteoId.get(str(wc.patient));
        if (!patientId) continue;

        const startedAt = parseWeoDateTime(wc.date_consult);
        if (!startedAt) continue;

        const practitioner = str(wc.createdby);
        const taille = str(wc.taille);
        const poids = str(wc.poids);
        const heightCm = taille ? (parseFloat(taille) || null) : null;
        const weightKg = poids ? (parseFloat(poids) || null) : null;
        const evaBefore = Math.min(10, Math.max(0, num(wc.douleur)));
        const important = str(wc.important) === '1' ? 1 : 0;
        const profile = str(wc.nourrisson).toLowerCase() === 'oui' ? 'Nourrisson' : 'Adulte';
        const title = str(wc.titre).slice(0, 200);

        const inserted = db.prepare(
          `INSERT INTO consultations (patient_id, started_at, office_id, practitioner, title, important, height_cm, weight_kg, eva_before, eva_after, profile)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          startedAt,
          officeId,
          practitioner.slice(0, 100),
          title,
          important,
          heightCm,
          weightKg,
          evaBefore,
          0,
          profile
        );

        const consultationId = Number(inserted.lastInsertRowid);
        weoConsultationIdToOsteoId.set(str(wc.id), consultationId);

        replaceConsultationSections(consultationId, {
          motifMainHtml: '',
          testsHtml: str(wc.tests),
          schemaHtml: str(wc.schemadysfonctionnel),
          treatmentsHtml: str(wc.traitement),
          remarksHtml: str(wc.remarques)
        });

        importedConsultations += 1;
      } catch (err) {
        errors.push({ entity: 'consultation', message: `ID ${str(wc.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Agenda ----
    let weoAgenda = [];
    try { weoAgenda = weoDb.prepare('SELECT * FROM agenda').all(); } catch { /* ignore */ }

    for (const wa of weoAgenda) {
      try {
        const patientId = weoPatientIdToOsteoId.get(str(wa.patient));
        if (!patientId) continue;

        const startsAt = parseWeoDateTime(wa.start_rdv);
        if (!startsAt) continue;

        const libelle = str(wa.libelle);
        const statut = str(wa.statut).toLowerCase();
        let status = 'Confirme';
        if (statut === 'absent' || str(wa.absent).toLowerCase() === 'oui') {
          status = 'Absent';
        }

        db.prepare(
          `INSERT INTO appointments (patient_id, starts_at, reason_cipher, status, office_id, local_calendar_id, consultation_id, practitioner, is_private)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          startsAt,
          encryptSensitiveField(libelle),
          status,
          officeId,
          null,
          null,
          str(wa.createdby).slice(0, 100),
          0
        );

        importedAppointments += 1;
      } catch (err) {
        errors.push({ entity: 'agenda', message: `ID ${str(wa.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Factures ----
    let weoFactures = [];
    let weoPersonnes = [];
    let weoFactureLines = [];
    let weoPaiements = [];
    let weoPaiementFactures = [];
    try {
      weoFactures = weoDb.prepare('SELECT * FROM facture').all();
      weoPersonnes = weoDb.prepare('SELECT * FROM personne').all();
      weoFactureLines = weoDb.prepare('SELECT * FROM facture_ligne').all();
      weoPaiements = weoDb.prepare('SELECT * FROM paiement').all();
      weoPaiementFactures = weoDb.prepare('SELECT * FROM paiement_facture').all();
    } catch { /* ignore */ }

    const personneById = new Map();
    for (const p of weoPersonnes) {
      personneById.set(str(p.id), p);
    }

    const factureLinesByFacture = new Map();
    for (const fl of weoFactureLines) {
      const key = str(fl.id_facture);
      if (!factureLinesByFacture.has(key)) factureLinesByFacture.set(key, []);
      factureLinesByFacture.get(key).push(fl);
    }

    const paiementById = new Map();
    for (const p of weoPaiements) {
      paiementById.set(str(p.id), p);
    }

    const paiementsByFacture = new Map();
    for (const pf of weoPaiementFactures) {
      const key = str(pf.id_facture);
      if (!paiementsByFacture.has(key)) paiementsByFacture.set(key, []);
      paiementsByFacture.get(key).push(pf);
    }

    for (const wf of weoFactures) {
      try {
        // Find patient via personne
        const personne = personneById.get(str(wf.personne_client));
        let patientId = null;
        if (personne && str(personne.type_entite) === 'patient') {
          patientId = weoPatientIdToOsteoId.get(str(personne.id_entite)) ?? null;
        }
        if (!patientId) continue;

        const issuedAt = parseWeoDate(wf.date_facture);
        if (!issuedAt) continue;

        const amountCents = Math.round(num(wf.montant_ttc) * 100);
        const etatPaiement = str(wf.etat_paiement).toLowerCase();
        const etat = str(wf.etat).toLowerCase();
        let invoiceStatus = 'En attente';
        if (etatPaiement === 'paye') invoiceStatus = 'Payee';
        else if (etat === 'annulee') invoiceStatus = 'Annulee';

        const consultationId = weoConsultationIdToOsteoId.get(str(wf.id_consultation)) ?? null;

        const inserted = db.prepare(
          `INSERT INTO invoices (patient_id, invoice_number, amount_cents, status, issued_at, due_at, notes_cipher, office_id, consultation_id, payment_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          str(wf.numero_formatte) || str(wf.numero) || '',
          amountCents,
          invoiceStatus,
          issuedAt,
          issuedAt,
          encryptSensitiveField(str(wf.commentaire)),
          officeId,
          consultationId,
          ''
        );

        const invoiceId = Number(inserted.lastInsertRowid);

        // Invoice lines
        const lines = factureLinesByFacture.get(str(wf.id)) ?? [];
        for (let idx = 0; idx < lines.length; idx++) {
          const fl = lines[idx];
          try {
            db.prepare(
              `INSERT INTO invoice_line_items (invoice_id, label, quantity, unit_amount_ht_cents, vat_rate, display_order)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).run(
              invoiceId,
              str(fl.libelle).slice(0, 200),
              num(fl.quantite) || 1,
              Math.round(num(fl.montant_ht_unitaire) * 100),
              num(fl.taux_tva),
              num(fl.ordre) || idx
            );
          } catch { /* ignore line errors */ }
        }

        // Payments
        const paiementFactures = paiementsByFacture.get(str(wf.id)) ?? [];
        for (const pf of paiementFactures) {
          const paiement = paiementById.get(str(pf.id_paiement));
          if (!paiement) continue;
          try {
            const paidAt = parseWeoDate(paiement.date_paiement) ?? issuedAt;
            db.prepare(
              `INSERT INTO invoice_payments (invoice_id, paid_at, amount_cents, currency, payment_method, bank_name, cheque_number, reference, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              invoiceId,
              paidAt,
              Math.round(num(paiement.montant) * 100),
              str(wf.devise) || 'EUR',
              str(paiement.moyen_paiement),
              str(paiement.paiement_banque),
              str(paiement.cheque_emetteur),
              str(paiement.reference),
              str(paiement.commentaire) || str(paiement.libelle)
            );
          } catch { /* ignore payment errors */ }
        }

        importedInvoices += 1;
      } catch (err) {
        errors.push({ entity: 'facture', message: `ID ${str(wf.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Contacts ----
    let weoContacts = [];
    try { weoContacts = weoDb.prepare('SELECT * FROM contact').all(); } catch { /* ignore */ }

    for (const wc of weoContacts) {
      try {
        db.prepare(
          `INSERT INTO directory_contacts (office_id, kind, first_name, last_name, email, mobile_phone, landline_phone, address_line1, address_line2, postal_code, city, country, notes, role, organization, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          officeId,
          'person',
          str(wc.prenom).slice(0, 120),
          str(wc.nom).slice(0, 120),
          str(wc.email).slice(0, 160),
          str(wc.telephone1).slice(0, 50),
          str(wc.telephone2).slice(0, 50),
          str(wc.adresse1).slice(0, 200),
          str(wc.adresse2).slice(0, 200),
          str(wc.code_postal).slice(0, 20),
          str(wc.ville).slice(0, 120),
          'France',
          str(wc.profession).slice(0, 4000),
          str(wc.profession).slice(0, 120),
          '',
          req.user.sub,
          req.user.sub
        );
        importedContacts += 1;
      } catch (err) {
        errors.push({ entity: 'contact', message: `ID ${str(wc.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    writeAuditLog(req.user.sub, 'IMPORT', 'data-management-webosteo', String(officeId), {
      importedUsers,
      importedPatients,
      importedConsultations,
      importedAppointments,
      importedInvoices,
      importedContacts,
      errorCount: errors.length
    });

    return res.json({
      importedUsers,
      importedPatients,
      importedConsultations,
      importedAppointments,
      importedInvoices,
      importedContacts,
      errors: errors.slice(0, 100),
      tempPasswords
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Echec de l\'import WebOsteo';
    return res.status(400).json({ message });
  } finally {
    if (weoDb) {
      try { weoDb.close(); } catch { /* ignore */ }
    }
    try { if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath); } catch { /* ignore */ }
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

  const logs = rows.map(mapAuditLogRow);

  return res.json({ logs });
});

app.get('/api/audit-logs/security/setup', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const rawLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
  const eventFilter = String(req.query.event ?? '').trim();

  const rows = db
    .prepare(
      `SELECT l.id, l.created_at, l.action, l.entity, l.entity_id, l.metadata, u.username
       FROM audit_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.action = 'SECURITY' AND l.entity = 'setup'
       ORDER BY datetime(l.created_at) DESC, l.id DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(limit * 5, 100), 2000));

  const filteredLogs = rows
    .map(mapAuditLogRow)
    .filter((log) => (eventFilter ? String(log.metadata?.event ?? '') === eventFilter : true))
    .slice(0, limit);

  return res.json({ logs: filteredLogs });
});

app.get('/api/patient-drafts/new-patient', authMiddleware, (req, res) => {
  const row = db
    .prepare(
      `SELECT step, draft_json, updated_at
       FROM draft
       WHERE user_id = ? AND flow_key = 'new_patient'`
    )
    .get(req.user.sub);

  if (!row) {
    return res.json({ draft: null });
  }

  let payload = null;
  try {
    payload = JSON.parse(safeDecryptField(row.draft_json));
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
    `INSERT INTO draft (user_id, flow_key, draft_json, step, updated_at)
     VALUES (?, 'new_patient', ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, flow_key)
     DO UPDATE SET draft_json = excluded.draft_json,
                   step = excluded.step,
                   updated_at = CURRENT_TIMESTAMP`
  ).run(req.user.sub, encryptSensitiveField(JSON.stringify(parsed.data.payload)), parsed.data.step);

  return res.status(204).send();
});

app.delete('/api/patient-drafts/new-patient', authMiddleware, (req, res) => {
  db.prepare(
    `DELETE FROM draft
     WHERE user_id = ? AND flow_key = 'new_patient'`
  ).run(req.user.sub);

  return res.status(204).send();
});

app.get('/api/office-drafts/new-office', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const row = db
    .prepare(
      `SELECT step, draft_json, updated_at
       FROM draft
       WHERE user_id = ? AND flow_key = 'new_office'`
    )
    .get(req.user.sub);

  if (!row) {
    return res.json({ draft: null });
  }

  let payload = null;
  try {
    payload = JSON.parse(safeDecryptField(row.draft_json));
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== 'object') {
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

app.put('/api/office-drafts/new-office', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const parsed = officeDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  db.prepare(
    `INSERT INTO draft (user_id, flow_key, draft_json, step, updated_at)
     VALUES (?, 'new_office', ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, flow_key)
     DO UPDATE SET draft_json = excluded.draft_json,
                   step = excluded.step,
                   updated_at = CURRENT_TIMESTAMP`
  ).run(req.user.sub, encryptSensitiveField(JSON.stringify(parsed.data.payload)), parsed.data.step);

  return res.status(204).send();
});

app.delete('/api/office-drafts/new-office', authMiddleware, adminOnlyMiddleware, (req, res) => {
  db.prepare(
    `DELETE FROM draft
     WHERE user_id = ? AND flow_key = 'new_office'`
  ).run(req.user.sub);

  return res.status(204).send();
});

app.get('/api/patients/:id/consultation-drafts/new-consultation', authMiddleware, requirePermission('create-consultation'), (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'ID patient invalide' });
  }

  const patient = db.prepare('SELECT id FROM patients WHERE id = ? AND is_deleted = 0').get(patientId);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const flowKey = `new_consultation_patient_${patientId}`;
  const row = db
    .prepare(
      `SELECT step, draft_json, updated_at
       FROM draft
       WHERE user_id = ? AND flow_key = ?`
    )
    .get(req.user.sub, flowKey);

  if (!row) {
    return res.json({ draft: null });
  }

  let payload = null;
  try {
    payload = JSON.parse(safeDecryptField(row.draft_json));
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== 'object') {
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

app.put('/api/patients/:id/consultation-drafts/new-consultation', authMiddleware, requirePermission('create-consultation'), (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'ID patient invalide' });
  }

  const patient = db.prepare('SELECT id FROM patients WHERE id = ? AND is_deleted = 0').get(patientId);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const parsed = newConsultationDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const flowKey = `new_consultation_patient_${patientId}`;
  db.prepare(
    `INSERT INTO draft (user_id, flow_key, draft_json, step, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, flow_key)
     DO UPDATE SET draft_json = excluded.draft_json,
                   step = excluded.step,
                   updated_at = CURRENT_TIMESTAMP`
  ).run(req.user.sub, flowKey, encryptSensitiveField(JSON.stringify(parsed.data.payload)), parsed.data.step);

  return res.status(204).send();
});

app.delete('/api/patients/:id/consultation-drafts/new-consultation', authMiddleware, requirePermission('create-consultation'), (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'ID patient invalide' });
  }

  const flowKey = `new_consultation_patient_${patientId}`;
  db.prepare(
    `DELETE FROM draft
     WHERE user_id = ? AND flow_key = ?`
  ).run(req.user.sub, flowKey);

  return res.status(204).send();
});

app.get('/api/antecedent-types', authMiddleware, (_req, res) => {
  const rows = db
    .prepare('SELECT label FROM antecedent_types ORDER BY lower(label) ASC')
    .all();

  return res.json({ types: rows.map((row) => row.label) });
});

app.get('/api/patients/:id/antecedents', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const patient = db
    .prepare('SELECT id, cipher_medical_notes, office_id FROM patients WHERE id = ? AND is_deleted = 0')
    .get(patientId);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

  let rows = db
    .prepare(
      `SELECT id, date_precision, date_display, category, description, important, sort_key
       FROM patient_antecedents
       WHERE patient_id = ?
       ORDER BY sort_key DESC, id DESC`
    )
    .all(patientId);

  if (rows.length === 0) {
    let notes = {};
    try {
      notes = JSON.parse(decryptSensitiveField(patient.cipher_medical_notes)) ?? {};
    } catch {
      notes = {};
    }

    const medicalHistory = String(notes.medicalHistory ?? '');
    if (parsePatientAntecedentsFromMedicalHistory(medicalHistory).length > 0) {
      replacePatientAntecedents(patientId, medicalHistory);
      rows = db
        .prepare(
          `SELECT id, date_precision, date_display, category, description, important, sort_key
           FROM patient_antecedents
           WHERE patient_id = ?
           ORDER BY sort_key DESC, id DESC`
        )
        .all(patientId);
    }
  }

  const antecedents = rows.map((row) => ({
    id: Number(row.id),
    datePrecision: String(row.date_precision ?? 'date').trim() || 'date',
    date: safeDecryptField(row.date_display).trim(),
    category: String(row.category ?? '').trim(),
    description: safeDecryptField(row.description).trim(),
    important: Boolean(row.important),
    sortKey: Number(row.sort_key) || 0
  }));

  return res.json({ antecedents });
});

app.get('/api/consultation-context', authMiddleware, requirePermission('create-consultation'), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const scopedOffices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const scopedOfficeIds = new Set(
    scopedOffices
      .map((office) => Number(office.id))
      .filter((id) => Number.isInteger(id) && id > 0)
  );

  const requestedOfficeId = Number(req.query.officeId);
  const selectedOfficeId = Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 && scopedOfficeIds.has(requestedOfficeId)
    ? requestedOfficeId
    : (scopedOffices[0]?.id ?? null);

  if (!selectedOfficeId) {
    return res.json({
      officeId: null,
      officeName: null,
      practitioners: [],
      profiles: []
    });
  }

  const officeRow = db
    .prepare('SELECT id, name, consultation_profiles_json AS consultationProfilesJson FROM offices WHERE id = ? LIMIT 1')
    .get(selectedOfficeId);

  if (!officeRow) {
    return res.json({
      officeId: null,
      officeName: null,
      practitioners: [],
      profiles: []
    });
  }

  const practitionerRows = db
    .prepare(
      `SELECT DISTINCT u.id, u.username, u.role, u.last_name, u.first_name,
              p.rights_json AS rights_json, u.profile_id
       FROM users u
       LEFT JOIN user_offices uo ON uo.user_id = u.id
       LEFT JOIN office_user_delegations oud ON oud.user_id = u.id AND oud.office_id = ?
       LEFT JOIN access_profiles p ON p.id = coalesce(oud.profile_id, u.profile_id)
       WHERE u.is_active = 1
         AND (
           u.office_id = ?
           OR uo.office_id = ?
           OR oud.office_id = ?
         )
       ORDER BY lower(u.username) ASC, u.id ASC`
    )
    .all(selectedOfficeId, selectedOfficeId, selectedOfficeId, selectedOfficeId);

  const practitioners = practitionerRows
    .filter((row) => {
      if (String(row.role ?? '').trim() === 'admin') {
        return true;
      }

      let parsedRights;
      try {
        parsedRights = row.rights_json ? JSON.parse(row.rights_json) : {};
      } catch {
        parsedRights = {};
      }

      const normalized = normalizeAccessRights(parsedRights, false);
      return hasPermission(normalized, 'create-patient-record');
    })
    .map((row) => {
      const firstName = String(row.first_name ?? '').trim();
      const lastName = String(row.last_name ?? '').trim();
      const displayName = `${firstName} ${lastName}`.trim() || String(row.username ?? '').trim();

      return {
        id: Number(row.id),
        username: String(row.username ?? '').trim(),
        displayName,
        role: String(row.role ?? '').trim()
      };
    });

  const serviceTypeRows = db
    .prepare(
      `SELECT label, amount_ht_cents, vat_rate, display_order
       FROM service_types
       WHERE office_id = ?
       ORDER BY display_order ASC, id ASC`
    )
    .all(selectedOfficeId);

  const serviceTypes = serviceTypeRows.map((row) => ({
    label: String(row.label ?? '').trim(),
    amountHt: Number(row.amount_ht_cents ?? 0) / 100,
    vatRate: Number(row.vat_rate ?? 0),
    displayOrder: Number(row.display_order ?? 0)
  })).filter((item) => item.label.length > 0);

  const paymentMethodRows = db
    .prepare(
      `SELECT label, is_active, display_order
       FROM payment_methods
       WHERE office_id = ? AND is_active = 1
       ORDER BY display_order ASC, id ASC`
    )
    .all(selectedOfficeId);

  const paymentMethods = paymentMethodRows.map((row) => String(row.label ?? '').trim()).filter(Boolean);

  return res.json({
    officeId: Number(officeRow.id),
    officeName: String(officeRow.name ?? '').trim() || null,
    practitioners,
    profiles: parseOfficeConsultationProfiles(officeRow.consultationProfilesJson),
    serviceTypes,
    paymentMethods
  });
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

  try {
    const delegationOfficeIds = JSON.parse(row.delegation_office_ids_json ?? '[]');
    if (Array.isArray(delegationOfficeIds)) {
      officeIds = [...new Set([
        ...officeIds,
        ...delegationOfficeIds
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      ])];
    }
  } catch {
    // Ignore invalid JSON payload and keep officeIds from user_offices/users.office_id only.
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
    bankName: safeDecryptField(row.bank_name_cipher),
    iban: safeDecryptField(row.iban_cipher),
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
              u.bank_name_cipher, u.iban_cipher, u.retrocession_percent, u.retrocession_recipient,
              u.default_agenda_view, u.visible_calendars, u.default_service, u.invoice_mentions,
              (
                SELECT json_group_array(uo.office_id)
                FROM user_offices uo
                WHERE uo.user_id = u.id
              ) AS office_ids_json,
              (
                SELECT json_group_array(oud.office_id)
                FROM office_user_delegations oud
                WHERE oud.user_id = u.id
              ) AS delegation_office_ids_json,
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
      bank_name_cipher, iban_cipher, retrocession_percent, retrocession_recipient,
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
    payload.bankName.trim() ? encryptSensitiveField(payload.bankName.trim()) : '',
    payload.iban.trim() ? encryptSensitiveField(payload.iban.trim()) : '',
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
              u.bank_name_cipher, u.iban_cipher, u.retrocession_percent, u.retrocession_recipient,
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

    if ((payload.role ?? targetUser.role).trim() !== 'admin') {
      return res.status(403).json({ message: 'Le compte admin doit conserver le role admin' });
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
         bank_name_cipher = ?,
         iban_cipher = ?,
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
    payload.bankName.trim() ? encryptSensitiveField(payload.bankName.trim()) : '',
    payload.iban.trim() ? encryptSensitiveField(payload.iban.trim()) : '',
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
    db.prepare('DELETE FROM draft WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  removeUser();

  writeAuditLog(req.user.sub, 'DELETE', 'users', String(userId), {
    targetUsername: targetUser.username
  });

  return res.status(204).send();
});

app.post('/api/users/:id/reset-password', authMiddleware, adminOnlyMiddleware, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: 'ID utilisateur invalide' });
  }

  const targetUser = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!targetUser) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  if (targetUser.username === 'admin') {
    return res.status(403).json({ message: 'Le mot de passe du compte admin ne peut pas être réinitialisé via cette interface' });
  }

  if (req.user.sub === userId) {
    return res.status(403).json({ message: 'Vous ne pouvez pas réinitialiser votre propre mot de passe via cette interface' });
  }

  const tempPassword = crypto.randomBytes(8).toString('hex');
  const hashedPassword = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1
  });

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashedPassword, userId);

  writeAuditLog(req.user.sub, 'UPDATE', 'users', String(userId), {
    action: 'admin_password_reset',
    targetUsername: targetUser.username,
  });

  return res.status(200).json({ tempPassword });
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
    writeAuthSecurityLog(req, 'login_attempt_rejected', {
      reason: 'invalid_payload',
      statusCode: 400,
      attemptedUsername: String(req.body?.username ?? '').trim().slice(0, 120) || null,
      issuesCount: parsed.error.issues.length
    });
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const attemptedUsername = parsed.data.username.trim().slice(0, 120);

  const LOCK_THRESHOLD = 10;
  const LOCK_DURATION_MINUTES = 15;
  const lockDurationModifier = `+${LOCK_DURATION_MINUTES} minutes`;

  const user = db
    .prepare(
      `SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.profile_id, u.must_change_password,
              u.failed_login_attempts, u.locked_until,
              p.label AS profile_label
       FROM users u
       LEFT JOIN access_profiles p ON p.id = u.profile_id
       WHERE u.username = ?`
    )
    .get(parsed.data.username);

  if (!user) {
    writeAuthSecurityLog(req, 'login_attempt_failed', {
      reason: 'unknown_user',
      statusCode: 401,
      attemptedUsername
    });
    return res.status(401).json({ message: 'Identifiants invalides' });
  }

  if (!user.is_active) {
    writeAuthSecurityLog(req, 'login_attempt_failed', {
      reason: 'inactive_user',
      statusCode: 403,
      attemptedUsername,
      userId: Number(user.id)
    });
    return res.status(403).json({ message: 'Compte desactive' });
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    writeAuthSecurityLog(req, 'login_attempt_failed', {
      reason: 'account_locked',
      statusCode: 429,
      attemptedUsername,
      userId: Number(user.id),
      lockedUntil: user.locked_until
    });
    return res.status(429).json({ message: 'Compte temporairement verrouillé. Reessayez plus tard.' });
  }

  const validPassword = await argon2.verify(user.password_hash, parsed.data.password);
  if (!validPassword) {
    db.prepare(
      `UPDATE users SET
         failed_login_attempts = failed_login_attempts + 1,
         locked_until = CASE
           WHEN failed_login_attempts + 1 >= ? THEN datetime('now', ?)
           ELSE locked_until
         END
       WHERE id = ?`
    ).run(LOCK_THRESHOLD, lockDurationModifier, user.id);

    writeAuthSecurityLog(req, 'login_attempt_failed', {
      reason: 'invalid_password',
      statusCode: 401,
      attemptedUsername,
      userId: Number(user.id)
    });
    return res.status(401).json({ message: 'Identifiants invalides' });
  }

  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  const token = signTokenForSession(user, Boolean(parsed.data.remember));
  res.cookie(SESSION_COOKIE_NAME, token, buildSessionCookieOptions(Boolean(parsed.data.remember)));

  writeAuditLog(user.id, 'LOGIN', 'auth', String(user.id));
  writeAuthSecurityLog(req, 'login_attempt_succeeded', {
    reason: 'authenticated',
    statusCode: 200,
    attemptedUsername,
    userId: Number(user.id)
  });

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
      rights: access?.rights ?? buildAccessRights(false),
      mustChangePassword: user.must_change_password === 1
    }
  });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  clearSessionCookie(res);
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

  if (search) {
    const searchLike = `%${search}%`;
    whereParts.push(`(
      lower(trim(dc.last_name || ' ' || dc.first_name)) LIKE ?
      OR lower(dc.first_name) LIKE ?
      OR lower(dc.last_name) LIKE ?
      OR lower(dc.organization) LIKE ?
      OR lower(dc.role) LIKE ?
      OR lower(dc.email) LIKE ?
      OR lower(dc.mobile_phone) LIKE ?
      OR lower(dc.landline_phone) LIKE ?
      OR lower(dc.city) LIKE ?
      OR lower(dc.postal_code) LIKE ?
      OR lower(o.name) LIKE ?
    )`);
    params.push(
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike
    );
  }

  const rows = db
    .prepare(
      `SELECT dc.id, dc.office_id, o.name AS office_name, dc.kind,
              dc.first_name, dc.last_name, dc.organization, dc.role,
              dc.email, dc.mobile_phone, dc.landline_phone,
              dc.address_line1, dc.address_line2, dc.postal_code, dc.city, dc.country,
              dc.notes, dc.created_at, dc.updated_at
       FROM directory_contacts dc
       INNER JOIN offices o ON o.id = dc.office_id
       ${whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''}
       ORDER BY lower(dc.last_name) ASC, lower(dc.first_name) ASC, lower(dc.organization) ASC, dc.id ASC`
    )
    .all(...params)
    .map(mapDirectoryContactRow);

  return res.json({ contacts: rows, offices, selectedOfficeId: officeIdFilter });
});

app.get('/api/directory/contacts/count', authMiddleware, requirePermission('read-directory'), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const offices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const allowedOfficeIds = offices
    .map((office) => Number(office.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (!isAdmin && allowedOfficeIds.length === 0) {
    return res.json({ count: 0 });
  }

  if (isAdmin) {
    const totalCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM directory_contacts').get()?.count ?? 0
    );
    return res.json({ count: totalCount });
  }

  const placeholders = allowedOfficeIds.map(() => '?').join(', ');
  const scopedCount = Number(
    db
      .prepare(`SELECT COUNT(*) AS count FROM directory_contacts WHERE office_id IN (${placeholders})`)
      .get(...allowedOfficeIds)?.count ?? 0
  );

  return res.json({ count: scopedCount });
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
         notes, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      req.user.sub,
      req.user.sub
    );

  const row = db
    .prepare(
      `SELECT dc.id, dc.office_id, o.name AS office_name, dc.kind,
              dc.first_name, dc.last_name, dc.organization, dc.role,
              dc.email, dc.mobile_phone, dc.landline_phone,
              dc.address_line1, dc.address_line2, dc.postal_code, dc.city, dc.country,
              dc.notes, dc.created_at, dc.updated_at
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
         notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
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
    req.user.sub,
    contactId
  );

  const row = db
    .prepare(
      `SELECT dc.id, dc.office_id, o.name AS office_name, dc.kind,
              dc.first_name, dc.last_name, dc.organization, dc.role,
              dc.email, dc.mobile_phone, dc.landline_phone,
              dc.address_line1, dc.address_line2, dc.postal_code, dc.city, dc.country,
              dc.notes, dc.created_at, dc.updated_at
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
              dc.notes, dc.created_at, dc.updated_at
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
    'pays'
  ];

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
    ].map((value) => serializeCsvCell(value, ';')).join(';'));
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

  const isAdmin = req.user.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;

  const userRows = db
    .prepare(
      `SELECT id, username, role, first_name, last_name
       FROM users
       WHERE is_active = 1
       ORDER BY lower(last_name) ASC, lower(first_name) ASC, lower(username) ASC`
    )
    .all();

  const userContacts = userRows
    .map((row) => {
      const fullName = `${String(row.last_name ?? '').trim()} ${String(row.first_name ?? '').trim()}`.trim();
      const label = fullName || String(row.username ?? '').trim();
      return {
        id: Number(row.id),
        fullName: label,
        role: String(row.role ?? '').trim(),
        city: ''
      };
    })
    .filter((contact) =>
      [contact.fullName, contact.role]
        .map((value) => String(value ?? '').toLowerCase())
        .some((value) => value.includes(query))
    );
  const scopedOffices = getScopedOfficeOptions(req.userAccess, isAdmin);
  const allowedOfficeIds = scopedOffices
    .map((office) => Number(office.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  let directoryRows = [];

  try {
    if (isAdmin) {
      directoryRows = db
        .prepare(
           `SELECT id, kind, first_name, last_name, organization, role, city, is_active
           FROM directory_contacts
           ORDER BY lower(last_name) ASC, lower(first_name) ASC, lower(organization) ASC, id ASC`
        )
        .all();
    } else if (allowedOfficeIds.length > 0) {
      const placeholders = allowedOfficeIds.map(() => '?').join(', ');
      directoryRows = db
        .prepare(
           `SELECT id, kind, first_name, last_name, organization, role, city, is_active
           FROM directory_contacts
           WHERE office_id IN (${placeholders})
           ORDER BY lower(last_name) ASC, lower(first_name) ASC, lower(organization) ASC, id ASC`
        )
        .all(...allowedOfficeIds);
    }
  } catch {
    // Keep suggestions working even if directory schema is not ready yet.
    directoryRows = [];
  }

  const directoryContacts = directoryRows
    .filter((row) => Number(row.is_active) === 1)
    .map((row) => {
      const firstName = String(row.first_name ?? '').trim();
      const lastName = String(row.last_name ?? '').trim();
      const organization = String(row.organization ?? '').trim();
      const fullName = `${lastName} ${firstName}`.trim() || organization;
      const role = String(row.role ?? '').trim() || (row.kind === 'company' ? 'Structure' : 'Contact');
      const city = String(row.city ?? '').trim();

      return {
        // Offset ids to avoid collisions with users in ng @for track contact.id.
        id: 1_000_000_000 + Number(row.id),
        fullName,
        role,
        city
      };
    })
    .filter((contact) =>
      [contact.fullName, contact.role, contact.city]
        .map((value) => String(value ?? '').toLowerCase())
        .some((value) => value.includes(query))
    );

  const mergedContacts = [...directoryContacts, ...userContacts];
  const seenNames = new Set();
  const contacts = [];

  for (const contact of mergedContacts) {
    const key = `${contact.fullName.toLowerCase()}|${contact.role.toLowerCase()}`;
    if (seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    contacts.push(contact);
    if (contacts.length >= 12) {
      break;
    }
  }

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

app.post('/api/patients', authMiddleware, requirePermission('create-patient-record'), async (req, res) => {
  const parsed = createPatientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;

  let preValidatedDocuments = [];
  if (Array.isArray(payload.consultationDocuments) && payload.consultationDocuments.length > 0) {
    try {
      preValidatedDocuments = await normalizeConsultationDocumentsPayload(payload.consultationDocuments);
    } catch (err) {
      return res.status(415).json({ message: err.message || 'Type de fichier non autorisé' });
    }
  }

  const consultationScheduling = resolveConsultationSchedulingContextFromRaw(payload.consultationNote, {
    userId: req.user.sub,
    officeId: req.userAccess?.officeIds?.[0] ?? null,
    preferRequestedOffice: true
  });

  if (consultationScheduling && !payload.consultationLinkStrategy) {
    const overlappingAppointment = findOverlappingAppointmentForOffice(
      consultationScheduling.consultationOfficeId,
      consultationScheduling.localCalendarId,
      consultationScheduling.alignedStartIso,
      consultationScheduling.slotDurationMinutes
    );

    if (overlappingAppointment) {
      return res.status(409).json({
        message: 'Un rendez-vous existe deja sur ce creneau dans le cabinet actif.',
        conflict: {
          type: 'appointment-overlap',
          appointmentId: overlappingAppointment.id,
          startsAt: overlappingAppointment.startsAt,
          officeId: consultationScheduling.consultationOfficeId
        }
      });
    }
  }

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
    maritalStatus: payload.maritalStatus,
    childrenCount: payload.childrenCount,
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
  const consentSignedAt = new Date().toISOString();
  const inserted = db
    .prepare(
      `INSERT INTO patients
       (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, marital_status, children_count, last_visit, consent_signed, consent_signed_at, consent_form_version, retention_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      encryptSensitiveField(fullName),
      encryptSensitiveField(mainPhone),
      encryptSensitiveField(JSON.stringify(medicalRecord)),
      payload.sex === 'Femme' ? 'F' : payload.sex === 'Homme' ? 'M' : 'Non renseigne',
      birthDate || null,
      payload.maritalStatus,
      payload.childrenCount,
      null,
      1,
      consentSignedAt,
      CURRENT_CONSENT_FORM_VERSION,
      retentionUntil
    );

  writeAuditLog(req.user.sub, 'CREATE', 'patients', String(inserted.lastInsertRowid), {
    nameCipher: encryptSensitiveField(fullName),
    sex: payload.sex
  });

  storeAntecedentTypes(antecedentCategories);
  replacePatientAntecedents(Number(inserted.lastInsertRowid), payload.medicalHistory);
  const consultationCreation = insertConsultationFromNote(Number(inserted.lastInsertRowid), payload.consultationNote, {
    userId: req.user.sub,
    officeId: req.userAccess?.officeIds?.[0] ?? null,
    linkStrategy: payload.consultationLinkStrategy === 'create-new' ? 'create-new' : 'attach-existing'
  });

  const createdDocuments = insertNormalizedDocuments(
    Number(inserted.lastInsertRowid),
    consultationCreation?.consultationId ?? null,
    consultationCreation?.officeId ?? (req.userAccess?.officeIds?.[0] ?? null),
    req.user.sub,
    preValidatedDocuments
  );

  synchronizeBidirectionalRelatedPeople({
    targetPatientId: Number(inserted.lastInsertRowid),
    targetCurrentFullName: fullName,
    targetPreviousFullName: fullName,
    previousRelatedPeople: '',
    nextRelatedPeople: normalizedRelatedPeople
  });

  db.prepare(
    `DELETE FROM draft
     WHERE user_id = ? AND flow_key = 'new_patient'`
  ).run(req.user.sub);

  return res.status(201).json({
    patient: {
      id: inserted.lastInsertRowid,
      fullName
    },
    consultation: consultationCreation
      ? {
        id: consultationCreation.consultationId,
        officeId: consultationCreation.officeId,
        appointmentId: consultationCreation.appointmentId,
        linkedToExisting: consultationCreation.linkedToExisting
      }
      : null,
    documents: createdDocuments.map((doc) => ({
      ...doc,
      link: `/api/patient-documents/${encodeURIComponent(doc.documentRef)}`
    }))
  });
});

app.get('/api/patients/:id/documents', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'Identifiant patient invalide' });
  }

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(patientId);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

  const rows = db.prepare(
    `SELECT id, document_ref, consultation_id, office_id, file_name, mime_type, size_bytes, title_cipher, comment_cipher, created_at
     FROM patient_documents
     WHERE patient_id = ?
     ORDER BY datetime(created_at) DESC, id DESC`
  ).all(patientId);

  const documents = rows.map((row) => ({
    id: Number(row.id),
    documentRef: row.document_ref,
    consultationId: row.consultation_id != null ? Number(row.consultation_id) : null,
    officeId: row.office_id != null ? Number(row.office_id) : null,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes) || 0,
    title: row.title_cipher ? decryptSensitiveField(row.title_cipher) : '',
    comment: row.comment_cipher ? decryptSensitiveField(row.comment_cipher) : '',
    createdAt: row.created_at,
    link: `/api/patient-documents/${encodeURIComponent(row.document_ref)}`
  }));

  return res.json({ documents });
});

app.get('/api/patient-documents/:documentRef', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const documentRef = String(req.params.documentRef ?? '').trim();
  if (!documentRef) {
    return res.status(400).json({ message: 'Reference document invalide' });
  }

  const row = db.prepare(
    `SELECT id, document_ref, patient_id, consultation_id, office_id, file_name, mime_type, size_bytes,
            title_cipher, comment_cipher, content_cipher, created_at
     FROM patient_documents
     WHERE document_ref = ?
     LIMIT 1`
  ).get(documentRef);

  if (!row) {
    return res.status(404).json({ message: 'Document introuvable' });
  }

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(Number(row.patient_id));
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  const documentOfficeId = row.office_id != null ? Number(row.office_id) : null;
  const effectiveOfficeId = documentOfficeId ?? patientOfficeId;
  if (effectiveOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(effectiveOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - document d\'un autre cabinet' });
      }
    }
  }

  return res.json({
    document: {
      id: Number(row.id),
      documentRef: row.document_ref,
      patientId: Number(row.patient_id),
      consultationId: row.consultation_id != null ? Number(row.consultation_id) : null,
      officeId: row.office_id != null ? Number(row.office_id) : null,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes) || 0,
      title: row.title_cipher ? decryptSensitiveField(row.title_cipher) : '',
      comment: row.comment_cipher ? decryptSensitiveField(row.comment_cipher) : '',
      contentBase64: decryptSensitiveField(row.content_cipher),
      createdAt: row.created_at
    }
  });
});

app.post('/api/patients/:id/documents', authMiddleware, requirePermission('create-patient-record'), async (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'Identifiant patient invalide' });
  }

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(patientId);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

  const fileName = String(req.body?.fileName ?? '').trim();
  const declaredSizeBytes = Math.max(0, Number(req.body?.sizeBytes) || 0);
  const title = String(req.body?.title ?? '').trim();
  const comment = String(req.body?.comment ?? '').trim();
  const contentBase64 = normalizeBase64Payload(req.body?.contentBase64);
  const officeIdRaw = Number(req.body?.officeId);
  const consultationIdRaw = Number(req.body?.consultationId);
  const requestedOfficeId = Number.isInteger(officeIdRaw) && officeIdRaw > 0 ? officeIdRaw : null;
  const consultationId = Number.isInteger(consultationIdRaw) && consultationIdRaw > 0 ? consultationIdRaw : null;

  if (!fileName || !contentBase64) {
    return res.status(400).json({ message: 'Fichier invalide' });
  }

  if (fileName.length > 255) {
    return res.status(400).json({ message: 'Nom de fichier invalide' });
  }

  const contentSizeBytes = getBase64DecodedByteLength(contentBase64);
  if (contentSizeBytes <= 0) {
    return res.status(400).json({ message: 'Contenu du fichier invalide' });
  }

  if (contentSizeBytes > MAX_PATIENT_DOCUMENT_BYTES) {
    return res.status(413).json({ message: `Fichier trop volumineux (max ${Math.floor(MAX_PATIENT_DOCUMENT_BYTES / (1024 * 1024))} Mo)` });
  }

  if (declaredSizeBytes > 0) {
    const delta = Math.abs(declaredSizeBytes - contentSizeBytes);
    if (delta > 2048) {
      return res.status(400).json({ message: 'Taille de fichier incoherente' });
    }
  }

  let mimeType;
  try {
    mimeType = await validateDocumentMimeType(contentBase64);
  } catch (err) {
    return res.status(415).json({ message: err.message || 'Type de fichier non autorisé' });
  }

  if (requestedOfficeId !== null && patientOfficeId !== null && requestedOfficeId !== patientOfficeId) {
    return res.status(400).json({ message: 'Cabinet du document incoherent avec le patient' });
  }

  const officeId = patientOfficeId ?? requestedOfficeId;

  if (consultationId !== null) {
    const consultation = db
      .prepare('SELECT id, patient_id FROM consultations WHERE id = ? LIMIT 1')
      .get(consultationId);

    if (!consultation || Number(consultation.patient_id) !== patientId) {
      return res.status(400).json({ message: 'Consultation invalide pour ce patient' });
    }
  }

  const documentRef = `doc-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO patient_documents
      (document_ref, patient_id, consultation_id, office_id, created_by, file_name, mime_type, size_bytes, title_cipher, comment_cipher, content_cipher)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    documentRef,
    patientId,
    consultationId,
    officeId,
    req.user.sub,
    fileName,
    mimeType,
    contentSizeBytes,
    title ? encryptSensitiveField(title) : null,
    comment ? encryptSensitiveField(comment) : null,
    encryptSensitiveField(contentBase64)
  );

  return res.status(201).json({
    document: {
      id: Number(db.prepare('SELECT id FROM patient_documents WHERE document_ref = ? LIMIT 1').get(documentRef)?.id ?? 0),
      documentRef,
      consultationId,
      officeId,
      fileName,
      mimeType,
      sizeBytes: contentSizeBytes,
      title,
      comment,
      createdAt: new Date().toISOString(),
      link: `/api/patient-documents/${encodeURIComponent(documentRef)}`
    }
  });
});

app.patch('/api/patient-documents/:documentRef', authMiddleware, requirePermission('create-patient-record'), (req, res) => {
  const documentRef = String(req.params.documentRef ?? '').trim();
  if (!documentRef) {
    return res.status(400).json({ message: 'Reference document invalide' });
  }

  const row = db.prepare(
    `SELECT id, document_ref, patient_id, consultation_id, office_id, file_name, mime_type, size_bytes, created_at
     FROM patient_documents
     WHERE document_ref = ?
     LIMIT 1`
  ).get(documentRef);

  if (!row) {
    return res.status(404).json({ message: 'Document introuvable' });
  }

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(Number(row.patient_id));
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  const documentOfficeId = row.office_id != null ? Number(row.office_id) : null;
  const effectiveOfficeId = documentOfficeId ?? patientOfficeId;
  if (effectiveOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(effectiveOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - document d\'un autre cabinet' });
      }
    }
  }

  const title = String(req.body?.title ?? '').trim();
  const comment = String(req.body?.comment ?? '').trim();

  db.prepare(
    `UPDATE patient_documents
     SET title_cipher = ?, comment_cipher = ?
     WHERE document_ref = ?`
  ).run(
    title ? encryptSensitiveField(title) : null,
    comment ? encryptSensitiveField(comment) : null,
    documentRef
  );

  return res.json({
    document: {
      id: Number(row.id),
      documentRef: row.document_ref,
      consultationId: row.consultation_id != null ? Number(row.consultation_id) : null,
      officeId: row.office_id != null ? Number(row.office_id) : null,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes) || 0,
      title,
      comment,
      createdAt: row.created_at,
      link: `/api/patient-documents/${encodeURIComponent(row.document_ref)}`
    }
  });
});

app.delete('/api/patient-documents/:documentRef', authMiddleware, requirePermission('create-patient-record'), (req, res) => {
  const documentRef = String(req.params.documentRef ?? '').trim();
  if (!documentRef) {
    return res.status(400).json({ message: 'Reference document invalide' });
  }

  const existing = db
    .prepare('SELECT id, patient_id, office_id FROM patient_documents WHERE document_ref = ? LIMIT 1')
    .get(documentRef);
  if (!existing) {
    return res.status(404).json({ message: 'Document introuvable' });
  }

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(Number(existing.patient_id));
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  const documentOfficeId = existing.office_id != null ? Number(existing.office_id) : null;
  const effectiveOfficeId = documentOfficeId ?? patientOfficeId;
  if (effectiveOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(effectiveOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - document d\'un autre cabinet' });
      }
    }
  }

  db.prepare('DELETE FROM patient_documents WHERE document_ref = ?').run(documentRef);
  return res.status(204).send();
});

app.get('/api/patients', authMiddleware, requireAnyPermission(['read-patient-list', 'manage-data-rgpd']), (req, res) => {
  const query = String(req.query.search ?? '').trim().toLowerCase();
  const requestedOfficeId = Number(req.query.officeId);

  const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  const accessibleOfficeIds = isAdmin ? null : getAccessibleBillingOfficeIds(req.userAccess);
  const selectedOfficeId = Number.isInteger(requestedOfficeId)
    && requestedOfficeId > 0
    && (isAdmin || accessibleOfficeIds.includes(requestedOfficeId))
    ? requestedOfficeId
    : null;

  const scopedOfficeIds = selectedOfficeId !== null
    ? [selectedOfficeId]
    : (isAdmin ? null : accessibleOfficeIds);

  const consultationCountByPatientId = new Map();
  if (scopedOfficeIds === null) {
    const rows = db
      .prepare(
        `SELECT patient_id, COUNT(*) AS consultation_count
         FROM appointments
         WHERE office_id IS NOT NULL
         GROUP BY patient_id`
      )
      .all();

    for (const row of rows) {
      const patientId = Number(row.patient_id);
      const consultationCount = Number(row.consultation_count ?? 0);
      if (Number.isInteger(patientId) && patientId > 0 && consultationCount > 0) {
        consultationCountByPatientId.set(patientId, consultationCount);
      }
    }
  } else if (scopedOfficeIds.length > 0) {
    const placeholders = scopedOfficeIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT patient_id, COUNT(*) AS consultation_count
         FROM appointments
         WHERE office_id IN (${placeholders})
         GROUP BY patient_id`
      )
      .all(...scopedOfficeIds);

    for (const row of rows) {
      const patientId = Number(row.patient_id);
      const consultationCount = Number(row.consultation_count ?? 0);
      if (Number.isInteger(patientId) && patientId > 0 && consultationCount > 0) {
        consultationCountByPatientId.set(patientId, consultationCount);
      }
    }
  }

  const rows = db
    .prepare(
      `SELECT id,
              cipher_full_name,
              cipher_phone,
              cipher_medical_notes,
              last_visit,
              sex,
              birth_date
       FROM patients
       WHERE is_deleted = 0`
    )
    .all();

  const patients = [];
  for (const row of rows) {
    const consultationCount = Number(consultationCountByPatientId.get(Number(row.id)) ?? 0);
    if (consultationCount <= 0) {
      continue;
    }

    const fullName = decryptSensitiveField(row.cipher_full_name);

    // Short-circuit before additional expensive decryptions/parsing when searching.
    if (query && !fullName.toLowerCase().includes(query)) {
      continue;
    }

    let city = '';
    try {
      const notes = JSON.parse(decryptSensitiveField(row.cipher_medical_notes));
      city = String(notes?.city ?? '').trim();
    } catch {
      // Ignore malformed notes payloads and keep city empty.
    }

    patients.push({
      id: row.id,
      fullName,
      phone: decryptSensitiveField(row.cipher_phone),
      lastVisit: row.last_visit ? formatDateFr(row.last_visit) : '',
      sex: row.sex === 'F' ? 'Femme' : row.sex === 'M' ? 'Homme' : 'Non renseigne',
      age: getAgeFromBirthDate(row.birth_date),
      city,
      consultationCount
    });
  }

  writeAuditLog(req.user.sub, 'READ_LIST', 'patients', null, {
    count: patients.length,
    officeId: selectedOfficeId
  });
  return res.json({ patients });
});

app.get('/api/patients/locations', authMiddleware, requirePermission('search-patient-list'), (req, res) => {
  const postalQuery = String(req.query.postalCode ?? '').trim().toLowerCase();
  const cityQuery = String(req.query.city ?? '').trim().toLowerCase();
  const requestedLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(5000, Math.floor(requestedLimit))) : 100;

  const rows = db
    .prepare('SELECT cipher_medical_notes, office_id FROM patients WHERE is_deleted = 0')
    .all();

  const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  const accessibleOfficeIds = isAdmin ? null : getAccessibleBillingOfficeIds(req.userAccess);

  const seen = new Set();
  const locations = [];

  for (const row of rows) {
    const patientOfficeId = row.office_id != null ? Number(row.office_id) : null;
    if (patientOfficeId !== null && !isAdmin && !accessibleOfficeIds.includes(patientOfficeId)) {
      continue;
    }

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
  const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  const accessibleOfficeIds = isAdmin ? null : getAccessibleBillingOfficeIds(req.userAccess);
  const rows = db.prepare('SELECT office_id FROM patients WHERE is_deleted = 0').all();
  const count = rows.filter((row) => {
    const patientOfficeId = row.office_id != null ? Number(row.office_id) : null;
    return patientOfficeId === null || isAdmin || accessibleOfficeIds.includes(patientOfficeId);
  }).length;

  return res.json({ count });
});

app.get('/api/patients/:id', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalide' });

  const row = db
    .prepare(
      `SELECT p.id, p.cipher_full_name, p.cipher_phone, p.cipher_medical_notes,
              p.sex, p.birth_date, p.marital_status, p.children_count, p.last_visit, p.office_id,
              p.consent_signed, p.consent_signed_at, p.consent_form_version, p.consent_withdrawn_at,
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

  const patientOfficeId = row.office_id != null ? Number(row.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

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
      lastVisit: row.last_visit ? formatDateFr(row.last_visit) : '',
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
      maritalStatus: notes.maritalStatus ?? row.marital_status ?? 'Non renseigne',
      childrenCount: Number.isFinite(Number(notes.childrenCount))
        ? Math.max(0, Number(notes.childrenCount))
        : Math.max(0, Number(row.children_count ?? 0)),
      occupationOrSchool: notes.occupationOrSchool ?? '',
      hobbies: notes.hobbies ?? '',
      primaryDoctor: notes.primaryDoctor ?? '',
      socialSecurityNumber: notes.socialSecurityNumber ?? '',
      referredBy: notes.referredBy ?? '',
      manualPreference: normalizeManualPreference(notes.manualPreference),
      generalRemarks: notes.generalRemarks ?? '',
      medicalHistory: notes.medicalHistory ?? '',
      relatedPeople: notes.relatedPeople ?? '',
      isDeceased: Boolean(notes.isDeceased),
      consentSigned: Boolean(row.consent_signed),
      consentSignedAt: row.consent_signed_at ?? null,
      consentFormVersion: row.consent_form_version ?? '1.0',
      consentOutdated: Boolean(
        row.consent_signed &&
        !row.consent_withdrawn_at &&
        (row.consent_form_version ?? '1.0') !== CURRENT_CONSENT_FORM_VERSION
      ),
      consentWithdrawnAt: row.consent_withdrawn_at ?? null
    }
  });
});

app.get('/api/patients/:id/consultations', authMiddleware, requirePermission('read-consultation-detail'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalide' });

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(id);
  if (!patient) return res.status(404).json({ message: 'Patient introuvable' });

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

  let consultationRows = [];
  try {
    consultationRows = db
      .prepare(
        `SELECT c.id, c.started_at, c.practitioner, c.title, c.important, c.height_cm, c.weight_kg,
                eva_before, eva_after, profile,
                (
                  SELECT i.id
                  FROM invoices i
                  WHERE i.consultation_id = c.id
                  ORDER BY i.id DESC
                  LIMIT 1
                ) AS billing_invoice_id
         FROM consultations c
         WHERE c.patient_id = ?
         ORDER BY c.started_at DESC`
      )
      .all(id);
  } catch { consultationRows = []; }

  const appointmentRows = db
    .prepare('SELECT id, starts_at, reason_cipher, status FROM appointments WHERE patient_id = ? ORDER BY starts_at DESC')
    .all(id);
  const consultationReasonItemsById = buildConsultationReasonItemsMap(consultationRows);
  const consultationSectionsById = buildConsultationSectionsMap(consultationRows);

  const consultations = consultationRows.map((row) => {
    const sections = consultationSectionsById.get(Number(row.id)) ?? buildEmptyConsultationSections();

    return {
      reasonItems: consultationReasonItemsById.get(Number(row.id)) ?? [],
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
      motifMainHtml: sections.motifMainHtml,
      testsHtml: sections.testsHtml,
      schemaHtml: sections.schemaHtml,
      treatmentsHtml: sections.treatmentsHtml,
      remarksHtml: sections.remarksHtml,
      status: 'Termine',
      billingInvoiceId: row.billing_invoice_id != null ? Number(row.billing_invoice_id) : null
    };
  });

  const consultationDates = new Set(consultations.map((c) => c.startedAt.slice(0, 10)));
  const appointments = appointmentRows
    .filter((row) => !consultationDates.has(row.starts_at.slice(0, 10)))
    .map((row) => ({
      reasonItems: [],
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
      status: row.status,
      billingInvoiceId: null
    }));

  const all = [...consultations, ...appointments].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return res.json({ consultations: all });
});

app.patch('/api/consultations/:id', authMiddleware, requirePermission('create-consultation'), (req, res) => {
  const consultationId = Number(req.params.id);
  if (!Number.isInteger(consultationId) || consultationId <= 0) {
    return res.status(400).json({ message: 'Identifiant consultation invalide' });
  }

  const parsed = updateConsultationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const consultation = db.prepare(
    `SELECT id, patient_id
     FROM consultations
     WHERE id = ?
     LIMIT 1`
  ).get(consultationId);

  if (!consultation) {
    return res.status(404).json({ message: 'Consultation introuvable' });
  }

  const payload = parsed.data;
  const normalizedReasonItems = normalizeConsultationReasonItems(payload.reasonItems);

  db.prepare(
    `UPDATE consultations
     SET started_at = ?,
         practitioner = ?,
         title = ?,
         important = ?,
         height_cm = ?,
         weight_kg = ?,
         eva_before = ?,
         eva_after = ?,
         profile = ?
     WHERE id = ?`
  ).run(
    payload.startedAt,
    payload.practitioner.trim(),
    payload.title.trim(),
    payload.important ? 1 : 0,
    payload.heightCm,
    payload.weightKg,
    payload.evaBefore,
    payload.evaAfter,
    payload.profile.trim() || 'Adulte',
    consultationId
  );
  replaceConsultationReasonItems(consultationId, normalizedReasonItems);
  replaceConsultationSections(consultationId, {
    motifMainHtml: payload.motifMainHtml,
    testsHtml: payload.testsHtml,
    schemaHtml: payload.schemaHtml,
    treatmentsHtml: payload.treatmentsHtml,
    remarksHtml: payload.remarksHtml
  });

  writeAuditLog(req.user.sub, 'UPDATE', 'consultations', String(consultationId), {
    patientId: Number(consultation.patient_id)
  });

  return res.json({
    consultation: {
      id: consultationId,
      type: 'consultation',
      startedAt: payload.startedAt,
      practitioner: payload.practitioner.trim(),
      title: payload.title.trim(),
      important: payload.important,
      heightCm: payload.heightCm,
      weightKg: payload.weightKg,
      evaBefore: payload.evaBefore,
      evaAfter: payload.evaAfter,
      profile: payload.profile.trim() || 'Adulte',
      reasonItems: normalizedReasonItems,
      motifMainHtml: payload.motifMainHtml,
      testsHtml: payload.testsHtml,
      schemaHtml: payload.schemaHtml,
      treatmentsHtml: payload.treatmentsHtml,
      remarksHtml: payload.remarksHtml,
      status: 'Termine',
      billingInvoiceId: null
    }
  });
});

app.post('/api/patients/:id/consultations', authMiddleware, requirePermission('create-consultation'), async (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'ID patient invalide' });
  }

  const patient = db.prepare('SELECT id FROM patients WHERE id = ? AND is_deleted = 0').get(patientId);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const parsed = createPatientConsultationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload invalide' });
  }

  const payload = parsed.data;

  let preValidatedDocuments = [];
  if (Array.isArray(payload.consultationDocuments) && payload.consultationDocuments.length > 0) {
    try {
      preValidatedDocuments = await normalizeConsultationDocumentsPayload(payload.consultationDocuments);
    } catch (err) {
      return res.status(415).json({ message: err.message || 'Type de fichier non autorisé' });
    }
  }

  const normalizedReasonItems = normalizeConsultationReasonItems(payload.reasonItems);

  const officeId = Number.isInteger(payload.officeId) && Number(payload.officeId) > 0
    ? Number(payload.officeId)
    : null;

  const inserted = db.prepare(
    `INSERT INTO consultations
      (patient_id, started_at, office_id, practitioner, title, important,
       height_cm, weight_kg, eva_before, eva_after, profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    patientId,
    payload.startedAt,
    officeId,
    payload.practitioner.trim(),
    payload.title.trim(),
    payload.important ? 1 : 0,
    payload.heightCm,
    payload.weightKg,
    payload.evaBefore,
    payload.evaAfter,
    payload.profile.trim() || 'Adulte'
  );

  const consultationId = Number(inserted.lastInsertRowid);
  replaceConsultationReasonItems(consultationId, normalizedReasonItems);
  replaceConsultationSections(consultationId, {
    motifMainHtml: payload.motifMainHtml,
    testsHtml: payload.testsHtml,
    schemaHtml: payload.schemaHtml,
    treatmentsHtml: payload.treatmentsHtml,
    remarksHtml: payload.remarksHtml
  });

  updatePatientRetentionFields(patientId, payload.startedAt);

  insertNormalizedDocuments(
    patientId,
    consultationId,
    officeId,
    req.user.sub,
    preValidatedDocuments
  );

  writeAuditLog(req.user.sub, 'CREATE', 'consultations', String(consultationId), {
    patientId,
    title: payload.title.trim()
  });

  return res.status(201).json({
    consultation: {
      id: consultationId,
      type: 'consultation',
      startedAt: payload.startedAt,
      practitioner: payload.practitioner.trim(),
      title: payload.title.trim(),
      important: payload.important,
      heightCm: payload.heightCm,
      weightKg: payload.weightKg,
      evaBefore: payload.evaBefore,
      evaAfter: payload.evaAfter,
      profile: payload.profile.trim() || 'Adulte',
      reasonItems: normalizedReasonItems,
      motifMainHtml: payload.motifMainHtml,
      testsHtml: payload.testsHtml,
      schemaHtml: payload.schemaHtml,
      treatmentsHtml: payload.treatmentsHtml,
      remarksHtml: payload.remarksHtml,
      status: 'Termine'
    }
  });
});

app.get('/api/patients/:id/audit-logs', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalide' });

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(id);
  if (!patient) return res.status(404).json({ message: 'Patient introuvable' });

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

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
              before: safeDecryptField(
                String(change?.beforeCipher ?? change?.before ?? '')
              ),
              after: safeDecryptField(
                String(change?.afterCipher ?? change?.after ?? '')
              )
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
    .prepare('SELECT cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, marital_status, children_count, office_id FROM patients WHERE id = ? AND is_deleted = 0')
    .get(id);
  if (!existing) return res.status(404).json({ message: 'Patient introuvable' });

  const patientOfficeId = existing.office_id != null ? Number(existing.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

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
    ...(data.maritalStatus !== undefined && { maritalStatus: data.maritalStatus }),
    ...(data.childrenCount !== undefined && { childrenCount: data.childrenCount }),
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
    maritalStatus: existingNotes.maritalStatus ?? existing.marital_status ?? 'Non renseigne',
    childrenCount: Number.isFinite(Number(existingNotes.childrenCount))
      ? Math.max(0, Number(existingNotes.childrenCount))
      : Math.max(0, Number(existing.children_count ?? 0)),
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
    maritalStatus: updatedNotes.maritalStatus ?? 'Non renseigne',
    childrenCount: Number.isFinite(Number(updatedNotes.childrenCount)) ? Math.max(0, Number(updatedNotes.childrenCount)) : 0,
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

  let changes = [];
  try {
    changes = buildPatientUpdateChanges(beforeSnapshot, afterSnapshot);
  } catch (error) {
    console.warn('Unable to build encrypted patient audit changes:', error instanceof Error ? error.message : error);
    changes = [];
  }

  db.prepare(
    `UPDATE patients SET
       cipher_full_name = ?,
       cipher_phone = ?,
       cipher_medical_notes = ?,
       sex = ?,
       birth_date = ?,
         marital_status = ?,
         children_count = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    encryptSensitiveField(fullName),
    encryptSensitiveField(newMainPhone),
    encryptSensitiveField(JSON.stringify(updatedNotes)),
    newSex,
    newBirthDate,
      String(updatedNotes.maritalStatus ?? 'Non renseigne').trim() || 'Non renseigne',
      Number.isFinite(Number(updatedNotes.childrenCount)) ? Math.max(0, Number(updatedNotes.childrenCount)) : 0,
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
  replacePatientAntecedents(id, String(updatedNotes.medicalHistory ?? ''));

  try {
    writeAuditLog(req.user.sub, 'UPDATE', 'patients', String(id), {
      changedFieldCount: changes.length,
      changes
    });
  } catch (error) {
    console.warn('Unable to write patient update audit log:', error instanceof Error ? error.message : error);
  }
  return res.status(204).send();
});

app.get('/api/patients/:id/export', authMiddleware, requireAnyPermission(['export-patient-record', 'manage-data-rgpd']), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const row = db
    .prepare(
      `SELECT id, cipher_full_name, cipher_phone, cipher_medical_notes,
              sex, birth_date, last_visit, consent_signed, consent_signed_at, consent_form_version, consent_withdrawn_at,
              retention_until, created_at, updated_at, office_id
       FROM patients WHERE id = ? AND is_deleted = 0`
    )
    .get(id);

  if (!row) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = row.office_id != null ? Number(row.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
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
                eva_before, eva_after, profile
         FROM consultations WHERE patient_id = ? ORDER BY started_at DESC`
      )
      .all(id);
  } catch {
    consultationRows = [];
  }

  const appointmentRows = db
    .prepare('SELECT id, starts_at, reason_cipher, status, created_at FROM appointments WHERE patient_id = ? ORDER BY starts_at DESC')
    .all(id);

  const consultationSectionsById = buildConsultationSectionsMap(consultationRows);
  const consultationReasonItemsById = buildConsultationReasonItemsMap(consultationRows);

  const antecedentRows = db
    .prepare(
      `SELECT id, date_precision, date_display, category, description, important, sort_key
       FROM patient_antecedents
       WHERE patient_id = ?
       ORDER BY sort_key DESC, id DESC`
    )
    .all(id);

  const antecedents = antecedentRows.map((row) => ({
    id: row.id,
    datePrecision: String(row.date_precision ?? 'date').trim() || 'date',
    date: safeDecryptField(row.date_display).trim(),
    category: String(row.category ?? '').trim(),
    description: safeDecryptField(row.description).trim(),
    important: Boolean(row.important)
  }));

  const consultations = consultationRows.map((consultation) => {
    const sections = consultationSectionsById.get(Number(consultation.id)) ?? buildEmptyConsultationSections();
    const reasonItems = consultationReasonItemsById.get(Number(consultation.id)) ?? [];

    return {
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
      reasonItems,
      motifMain: sections.motifMainHtml,
      tests: sections.testsHtml,
      schema: sections.schemaHtml,
      treatments: sections.treatmentsHtml,
      remarks: sections.remarksHtml
    };
  });

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

    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      if (Object.prototype.hasOwnProperty.call(metadata, 'nameCipher')) {
        const { nameCipher, ...rest } = metadata;
        let fullName;
        try {
          fullName = decryptSensitiveField(String(nameCipher ?? ''));
        } catch {
          fullName = '[données non disponibles]';
        }
        metadata = { ...rest, fullName };
      }
    }

    return {
      id: entry.id,
      at: entry.created_at,
      action: entry.action,
      by: entry.username ?? 'system',
      metadata
    };
  });

  const paymentCreditRows = db
    .prepare(
      `SELECT id, paid_at, amount_cents, remaining_cents, currency, payment_method,
              bank_name_cipher, cheque_number, reference, notes, created_at
       FROM patient_payment_credits
       WHERE patient_id = ?
       ORDER BY paid_at ASC, id ASC`
    )
    .all(id);

  const paymentCredits = paymentCreditRows.map((credit) => ({
    id: credit.id,
    paidAt: credit.paid_at,
    amountCents: Number(credit.amount_cents ?? 0),
    remainingCents: Number(credit.remaining_cents ?? 0),
    currency: String(credit.currency ?? 'EUR').trim() || 'EUR',
    paymentMethod: String(credit.payment_method ?? '').trim(),
    bankName: safeDecryptField(credit.bank_name_cipher ?? '').trim(),
    chequeNumber: String(credit.cheque_number ?? '').trim(),
    reference: String(credit.reference ?? '').trim(),
    notes: String(credit.notes ?? '').trim(),
    createdAt: credit.created_at
  }));

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
      lastVisit: row.last_visit ? formatDateFr(row.last_visit) : '',
      consentSigned: Boolean(row.consent_signed),
      consentSignedAt: row.consent_signed_at ?? null,
      consentFormVersion: row.consent_form_version ?? '1.0',
      consentWithdrawnAt: row.consent_withdrawn_at ?? null,
      retentionUntil: row.retention_until ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    },
    appointments,
    antecedents,
    consultations,
    paymentCredits,
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

app.post('/api/patients/:id/withdraw-consent', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const patient = db.prepare('SELECT id, consent_withdrawn_at, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(id);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

  if (patient.consent_withdrawn_at) {
    return res.status(409).json({ message: 'Le consentement a déjà été retiré' });
  }

  const withdrawnAt = new Date().toISOString();
  // Record consent withdrawal timestamp first, then immediately anonymize the patient
  // (RGPD Article 17: erasure without undue delay upon consent withdrawal)
  db.prepare(
    'UPDATE patients SET consent_withdrawn_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(withdrawnAt, id);

  anonymizePatientTx(id);

  writeAuditLog(req.user.sub, 'WITHDRAW_CONSENT', 'patients', String(id));

  return res.status(200).json({ consentWithdrawnAt: withdrawnAt });
});

app.post('/api/patients/:id/update-consent', authMiddleware, requirePermission('read-patient-record'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const patient = db.prepare('SELECT id, consent_withdrawn_at, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(id);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  if (patient.consent_withdrawn_at) {
    return res.status(409).json({ message: 'Impossible de mettre à jour le consentement d\'un patient dont le consentement a été retiré' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - patient d\'un autre cabinet' });
      }
    }
  }

  const signedAt = new Date().toISOString();
  db.prepare(
    `UPDATE patients
     SET consent_signed = 1,
         consent_signed_at = ?,
         consent_form_version = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(signedAt, CURRENT_CONSENT_FORM_VERSION, id);

  writeAuditLog(req.user.sub, 'UPDATE_CONSENT', 'patients', String(id), {
    consentFormVersion: CURRENT_CONSENT_FORM_VERSION
  });

  return res.status(200).json({ consentSignedAt: signedAt, consentFormVersion: CURRENT_CONSENT_FORM_VERSION });
});

app.post('/api/patients/:id/anonymize', authMiddleware, adminOnlyMiddleware, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Identifiant patient invalide' });
  }

  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(id);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  anonymizePatientTx(id);

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

function computePatientRetentionDateIso() {
  const retentionDate = new Date();
  retentionDate.setFullYear(retentionDate.getFullYear() + 10);
  return retentionDate.toISOString().slice(0, 10);
}

function buildDefaultPatientNotes() {
  return {
    generalRemarks: '',
    medicalHistory: '',
    consultationNote: '',
    relatedPeople: '',
    mobilePhone: '',
    landlinePhone: '',
    email: '',
    address1: '',
    address2: '',
    postalCode: '',
    city: '',
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
}

function findOrCreateQuickPatientForAppointment(lastName, firstName, officeId) {
  const normalizedLastName = String(lastName ?? '').trim();
  const normalizedFirstName = String(firstName ?? '').trim();
  const fullName = `${normalizedLastName} ${normalizedFirstName}`.trim().replace(/\s+/g, ' ');

  if (!fullName) {
    return null;
  }

  const fullNameKey = normalizePersonNameKey(fullName);
  const normalizedOfficeId = Number.isInteger(Number(officeId)) && Number(officeId) > 0 ? Number(officeId) : null;
  const rows = normalizedOfficeId === null
    ? db.prepare('SELECT id, cipher_full_name FROM patients WHERE is_deleted = 0').all()
    : db.prepare('SELECT id, cipher_full_name FROM patients WHERE is_deleted = 0 AND office_id = ?').all(normalizedOfficeId);

  for (const row of rows) {
    let rowName = '';
    try {
      rowName = decryptSensitiveField(row.cipher_full_name);
    } catch {
      rowName = '';
    }

    if (normalizePersonNameKey(rowName) === fullNameKey) {
      return Number(row.id);
    }
  }

  const notes = buildDefaultPatientNotes();
  const inserted = db
    .prepare(
      `INSERT INTO patients
       (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, marital_status, children_count, last_visit, consent_signed, retention_until, office_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      encryptSensitiveField(fullName),
      encryptSensitiveField('Non renseigne'),
      encryptSensitiveField(JSON.stringify(notes)),
      'Non renseigne',
      null,
      'Non renseigne',
      0,
      null,
      1,
      computePatientRetentionDateIso(),
      normalizedOfficeId
    );

  return Number(inserted.lastInsertRowid);
}

function findOrCreatePrivatePlaceholderPatient(officeId) {
  const normalizedOfficeId = Number.isInteger(Number(officeId)) && Number(officeId) > 0 ? Number(officeId) : null;
  const rows = normalizedOfficeId === null
    ? db.prepare('SELECT id, cipher_medical_notes FROM patients WHERE is_deleted = 1').all()
    : db.prepare('SELECT id, cipher_medical_notes FROM patients WHERE is_deleted = 1 AND office_id = ?').all(normalizedOfficeId);

  for (const row of rows) {
    const notes = parsePatientNotesFromCipher(row.cipher_medical_notes);
    if (String(notes.systemPlaceholder ?? '').trim() === 'private-appointment') {
      return Number(row.id);
    }
  }

  const notes = {
    ...buildDefaultPatientNotes(),
    systemPlaceholder: 'private-appointment'
  };

  const inserted = db
    .prepare(
      `INSERT INTO patients
       (cipher_full_name, cipher_phone, cipher_medical_notes, sex, birth_date, marital_status, children_count, last_visit, consent_signed, retention_until, is_deleted, office_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      encryptSensitiveField('Rendez-vous prive'),
      encryptSensitiveField('Non renseigne'),
      encryptSensitiveField(JSON.stringify(notes)),
      'Non renseigne',
      null,
      'Non renseigne',
      0,
      null,
      1,
      computePatientRetentionDateIso(),
      1,
      normalizedOfficeId
    );

  return Number(inserted.lastInsertRowid);
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
              a.is_private, a.private_label_cipher,
              p.cipher_full_name
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
       WHERE a.is_private = 1 OR (p.id IS NOT NULL AND p.is_deleted = 0)
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
      isPrivate: Number(row.is_private) === 1,
      id: Number(row.id),
      time: new Intl.DateTimeFormat('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(row.starts_at)),
      patient: Number(row.is_private) === 1 ? 'Prive' : decryptSensitiveField(row.cipher_full_name),
      reason: decryptSensitiveField(row.reason_cipher),
      status: row.status
    }));

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDay = now.getDate();
  const monthStart = new Date(currentYear, currentMonth, 1);
  const nextMonthStart = new Date(currentYear, currentMonth + 1, 1);
  const monthStartIso = monthStart.toISOString();
  const nextMonthStartIso = nextMonthStart.toISOString();

  const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  const accessibleOfficeIds = isAdmin ? [] : getAccessibleBillingOfficeIds(req.userAccess);

  const consultationsToday = rows
    .filter((row) => {
      const rowCalendarId = row.local_calendar_id != null ? Number(row.local_calendar_id) : null;
      const effectiveCalendarId = rowCalendarId ?? (fallbackCalendar?.id ?? null);
      if (effectiveCalendarId == null || !accessibleCalendarIds.has(effectiveCalendarId)) {
        return false;
      }

      const startsAt = new Date(row.starts_at);
      if (Number.isNaN(startsAt.getTime())) {
        return false;
      }

      return startsAt.getFullYear() === currentYear
        && startsAt.getMonth() === currentMonth
        && startsAt.getDate() === currentDay;
    })
    .length;

  let newPatients = 0;

  if (officeIdFilter !== null) {
    newPatients = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM patients
           WHERE is_deleted = 0
             AND office_id = ?
             AND created_at >= ?
             AND created_at < ?`
        )
        .get(officeIdFilter, monthStartIso, nextMonthStartIso)?.count ?? 0
    );
  } else if (isAdmin) {
    newPatients = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM patients
           WHERE is_deleted = 0
             AND created_at >= ?
             AND created_at < ?`
        )
        .get(monthStartIso, nextMonthStartIso)?.count ?? 0
    );
  } else if (accessibleOfficeIds.length > 0) {
    const placeholders = accessibleOfficeIds.map(() => '?').join(', ');
    newPatients = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM patients
           WHERE is_deleted = 0
             AND created_at >= ?
             AND created_at < ?
             AND (office_id IN (${placeholders}) OR office_id IS NULL)`
        )
        .get(monthStartIso, nextMonthStartIso, ...accessibleOfficeIds)?.count ?? 0
    );
  }

  const rollingWindowEnd = new Date();
  const rollingWindowStart = new Date(rollingWindowEnd);
  rollingWindowStart.setDate(rollingWindowStart.getDate() - 30);

  const calendarsById = new Map(agendaConfig.localCalendars.map((calendar) => [Number(calendar.id), calendar]));
  const scopedOfficeIds = Array.from(
    new Set(
      agendaConfig.localCalendars
        .filter((calendar) => accessibleCalendarIds.has(Number(calendar.id)))
        .map((calendar) => (calendar.officeId != null ? Number(calendar.officeId) : null))
        .filter((officeId) => Number.isInteger(officeId) && officeId > 0)
    )
  );

  const officeOpeningHoursById = new Map();
  if (scopedOfficeIds.length > 0) {
    const placeholders = scopedOfficeIds.map(() => '?').join(', ');
    const officeRows = db
      .prepare(`SELECT id, opening_hours_json FROM offices WHERE id IN (${placeholders})`)
      .all(...scopedOfficeIds);

    for (const officeRow of officeRows) {
      const officeId = Number(officeRow.id);
      if (!Number.isInteger(officeId) || officeId <= 0) {
        continue;
      }
      officeOpeningHoursById.set(officeId, parseOfficeOpeningHours(officeRow.opening_hours_json));
    }
  }

  const parseTimeToMinutes = (value) => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!match) {
      return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }

    return (hours * 60) + minutes;
  };

  const getDayOpenIntervals = (date) => {
    const dayKey = OFFICE_OPENING_DAY_KEYS[(date.getDay() + 6) % 7];
    const startBound = (agendaConfig.settings.dayStartHour ?? 8) * 60;
    const endBound = (agendaConfig.settings.dayEndHour ?? 20) * 60;

    const intervals = [];
    for (const officeId of scopedOfficeIds) {
      const openingHours = officeOpeningHoursById.get(officeId);
      const ranges = Array.isArray(openingHours?.[dayKey]) ? openingHours[dayKey] : [];
      for (const range of ranges) {
        const start = parseTimeToMinutes(range.start);
        const end = parseTimeToMinutes(range.end);
        if (start == null || end == null || end <= start) {
          continue;
        }

        const clampedStart = Math.max(startBound, start);
        const clampedEnd = Math.min(endBound, end);
        if (clampedEnd <= clampedStart) {
          continue;
        }

        intervals.push({ start: clampedStart, end: clampedEnd });
      }
    }

    if (intervals.length === 0) {
      return [];
    }

    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (!last || interval.start > last.end) {
        merged.push({ ...interval });
      } else {
        last.end = Math.max(last.end, interval.end);
      }
    }

    return merged;
  };

  let consultationsRollingMonth = 0;
  for (const row of rows) {
    const rowCalendarId = row.local_calendar_id != null ? Number(row.local_calendar_id) : null;
    const effectiveCalendarId = rowCalendarId ?? (fallbackCalendar?.id ?? null);
    if (effectiveCalendarId == null || !accessibleCalendarIds.has(effectiveCalendarId)) {
      continue;
    }

    const startsAt = new Date(row.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      continue;
    }

    if (startsAt >= rollingWindowStart && startsAt <= rollingWindowEnd) {
      consultationsRollingMonth += 1;
    }
  }

  let openMinutesRollingMonth = 0;
  if (scopedOfficeIds.length > 0) {
    const dayCursor = new Date(rollingWindowStart);
    dayCursor.setHours(0, 0, 0, 0);
    const endDay = new Date(rollingWindowEnd);
    endDay.setHours(0, 0, 0, 0);

    while (dayCursor <= endDay) {
      const dayStart = new Date(dayCursor);
      const dayEnd = new Date(dayCursor);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const sliceStart = new Date(Math.max(dayStart.getTime(), rollingWindowStart.getTime()));
      const sliceEnd = new Date(Math.min(dayEnd.getTime(), rollingWindowEnd.getTime()));

      if (sliceEnd > sliceStart) {
        const intervals = getDayOpenIntervals(dayCursor);
        for (const interval of intervals) {
          const intervalStart = new Date(dayCursor);
          intervalStart.setHours(0, 0, 0, 0);
          intervalStart.setMinutes(interval.start);

          const intervalEnd = new Date(dayCursor);
          intervalEnd.setHours(0, 0, 0, 0);
          intervalEnd.setMinutes(interval.end);

          const effectiveStart = new Date(Math.max(intervalStart.getTime(), sliceStart.getTime()));
          const effectiveEnd = new Date(Math.min(intervalEnd.getTime(), sliceEnd.getTime()));
          if (effectiveEnd > effectiveStart) {
            openMinutesRollingMonth += (effectiveEnd.getTime() - effectiveStart.getTime()) / 60000;
          }
        }
      }

      dayCursor.setDate(dayCursor.getDate() + 1);
    }
  }

  const defaultSessionDurationMinutes = Math.max(5, Number(agendaConfig.settings.defaultSessionDurationMinutes ?? 30));
  const theoreticalCapacity = openMinutesRollingMonth / defaultSessionDurationMinutes;
  const occupancyPercent = theoreticalCapacity > 0
    ? Math.max(0, Math.min(100, (consultationsRollingMonth / theoreticalCapacity) * 100))
    : 0;
  const occupancyRate = `${occupancyPercent.toFixed(1).replace('.', ',')}%`;

  const stats = {
    consultationsToday,
    newPatients,
    occupancyRate
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

app.post('/api/appointments', authMiddleware, requirePermission('create-appointment'), (req, res) => {
  const {
    patientId,
    patientFirstName,
    patientLastName,
    isPrivate,
    privateReason,
    practitioner,
    startsAt,
    reason,
    status,
    localCalendarId,
    consultationId,
    officeId
  } = req.body;

  // Validate required fields
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

  const isPrivateAppointment = isPrivate === true || isPrivate === 1 || isPrivate === '1';
  const trimmedPrivateReason = String(privateReason ?? '').trim();
  if (isPrivateAppointment && !trimmedPrivateReason) {
    return res.status(400).json({ error: 'Invalid privateReason' });
  }

  const trimmedPractitioner = String(practitioner ?? '').trim().slice(0, 120);

  const userOfficeIds = new Set(Array.isArray(req.userAccess?.officeIds) ? req.userAccess.officeIds : []);
  let effectiveOfficeId = Number.isInteger(Number(officeId)) && Number(officeId) > 0 ? Number(officeId) : null;
  if (effectiveOfficeId !== null && userOfficeIds.size > 0 && !userOfficeIds.has(effectiveOfficeId)) {
    return res.status(403).json({ error: 'Office access denied' });
  }

  let effectiveCalendarId = Number.isInteger(Number(localCalendarId)) && Number(localCalendarId) > 0 ? Number(localCalendarId) : null;

  if (effectiveCalendarId !== null) {
    const calendar = db
      .prepare('SELECT id, office_id FROM local_calendars WHERE id = ?')
      .get(effectiveCalendarId);
    if (!calendar) {
      return res.status(404).json({ error: 'Calendar not found' });
    }

    const accessibleCalendarIds = new Set(getAccessibleCalendarIdsForUser(req.user.sub, effectiveOfficeId));
    if (!accessibleCalendarIds.has(effectiveCalendarId)) {
      return res.status(403).json({ error: 'Calendar access denied' });
    }

    const calendarOfficeId = calendar.office_id != null ? Number(calendar.office_id) : null;
    if (calendarOfficeId !== null) {
      effectiveOfficeId = calendarOfficeId;
    }
  } else {
    const fallbackCalendar = getDefaultCalendarForUser(req.user.sub, effectiveOfficeId);
    if (fallbackCalendar) {
      effectiveCalendarId = fallbackCalendar.id;
      if (fallbackCalendar.officeId != null) {
        effectiveOfficeId = Number(fallbackCalendar.officeId);
      }
    }
  }

  const effectiveConsultationId = Number.isInteger(Number(consultationId)) && Number(consultationId) > 0 ? Number(consultationId) : null;

  let effectivePatientId = null;
  if (isPrivateAppointment) {
    effectivePatientId = findOrCreatePrivatePlaceholderPatient(effectiveOfficeId);
  } else if (Number.isInteger(Number(patientId)) && Number(patientId) > 0) {
    const patient = db.prepare('SELECT id FROM patients WHERE id = ? AND is_deleted = 0').get(Number(patientId));
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    effectivePatientId = Number(patientId);
  } else {
    const quickPatientId = findOrCreateQuickPatientForAppointment(patientLastName, patientFirstName, effectiveOfficeId);
    if (!Number.isInteger(quickPatientId) || quickPatientId <= 0) {
      return res.status(400).json({ error: 'Patient information required' });
    }
    effectivePatientId = quickPatientId;
  }

  if (effectiveConsultationId !== null) {
    if (isPrivateAppointment) {
      return res.status(400).json({ error: 'Private appointment cannot link consultation' });
    }

    const consultation = db
      .prepare('SELECT id, patient_id FROM consultations WHERE id = ?')
      .get(effectiveConsultationId);
    if (!consultation) {
      return res.status(404).json({ error: 'Consultation not found' });
    }
    if (Number(consultation.patient_id) !== Number(effectivePatientId)) {
      return res.status(400).json({ error: 'Consultation does not belong to patient' });
    }
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO appointments (
           patient_id, starts_at, reason_cipher, status, local_calendar_id, consultation_id, office_id,
           practitioner, is_private, private_label_cipher
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        effectivePatientId,
        startsAt,
        encryptSensitiveField(reason.trim()),
        status,
        effectiveCalendarId,
        effectiveConsultationId,
        effectiveOfficeId,
        trimmedPractitioner,
        isPrivateAppointment ? 1 : 0,
        isPrivateAppointment ? encryptSensitiveField(trimmedPrivateReason) : encryptSensitiveField('')
      );

    const newAppointment = db
      .prepare(
        `SELECT a.id, a.starts_at, a.reason_cipher, a.status, a.local_calendar_id, a.is_private,
                p.cipher_full_name
         FROM appointments a
         LEFT JOIN patients p ON p.id = a.patient_id
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
        patient: Number(newAppointment.is_private) === 1 ? 'Prive' : decryptSensitiveField(newAppointment.cipher_full_name),
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

  const officeIds = Array.from(
    new Set(
      agendaConfig.localCalendars
        .map((calendar) => (calendar?.officeId != null ? Number(calendar.officeId) : null))
        .filter((officeId) => Number.isInteger(officeId) && officeId > 0)
    )
  );

  const officeOpeningHoursById = {};
  if (officeIds.length > 0) {
    const placeholders = officeIds.map(() => '?').join(', ');
    const officeRows = db
      .prepare(`SELECT id, opening_hours_json FROM offices WHERE id IN (${placeholders})`)
      .all(...officeIds);

    for (const row of officeRows) {
      const officeId = Number(row.id);
      if (!Number.isInteger(officeId) || officeId <= 0) {
        continue;
      }
      officeOpeningHoursById[officeId] = parseOfficeOpeningHours(row.opening_hours_json);
    }
  }

  const appointmentRows = db
    .prepare(
      `SELECT a.id, a.starts_at, a.reason_cipher, a.status, a.local_calendar_id,
              a.is_private, a.private_label_cipher, a.practitioner,
              a.patient_id,
              p.cipher_full_name, p.cipher_phone, p.cipher_medical_notes, p.sex,
              c.id AS consultation_id, c.title AS consultation_title, c.practitioner AS consultation_practitioner
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
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
       WHERE a.is_private = 1 OR (p.id IS NOT NULL AND p.is_deleted = 0)
       ORDER BY a.starts_at ASC, a.id ASC`
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

  const firstAppointmentIdByPatient = new Map();
  for (const row of appointmentRows) {
    const isPrivate = Number(row.is_private) === 1;
    if (isPrivate) {
      continue;
    }

    const patientId = Number(row.patient_id);
    if (!Number.isInteger(patientId) || patientId <= 0 || firstAppointmentIdByPatient.has(patientId)) {
      continue;
    }

    firstAppointmentIdByPatient.set(patientId, Number(row.id));
  }

  const events = filteredAppointmentRows
    .map((row) => {
      const isPrivate = Number(row.is_private) === 1;
      const reason = decryptSensitiveField(row.reason_cipher);
      const privateReason = isPrivate ? decryptSensitiveField(row.private_label_cipher) : '';
      const patient = isPrivate ? 'Prive' : decryptSensitiveField(row.cipher_full_name);
      const patientPhone = !isPrivate && row.cipher_phone ? decryptSensitiveField(row.cipher_phone) : '';
      const notes = !isPrivate ? parsePatientNotesFromCipher(row.cipher_medical_notes) : {};
      const patientSex = isPrivate ? 'Non renseigne' : normalizePatientSexLabel(row.sex);
      const patientMobilePhone = String(notes.mobilePhone ?? patientPhone ?? '').trim();
      const patientLandlinePhone = String(notes.landlinePhone ?? '').trim();
      const patientRemarks = String(notes.generalRemarks ?? '').trim();
      const consultationType = agendaConfig.settings.autoConsultationType ? inferConsultationType(reason) : '';
      const rowCalendarId = row.local_calendar_id != null ? Number(row.local_calendar_id) : null;
      const calendar = rowCalendarId != null ? (calendarById.get(rowCalendarId) ?? fallbackCalendar) : fallbackCalendar;
      const effectiveCalendarId = calendar?.id ?? null;
      const patientId = Number(row.patient_id);
      const isNewPatient = !isPrivate
        && Number.isInteger(patientId)
        && patientId > 0
        && Number(firstAppointmentIdByPatient.get(patientId)) === Number(row.id);

      return {
        id: Number(row.id),
        patientId,
        title: reason,
        start: row.starts_at,
        patient,
        isNewPatient,
        isPrivate,
        privateReason,
        reason,
        status: row.status,
        calendarId: effectiveCalendarId,
        calendarColor: calendar?.colorHex ?? null,
        practitionerColor,
        patientSex,
        patientMobilePhone,
        patientLandlinePhone,
        appointmentComment: isPrivate ? privateReason : reason,
        patientRemarks,
        consultationType,
        consultationId: row.consultation_id != null ? Number(row.consultation_id) : null,
        consultationTitle: String(row.consultation_title ?? '').trim(),
        consultationPractitioner: String(row.consultation_practitioner ?? '').trim() || String(row.practitioner ?? '').trim()
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
  const ageRanges = ['0-17', '18-29', '30-44', '45-59', '60+', 'Non renseigne'];
  const ageMap = new Map(ageRanges.map((label) => [label, 0]));
  const ageSexMap = new Map(
    ageRanges.map((label) => [
      label,
      {
        femaleCount: 0,
        maleCount: 0,
        unknownCount: 0
      }
    ])
  );

  for (const row of patientRows) {
    const normalizedSex = row.sex === 'F' ? 'Femme' : row.sex === 'M' ? 'Homme' : 'Non renseigne';
    sexMap.set(normalizedSex, Number(sexMap.get(normalizedSex)) + 1);

    const ageRange = getAgeRangeFromBirthDate(row.birth_date);
    ageMap.set(ageRange, Number(ageMap.get(ageRange)) + 1);

    const rangeEntry = ageSexMap.get(ageRange);
    if (rangeEntry) {
      if (normalizedSex === 'Femme') {
        rangeEntry.femaleCount += 1;
      } else if (normalizedSex === 'Homme') {
        rangeEntry.maleCount += 1;
      } else {
        rangeEntry.unknownCount += 1;
      }
    }
  }

  const patientsBySex = Array.from(sexMap.entries()).map(([label, count]) => ({ label, count }));
  const patientsByAgeRange = Array.from(ageMap.entries()).map(([label, count]) => ({ label, count }));
  const patientsByAgeRangeAndSex = ageRanges.map((label) => {
    const counts = ageSexMap.get(label) ?? { femaleCount: 0, maleCount: 0, unknownCount: 0 };
    return {
      label,
      femaleCount: counts.femaleCount,
      maleCount: counts.maleCount,
      unknownCount: counts.unknownCount,
      totalCount: counts.femaleCount + counts.maleCount + counts.unknownCount
    };
  });

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
      `SELECT i.invoice_number, i.amount_cents, i.due_at, i.status, i.office_id, i.patient_id, i.consultation_id, p.cipher_full_name
       FROM invoices i
       INNER JOIN patients p ON p.id = i.patient_id
       WHERE p.is_deleted = 0 AND i.status != 'payee'
       ORDER BY i.due_at ASC`
    )
    .all()
    .filter((row) => {
      const rowOfficeId = row.office_id != null ? Number(row.office_id) : null;
      
      // Admins and super-admins see all invoices
      if (req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID) {
        return true;
      }
      
      // If a specific office is requested, only show invoices from that office
      if (officeIdFilter !== null) {
        return rowOfficeId === officeIdFilter;
      }

      // Get user's accessible offices with defensive null checking
      const userAccess = req.userAccess;
      const accessibleOfficeIds = userAccess ? getAccessibleBillingOfficeIds(userAccess) : [];
      
      if (!Array.isArray(accessibleOfficeIds) || accessibleOfficeIds.length === 0) {
        return true;
      }

      if (rowOfficeId === null) {
        return true;
      }

      return accessibleOfficeIds.includes(rowOfficeId);
    })
    .map((row) => ({
      invoiceNumber: row.invoice_number,
      patientId: Number(row.patient_id),
      consultationId: row.consultation_id != null ? Number(row.consultation_id) : null,
      patientName: decryptSensitiveField(row.cipher_full_name),
      amountEur: Number((row.amount_cents / 100).toFixed(2)),
      dueAt: formatDateFr(row.due_at),
      sortAt: String(row.due_at ?? ''),
      status: row.status
    }));

  const pendingConsultationsWithoutInvoice = db
    .prepare(
      `SELECT c.id AS consultation_id, c.started_at, c.office_id, p.id AS patient_id, p.cipher_full_name
       FROM consultations c
       INNER JOIN patients p ON p.id = c.patient_id
       WHERE p.is_deleted = 0
         AND NOT EXISTS (
           SELECT 1
           FROM invoices i
           WHERE i.consultation_id = c.id
         )
       ORDER BY datetime(c.started_at) DESC`
    )
    .all()
    .filter((row) => {
      const rowOfficeId = row.office_id != null ? Number(row.office_id) : null;
      
      // Admins and super-admins see all consultations
      if (req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID) {
        return true;
      }
      
      // If a specific office is requested, only show consultations from that office
      if (officeIdFilter !== null) {
        return rowOfficeId === officeIdFilter;
      }

      // Get user's accessible offices with defensive null checking
      const userAccess = req.userAccess;
      const accessibleOfficeIds = userAccess ? getAccessibleBillingOfficeIds(userAccess) : [];
      
      if (!Array.isArray(accessibleOfficeIds) || accessibleOfficeIds.length === 0) {
        return true;
      }

      if (rowOfficeId === null) {
        return true;
      }

      return accessibleOfficeIds.includes(rowOfficeId);
    })
    .map((row) => ({
      invoiceNumber: `CONS-${Number(row.consultation_id)}`,
      patientId: Number(row.patient_id),
      consultationId: Number(row.consultation_id),
      patientName: decryptSensitiveField(row.cipher_full_name),
      amountEur: 0,
      dueAt: formatDateFr(row.started_at),
      sortAt: String(row.started_at ?? ''),
      status: 'impayee'
    }));

  const allPendingPayments = [...pendingPayments, ...pendingConsultationsWithoutInvoice]
    .sort((left, right) => left.sortAt.localeCompare(right.sortAt))
    .map(({ sortAt, ...item }) => item);

  writeAuditLog(req.user.sub, 'READ_DASHBOARD', 'dashboard', null, {
    events: events.length,
    recentPatients: recentPatients.length,
    pendingPayments: allPendingPayments.length
  });

  return res.json({
    events,
    monthlyConsultations,
    patientsBySex,
    patientsByAgeRange,
    patientsByAgeRangeAndSex,
    recentPatients,
    pendingPayments: allPendingPayments,
    agendaSettings: agendaConfig.settings,
    localCalendars: agendaConfig.localCalendars,
    officeOpeningHoursById
  });
});

app.get('/api/appointments/:id/patient', authMiddleware, requirePermission('read-dashboard'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID de rendez-vous invalide' });
  }

  const row = db.prepare('SELECT patient_id, office_id, is_private FROM appointments WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ message: 'Rendez-vous introuvable' });
  }

  if (Number(row.is_private) === 1) {
    return res.status(404).json({ message: 'Ce rendez-vous prive n\'est pas lie a une fiche patient.' });
  }

  const appointmentOfficeId = row.office_id != null ? Number(row.office_id) : null;
  if (appointmentOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(appointmentOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - rendez-vous d\'un autre cabinet' });
      }
    }
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
    .prepare('SELECT id, patient_id, starts_at, consultation_id, office_id FROM appointments WHERE id = ?')
    .get(id);

  if (!appointment) {
    return res.status(404).json({ message: 'Rendez-vous introuvable' });
  }

  const appointmentOfficeId = appointment.office_id != null ? Number(appointment.office_id) : null;
  if (appointmentOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(appointmentOfficeId)) {
        return res.status(403).json({ message: 'Accès refusé - rendez-vous d\'un autre cabinet' });
      }
    }
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
           patient_id, started_at, office_id, practitioner, title, important,
           eva_before, eva_after, profile
         ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'Adulte')`
      )
      .run(appointment.patient_id, appointment.starts_at, appointmentOfficeId, practitioner, title);
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

function parseBillingOperationId(rawValue) {
  const value = String(rawValue ?? '').trim();
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  const sourceType = value.slice(0, separatorIndex);
  const sourceId = Number(value.slice(separatorIndex + 1));
  if (!['invoice', 'expense', 'deposit'].includes(sourceType)) {
    return null;
  }
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    return null;
  }

  return { sourceType, sourceId };
}

function normalizeBillingPaymentMethod(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function billingPaymentMethodMatchesDepositType(rawMethod, depositType) {
  const method = normalizeBillingPaymentMethod(rawMethod);
  if (!method) {
    return false;
  }

  if (depositType === 'cheque') {
    return method.includes('cheq') || method.includes('chq');
  }

  return method.includes('espece') || method.includes('cash') || method.includes('liquide');
}

function buildBillingDateRange(fromRaw, toRaw) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const parsedFrom = new Date(String(fromRaw ?? '').trim());
  const parsedTo = new Date(String(toRaw ?? '').trim());

  const from = Number.isNaN(parsedFrom.getTime()) ? monthStart : parsedFrom;
  const to = Number.isNaN(parsedTo.getTime()) ? monthEnd : parsedTo;

  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);

  return {
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString()
  };
}

function getAccessibleBillingOfficeIds(access) {
  return [...new Set(
    (Array.isArray(access?.officeIds) ? access.officeIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];
}

function getScopedBillingOfficeIds(access, requestedOfficeId) {
  const allowed = new Set(getAccessibleBillingOfficeIds(access));
  const asked = Number(requestedOfficeId);
  if (Number.isInteger(asked) && asked > 0) {
    return allowed.has(asked) ? [asked] : [];
  }
  return [...allowed];
}

function normalizeInvoiceLineItems(rawItems, fallbackAmountCents) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const normalized = items
    .map((item, index) => {
      const label = String(item?.label ?? '').trim();
      const quantity = Number(item?.quantity ?? 0);
      const unitAmountHtCents = Math.round(Number(item?.unitAmountHtCents ?? 0));
      const vatRate = Number(item?.vatRate ?? 0);
      const displayOrder = Number.isInteger(Number(item?.displayOrder))
        ? Number(item.displayOrder)
        : index;

      if (!label || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitAmountHtCents) || unitAmountHtCents < 0) {
        return null;
      }

      return {
        label,
        quantity,
        unitAmountHtCents,
        vatRate: Number.isFinite(vatRate) ? vatRate : 0,
        displayOrder
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) {
    return normalized;
  }

  return [{
    label: 'Consultation',
    quantity: 1,
    unitAmountHtCents: Math.max(0, Math.round(Number(fallbackAmountCents ?? 0))),
    vatRate: 0,
    displayOrder: 0
  }];
}

function normalizeInvoicePayments(rawPayments, fallbackPaymentMethod, fallbackCurrency, amountCents, issuedAt) {
  const payments = Array.isArray(rawPayments) ? rawPayments : [];
  const normalized = payments
    .map((item) => {
      const amountCentsValue = Math.round(Number(item?.amountCents ?? 0));
      const paidAt = String(item?.paidAt ?? issuedAt ?? new Date().toISOString()).trim() || new Date().toISOString();
      const currency = String(item?.currency ?? fallbackCurrency ?? 'EUR').trim() || 'EUR';
      const paymentMethod = String(item?.paymentMethod ?? fallbackPaymentMethod ?? '').trim();
      const bankName = String(item?.bankName ?? '').trim();
      const chequeNumber = String(item?.chequeNumber ?? '').trim();
      const reference = String(item?.reference ?? '').trim();
      const notes = String(item?.notes ?? '').trim();

      if (!Number.isFinite(amountCentsValue) || amountCentsValue <= 0) {
        return null;
      }

      return {
        amountCents: amountCentsValue,
        paidAt,
        currency,
        paymentMethod,
        bankName,
        chequeNumber,
        reference,
        notes
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) {
    return normalized;
  }

  if (String(fallbackPaymentMethod ?? '').trim()) {
    return [{
      amountCents: Math.max(0, Math.round(Number(amountCents ?? 0))),
      paidAt: String(issuedAt ?? new Date().toISOString()).trim() || new Date().toISOString(),
      currency: String(fallbackCurrency ?? 'EUR').trim() || 'EUR',
      paymentMethod: String(fallbackPaymentMethod ?? '').trim(),
      bankName: '',
      chequeNumber: '',
      reference: '',
      notes: ''
    }].filter((item) => item.amountCents > 0);
  }

  return [];
}

function computeInvoiceStatusFromPayments(totalAmountCents, payments, requestedStatus) {
  const requested = String(requestedStatus ?? '').trim();
  const paidAmountCents = payments.reduce((sum, item) => sum + Number(item.amountCents ?? 0), 0);
  const effectiveTotal = Math.max(0, Math.round(Number(totalAmountCents ?? 0)));

  if (paidAmountCents <= 0) {
    return requested === 'annulee' ? 'annulee' : 'impayee';
  }
  if (paidAmountCents >= effectiveTotal) {
    return 'payee';
  }
  return 'partiellement_payee';
}

function getInvoiceDetail(invoiceId) {
  const invoiceRow = db.prepare(
    `SELECT i.id, i.patient_id, i.consultation_id, i.office_id, i.invoice_number, i.amount_cents, i.status,
            i.issued_at, i.due_at, i.payment_method, i.notes_cipher,
            p.cipher_full_name,
            o.name AS office_name,
            c.started_at AS consultation_started_at
     FROM invoices i
     INNER JOIN patients p ON p.id = i.patient_id
     LEFT JOIN offices o ON o.id = i.office_id
     LEFT JOIN consultations c ON c.id = i.consultation_id
     WHERE i.id = ?`
  ).get(invoiceId);

  if (!invoiceRow) {
    return null;
  }

  const lineItems = db.prepare(
    `SELECT id, label, quantity, unit_amount_ht_cents, vat_rate, display_order
     FROM invoice_line_items
     WHERE invoice_id = ?
     ORDER BY display_order ASC, id ASC`
  ).all(invoiceId);

  const payments = db.prepare(
    `SELECT id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes
     FROM invoice_payments
     WHERE invoice_id = ?
     ORDER BY datetime(paid_at) ASC, id ASC`
  ).all(invoiceId);

  const paidAmountCents = payments.reduce((sum, item) => sum + Number(item.amount_cents ?? 0), 0);

  return {
    id: Number(invoiceRow.id),
    patientId: Number(invoiceRow.patient_id),
    patientName: decryptSensitiveField(invoiceRow.cipher_full_name),
    consultationId: invoiceRow.consultation_id != null ? Number(invoiceRow.consultation_id) : null,
    consultationStartedAt: invoiceRow.consultation_started_at != null ? String(invoiceRow.consultation_started_at) : null,
    officeId: invoiceRow.office_id != null ? Number(invoiceRow.office_id) : null,
    officeName: String(invoiceRow.office_name ?? '').trim(),
    invoiceNumber: String(invoiceRow.invoice_number ?? '').trim(),
    amountCents: Number(invoiceRow.amount_cents ?? 0),
    paidAmountCents,
    remainingAmountCents: Math.max(0, Number(invoiceRow.amount_cents ?? 0) - paidAmountCents),
    status: String(invoiceRow.status ?? '').trim() || 'impayee',
    issuedAt: String(invoiceRow.issued_at ?? ''),
    dueAt: String(invoiceRow.due_at ?? ''),
    notes: invoiceRow.notes_cipher ? decryptSensitiveField(invoiceRow.notes_cipher) : '',
    paymentMethod: String(invoiceRow.payment_method ?? '').trim(),
    lineItems: lineItems.map((item) => ({
      id: Number(item.id),
      label: String(item.label ?? '').trim(),
      quantity: Number(item.quantity ?? 0),
      unitAmountHtCents: Number(item.unit_amount_ht_cents ?? 0),
      vatRate: Number(item.vat_rate ?? 0),
      displayOrder: Number(item.display_order ?? 0)
    })),
    payments: payments.map((item) => ({
      id: Number(item.id),
      paidAt: String(item.paid_at ?? ''),
      amountCents: Number(item.amount_cents ?? 0),
      currency: String(item.currency ?? 'EUR').trim() || 'EUR',
      paymentMethod: String(item.payment_method ?? '').trim(),
      bankName: safeDecryptField(item.bank_name_cipher ?? '').trim(),
      chequeNumber: String(item.cheque_number ?? '').trim(),
      reference: String(item.reference ?? '').trim(),
      notes: String(item.notes ?? '').trim()
    }))
  };
}

function appendInvoicePayment(invoiceId, payment, createdBy) {
  db.prepare(
    `INSERT INTO invoice_payments (invoice_id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    invoiceId,
    payment.paidAt,
    payment.amountCents,
    payment.currency,
    payment.paymentMethod,
    payment.bankName ? encryptSensitiveField(payment.bankName) : '',
    payment.chequeNumber,
    payment.reference,
    payment.notes,
    createdBy
  );
}

function refreshInvoicePaymentState(invoiceId) {
  const invoice = db.prepare(
    `SELECT id, amount_cents, status
     FROM invoices
     WHERE id = ?`
  ).get(invoiceId);

  if (!invoice) {
    return null;
  }

  const payments = db.prepare(
    `SELECT amount_cents, payment_method
     FROM invoice_payments
     WHERE invoice_id = ?
     ORDER BY datetime(paid_at) ASC, id ASC`
  ).all(invoiceId).map((row) => ({
    amountCents: Number(row.amount_cents ?? 0),
    paymentMethod: String(row.payment_method ?? '').trim()
  }));

  const status = computeInvoiceStatusFromPayments(
    Number(invoice.amount_cents ?? 0),
    payments,
    String(invoice.status ?? '')
  );

  const paymentMethod = payments.length === 1
    ? String(payments[0].paymentMethod ?? '').trim()
    : (payments.length > 1 ? 'multiple' : '');

  db.prepare(
    `UPDATE invoices
     SET status = ?, payment_method = ?
     WHERE id = ?`
  ).run(status, paymentMethod, invoiceId);

  return {
    status,
    paymentMethod,
    paidAmountCents: payments.reduce((sum, item) => sum + Number(item.amountCents ?? 0), 0)
  };
}

function getBillingUsersForOfficeIds(officeIds) {
  if (!Array.isArray(officeIds) || officeIds.length === 0) {
    return [];
  }

  const placeholders = officeIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT DISTINCT u.id, u.first_name, u.last_name, u.username
       FROM users u
       INNER JOIN user_offices uo ON uo.user_id = u.id
       WHERE u.is_active = 1 AND uo.office_id IN (${placeholders})
       ORDER BY lower(u.last_name) ASC, lower(u.first_name) ASC, lower(u.username) ASC`
    )
    .all(...officeIds)
    .map((row) => {
      const firstName = String(row.first_name ?? '').trim();
      const lastName = String(row.last_name ?? '').trim();
      const displayName = `${lastName.toUpperCase()} ${firstName}`.trim() || String(row.username ?? '').trim();
      return {
        id: Number(row.id),
        displayName
      };
    });
}

function getBillingOfficeOptions(officeIds) {
  if (!Array.isArray(officeIds) || officeIds.length === 0) {
    return [];
  }

  const placeholders = officeIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, name
       FROM offices
       WHERE id IN (${placeholders})
       ORDER BY lower(name) ASC, id ASC`
    )
    .all(...officeIds)
    .map((row) => {
      const officeId = Number(row.id);
      const paymentMethods = readOfficePaymentMethods(officeId)
        .filter((item) => item.isActive)
        .map((item) => String(item.label ?? '').trim())
        .filter((item) => item.length > 0);

      return {
        id: officeId,
        name: String(row.name ?? '').trim(),
        paymentMethods: [...new Set(paymentMethods)]
      };
    });
}

function getStatisticsUsersForOfficeIds(officeIds) {
  if (!Array.isArray(officeIds) || officeIds.length === 0) {
    return [];
  }

  const placeholders = officeIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT DISTINCT u.id, u.username, u.first_name, u.last_name
       FROM users u
       INNER JOIN user_offices uo ON uo.user_id = u.id
       WHERE u.is_active = 1 AND uo.office_id IN (${placeholders})
       ORDER BY lower(u.last_name) ASC, lower(u.first_name) ASC, lower(u.username) ASC`
    )
    .all(...officeIds)
    .map((row) => {
      const firstName = normalizeStatisticsText(row.first_name);
      const lastName = normalizeStatisticsText(row.last_name);
      const username = normalizeStatisticsText(row.username);
      const displayName = normalizeStatisticsText(`${firstName} ${lastName}`) || username;

      return {
        id: Number(row.id),
        username,
        firstName,
        lastName,
        displayName,
        matchKeys: [...new Set([
          normalizePersonNameKey(username),
          normalizePersonNameKey(displayName),
          normalizePersonNameKey(`${firstName} ${lastName}`),
          normalizePersonNameKey(`${lastName} ${firstName}`)
        ].filter(Boolean))]
      };
    });
}

function normalizeStatisticsScopeMode(rawValue) {
  return String(rawValue ?? '').trim() === 'consolidated' ? 'consolidated' : 'active-office';
}

function normalizeStatisticsGranularity(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (value === 'quarter' || value === 'year') {
    return value;
  }
  return 'month';
}

function normalizeStatisticsYears(rawValue, fallbackValue = 5) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    return fallbackValue;
  }
  return Math.min(Math.max(parsed, 1), 10);
}

function parseStatisticsYearList(rawValue, fallbackYears = 5) {
  const currentYear = new Date().getFullYear();
  const years = String(rawValue ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= currentYear - 20 && value <= currentYear)
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((left, right) => right - left);

  if (years.length > 0) {
    return years.slice(0, 10);
  }

  return Array.from({ length: Math.min(Math.max(fallbackYears, 1), 10) }, (_value, index) => currentYear - index);
}

function buildAvailableStatisticsYears(selectedYears, fallbackYears = 5) {
  const currentYear = new Date().getFullYear();
  const windowSize = Math.min(Math.max(fallbackYears, selectedYears.length, 5), 10);
  return Array.from({ length: windowSize }, (_value, index) => currentYear - index);
}

function getScopedStatisticsOfficeIds(access, scopeMode, requestedOfficeId) {
  const availableOfficeIds = getAccessibleBillingOfficeIds(access);

  if (scopeMode === 'consolidated') {
    return {
      availableOfficeIds,
      scopedOfficeIds: availableOfficeIds,
      selectedOfficeId: null
    };
  }

  const asked = Number(requestedOfficeId);
  const selectedOfficeId = Number.isInteger(asked) && availableOfficeIds.includes(asked)
    ? asked
    : (availableOfficeIds[0] ?? null);

  return {
    availableOfficeIds,
    scopedOfficeIds: selectedOfficeId != null ? [selectedOfficeId] : [],
    selectedOfficeId
  };
}

function getStatisticsEvolutionRange(years) {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - Math.max(years - 1, 0);
  const from = new Date(startYear, 0, 1, 0, 0, 0, 0);
  const to = new Date(currentYear, 11, 31, 23, 59, 59, 999);

  return {
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    startYear,
    currentYear
  };
}

function normalizeStatisticsText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function splitStatisticsPatientName(fullName) {
  const normalized = normalizeStatisticsText(fullName);
  const separatorIndex = normalized.indexOf(' ');

  if (separatorIndex < 0) {
    return {
      lastName: normalized,
      firstName: ''
    };
  }

  return {
    lastName: normalized.slice(0, separatorIndex),
    firstName: normalized.slice(separatorIndex + 1)
  };
}

function getStatisticsAgeRangeFromBirthDate(birthDate) {
  const age = getAgeFromBirthDate(birthDate);
  if (age == null || age < 0) {
    return 'Inconnu';
  }
  if (age <= 5) {
    return '0-5';
  }
  if (age <= 20) {
    return '5-20';
  }
  if (age <= 40) {
    return '20-40';
  }
  if (age <= 60) {
    return '40-60';
  }
  return '+ de 60';
}

function stripStatisticsHtml(rawValue) {
  return normalizeStatisticsText(String(rawValue ?? '').replace(/<[^>]*>/g, ' '));
}

function parseStatisticsConsultationReasons(structuredItems = [], structuredSections = null) {
  const seen = new Set();
  const labels = [];

  const reasonItems = Array.isArray(structuredItems) ? structuredItems : [];

  for (const item of reasonItems) {
    const label = normalizeStatisticsText(item?.label);
    const value = normalizeStatisticsText(item?.value);
    const combined = value ? `${label} - ${value}` : label;
    const key = normalizePersonNameKey(combined);
    if (!combined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    labels.push(combined);
  }

  if (labels.length === 0) {
    const fallbackRaw = String(structuredSections?.motifMainHtml ?? '').trim();
    const fallback = fallbackRaw ? stripStatisticsHtml(fallbackRaw) : '';
    if (fallback) {
      labels.push(fallback);
    }
  }

  if (labels.length === 0) {
    labels.push('Non renseigne');
  }

  return labels;
}

function parseStatisticsAntecedents(medicalHistoryRaw) {
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
      .map((entry) => {
        const record = entry && typeof entry === 'object' ? entry : {};
        return {
          category: normalizeStatisticsText(record.category ?? 'Antécédent') || 'Antécédent',
          label: normalizeStatisticsText(record.description ?? record.label ?? '') || 'Détail non renseigné'
        };
      })
      .filter((item) => item.label.length > 0);
  } catch {
    return [{ category: 'Antécédent', label: normalizeStatisticsText(raw) }].filter((item) => item.label.length > 0);
  }
}

function buildStatisticsRankedPatientItems(rows, countByPatientId) {
  return rows
    .map((row) => {
      const fullName = decryptSensitiveField(row.cipher_full_name);
      const names = splitStatisticsPatientName(fullName);
      return {
        patientId: Number(row.id),
        fullName,
        lastName: names.lastName,
        firstName: names.firstName,
        age: getAgeFromBirthDate(row.birth_date),
        count: Number(countByPatientId.get(Number(row.id)) ?? 0)
      };
    })
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count || left.fullName.localeCompare(right.fullName, 'fr', { sensitivity: 'base' }))
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      ...item
    }));
}

function matchStatisticsUser(practitioner, users) {
  const key = normalizePersonNameKey(practitioner);
  if (!key) {
    return null;
  }

  return users.find((user) => user.matchKeys.includes(key)) ?? null;
}

function buildStatisticsAnnualValuePoints(rows, startYear, endYear, getDateValue, getValue) {
  const counters = new Map();

  for (let year = startYear; year <= endYear; year += 1) {
    counters.set(year, 0);
  }

  for (const row of rows) {
    const date = new Date(getDateValue(row));
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const year = date.getFullYear();
    if (!counters.has(year)) {
      continue;
    }

    counters.set(year, Number(counters.get(year)) + Number(getValue(row)));
  }

  return [...counters.entries()].map(([year, value]) => ({
    label: String(year),
    value
  }));
}

function buildStatisticsMonthlySeries(rows, selectedYears, getDateValue, getValue) {
  const monthFormatter = new Intl.DateTimeFormat('fr-FR', { month: 'short' });

  return selectedYears.map((year) => {
    const counters = Array.from({ length: 12 }, () => 0);

    for (const row of rows) {
      const date = new Date(getDateValue(row));
      if (Number.isNaN(date.getTime()) || date.getFullYear() !== year) {
        continue;
      }

      const monthIndex = date.getMonth();
      counters[monthIndex] += Number(getValue(row));
    }

    return {
      year,
      points: counters.map((value, monthIndex) => ({
        label: monthFormatter.format(new Date(year, monthIndex, 1)).replace('.', ''),
        value
      }))
    };
  });
}

function buildStatisticsConsultationEvolutionPoints(rows, granularity, startYear, endYear) {
  if (granularity === 'year') {
    return buildStatisticsAnnualValuePoints(rows, startYear, endYear, (row) => row.started_at, () => 1);
  }

  if (granularity === 'quarter') {
    const counters = new Map();

    for (let year = startYear; year <= endYear; year += 1) {
      for (let quarter = 1; quarter <= 4; quarter += 1) {
        counters.set(`${year}-Q${quarter}`, 0);
      }
    }

    for (const row of rows) {
      const date = new Date(row.started_at);
      if (Number.isNaN(date.getTime())) {
        continue;
      }

      const year = date.getFullYear();
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      const key = `${year}-Q${quarter}`;
      if (!counters.has(key)) {
        continue;
      }

      counters.set(key, Number(counters.get(key)) + 1);
    }

    return [...counters.entries()].map(([key, value]) => {
      const [yearPart, quarterPart] = key.split('-Q');
      return {
        label: `T${quarterPart} ${yearPart}`,
        value
      };
    });
  }

  const counters = new Map();
  const monthFormatter = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });

  for (let year = startYear; year <= endYear; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      counters.set(key, {
        label: monthFormatter.format(new Date(year, month, 1)).replace('.', ''),
        value: 0
      });
    }
  }

  for (const row of rows) {
    const date = new Date(row.started_at);
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const bucket = counters.get(key);
    if (!bucket) {
      continue;
    }

    bucket.value += 1;
  }

  return [...counters.values()];
}

function getStatisticsPaymentMethodDistribution({ fromIso, toIso, scopedOfficeIds, ownerUserId }) {
  const metaRows = db
    .prepare(
      `SELECT source_id, owner_user_id, is_deleted
       FROM accounting_operation_meta
       WHERE source_type = 'invoice'`
    )
    .all();

  const metaByInvoiceId = new Map();
  for (const row of metaRows) {
    metaByInvoiceId.set(Number(row.source_id), {
      ownerUserId: row.owner_user_id != null ? Number(row.owner_user_id) : null,
      isDeleted: Number(row.is_deleted) === 1
    });
  }

  const rows = db
    .prepare(
      `SELECT i.id, i.issued_at, i.payment_method,
              COALESCE(
                i.office_id,
                (
                  SELECT c.office_id
                  FROM consultations c
                  WHERE c.patient_id = i.patient_id AND date(c.started_at) = date(i.issued_at)
                  ORDER BY datetime(c.started_at) DESC, c.id DESC
                  LIMIT 1
                )
              ) AS office_id
       FROM invoices i
       WHERE datetime(i.issued_at) >= datetime(?)
         AND datetime(i.issued_at) <= datetime(?)`
    )
    .all(fromIso, toIso);

  const counters = new Map();

  for (const row of rows) {
    const officeId = row.office_id != null ? Number(row.office_id) : null;
    if (Array.isArray(scopedOfficeIds) && scopedOfficeIds.length > 0 && (officeId == null || !scopedOfficeIds.includes(officeId))) {
      continue;
    }

    const meta = metaByInvoiceId.get(Number(row.id));
    if (meta?.isDeleted) {
      continue;
    }

    const effectiveOwnerUserId = meta?.ownerUserId ?? null;
    if (Number.isInteger(ownerUserId) && ownerUserId > 0 && effectiveOwnerUserId !== ownerUserId) {
      continue;
    }

    const label = normalizeStatisticsText(row.payment_method) || 'Non renseigne';
    counters.set(label, Number(counters.get(label) ?? 0) + 1);
  }

  return [...counters.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'fr', { sensitivity: 'base' }));
}

function buildStatisticsPayload({ requestingUserId, access, scopeMode, requestedOfficeId, years, yearlyBreakdownYears, consultationGranularity, requestedUserId }) {
  const { availableOfficeIds, scopedOfficeIds, selectedOfficeId } = getScopedStatisticsOfficeIds(access, scopeMode, requestedOfficeId);
  const canViewPeerStatistics = access.role === 'admin'
    || access.profileId === SUPER_ADMIN_PROFILE_ID
    || hasPermission(access.rights, 'read-peer-statistics');
  const scopedUsers = getStatisticsUsersForOfficeIds(scopedOfficeIds.length > 0 ? scopedOfficeIds : availableOfficeIds);
  const selfFallbackRow = db
    .prepare('SELECT id, username, first_name, last_name FROM users WHERE id = ? AND is_active = 1')
    .get(requestingUserId);

  if (selfFallbackRow && !scopedUsers.some((user) => user.id === requestingUserId)) {
    const username = normalizeStatisticsText(selfFallbackRow.username);
    const firstName = normalizeStatisticsText(selfFallbackRow.first_name);
    const lastName = normalizeStatisticsText(selfFallbackRow.last_name);
    const displayName = normalizeStatisticsText(`${firstName} ${lastName}`) || username;

    scopedUsers.unshift({
      id: Number(selfFallbackRow.id),
      username,
      firstName,
      lastName,
      displayName,
      matchKeys: [...new Set([
        normalizePersonNameKey(username),
        normalizePersonNameKey(displayName),
        normalizePersonNameKey(`${firstName} ${lastName}`),
        normalizePersonNameKey(`${lastName} ${firstName}`)
      ].filter(Boolean))]
    });
  }

  const visibleUserOptions = (canViewPeerStatistics
    ? scopedUsers
    : scopedUsers.filter((user) => user.id === requestingUserId)
  ).map((user) => ({
    id: user.id,
    displayName: user.displayName
  }));

  const selectedUserId = (() => {
    const parsed = Number(requestedUserId);
    if (Number.isInteger(parsed) && visibleUserOptions.some((user) => user.id === parsed)) {
      return parsed;
    }

    if (visibleUserOptions.some((user) => user.id === requestingUserId)) {
      return requestingUserId;
    }

    return visibleUserOptions[0]?.id ?? null;
  })();

  const evolutionRange = getStatisticsEvolutionRange(years);
  const patientRows = db
    .prepare(
      `SELECT id, cipher_full_name, sex, birth_date, cipher_medical_notes
       FROM patients
       WHERE is_deleted = 0`
    )
    .all();
  const consultationRows = db
    .prepare(
      `SELECT id, patient_id, started_at, office_id, practitioner, profile
       FROM consultations`
    )
    .all();
  const appointmentRows = db
    .prepare(
      `SELECT id, patient_id, starts_at, status, office_id
       FROM appointments`
    )
    .all();

  const scopedConsultationRows = consultationRows.filter((row) => {
    const officeId = row.office_id != null ? Number(row.office_id) : null;
    return scopedOfficeIds.length > 0 && officeId != null && scopedOfficeIds.includes(officeId);
  });
  const scopedAppointmentRows = appointmentRows.filter((row) => {
    const officeId = row.office_id != null ? Number(row.office_id) : null;
    return scopedOfficeIds.length > 0 && officeId != null && scopedOfficeIds.includes(officeId);
  });

  const patientIdsInScope = new Set([
    ...scopedConsultationRows.map((row) => Number(row.patient_id)),
    ...scopedAppointmentRows.map((row) => Number(row.patient_id))
  ]);

  const patientsInScope = patientRows.filter((row) => patientIdsInScope.has(Number(row.id)));
  const patientRowById = new Map(patientsInScope.map((row) => [Number(row.id), row]));
  const consultationReasonItemsById = buildConsultationReasonItemsMap(scopedConsultationRows);
  const consultationSectionsById = buildConsultationSectionsMap(scopedConsultationRows);
  const patientAntecedentsById = buildPatientAntecedentsMap(patientsInScope);

  const patientSexCounters = new Map([
    ['Femme', 0],
    ['Homme', 0],
    ['Non renseigne', 0]
  ]);
  const ageRangeCounters = new Map([
    ['Inconnu', { femaleCount: 0, maleCount: 0, unknownCount: 0, totalCount: 0 }],
    ['0-5', { femaleCount: 0, maleCount: 0, unknownCount: 0, totalCount: 0 }],
    ['5-20', { femaleCount: 0, maleCount: 0, unknownCount: 0, totalCount: 0 }],
    ['20-40', { femaleCount: 0, maleCount: 0, unknownCount: 0, totalCount: 0 }],
    ['40-60', { femaleCount: 0, maleCount: 0, unknownCount: 0, totalCount: 0 }],
    ['+ de 60', { femaleCount: 0, maleCount: 0, unknownCount: 0, totalCount: 0 }]
  ]);

  for (const row of patientsInScope) {
    const sexLabel = normalizePatientSexLabel(row.sex);
    patientSexCounters.set(sexLabel, Number(patientSexCounters.get(sexLabel)) + 1);

    const ageRange = getStatisticsAgeRangeFromBirthDate(row.birth_date);
    const bucket = ageRangeCounters.get(ageRange) ?? ageRangeCounters.get('Inconnu');
    if (!bucket) {
      continue;
    }

    bucket.totalCount += 1;
    if (sexLabel === 'Femme') {
      bucket.femaleCount += 1;
    } else if (sexLabel === 'Homme') {
      bucket.maleCount += 1;
    } else {
      bucket.unknownCount += 1;
    }
  }

  const consultationCountByPatientId = new Map();
  const firstConsultationTimestampByPatientId = new Map();
  for (const row of scopedConsultationRows) {
    const patientId = Number(row.patient_id);
    consultationCountByPatientId.set(patientId, Number(consultationCountByPatientId.get(patientId) ?? 0) + 1);

    const startedAtValue = new Date(row.started_at).getTime();
    const currentValue = firstConsultationTimestampByPatientId.get(patientId);
    if (!Number.isFinite(currentValue) || startedAtValue < currentValue) {
      firstConsultationTimestampByPatientId.set(patientId, startedAtValue);
    }
  }

  const missedAppointmentCountByPatientId = new Map();
  const nowTimestamp = Date.now();
  for (const row of scopedAppointmentRows) {
    const startedAtValue = new Date(row.starts_at).getTime();
    if (!Number.isFinite(startedAtValue) || startedAtValue >= nowTimestamp || String(row.status ?? '').trim() === 'Termine') {
      continue;
    }

    const patientId = Number(row.patient_id);
    missedAppointmentCountByPatientId.set(patientId, Number(missedAppointmentCountByPatientId.get(patientId) ?? 0) + 1);
  }

  const consultationReasonCounters = new Map();
  for (const row of scopedConsultationRows) {
    const profile = normalizeStatisticsText(row.profile) || 'Non renseigne';
    const reasonItems = consultationReasonItemsById.get(Number(row.id)) ?? [];
    const sections = consultationSectionsById.get(Number(row.id)) ?? buildEmptyConsultationSections();
    for (const reason of parseStatisticsConsultationReasons(reasonItems, sections)) {
      const key = `${profile}||${reason}`;
      const current = consultationReasonCounters.get(key) ?? { profile, reason, consultationCount: 0 };
      current.consultationCount += 1;
      consultationReasonCounters.set(key, current);
    }
  }

  const cityCounters = new Map();
  const antecedentCounters = new Map();
  const referralCounters = new Map();
  for (const row of patientsInScope) {
    const notes = parsePatientNotesFromCipher(row.cipher_medical_notes);
    const city = normalizeStatisticsText(notes.city);
    const postalCode = normalizeStatisticsText(notes.postalCode);
    if (city || postalCode) {
      const key = `${postalCode}||${city}`;
      const current = cityCounters.get(key) ?? {
        city: city || 'Non renseignee',
        postalCode,
        patientCount: 0
      };
      current.patientCount += 1;
      cityCounters.set(key, current);
    }

    const referral = normalizeStatisticsText(notes.referredBy);
    if (referral) {
      referralCounters.set(referral, Number(referralCounters.get(referral) ?? 0) + 1);
    }

    const antecedents = patientAntecedentsById.get(Number(row.id)) ?? parseStatisticsAntecedents(notes.medicalHistory);
    const seenAntecedents = new Set();
    for (const antecedent of antecedents) {
      const key = `${normalizePersonNameKey(antecedent.category)}||${normalizePersonNameKey(antecedent.label)}`;
      if (!key || seenAntecedents.has(key)) {
        continue;
      }

      seenAntecedents.add(key);
      const current = antecedentCounters.get(key) ?? {
        category: antecedent.category,
        label: antecedent.label,
        patientCount: 0
      };
      current.patientCount += 1;
      antecedentCounters.set(key, current);
    }
  }

  const consultationRowsInWindow = scopedConsultationRows.filter((row) => {
    const startedAtValue = new Date(row.started_at).getTime();
    return Number.isFinite(startedAtValue)
      && startedAtValue >= evolutionRange.from.getTime()
      && startedAtValue <= evolutionRange.to.getTime();
  });

  const consultationTypeCounters = new Map([
    ['1er RDV', 0],
    ['Suivi', 0]
  ]);
  const consultationUserCounters = new Map();
  for (const row of consultationRowsInWindow) {
    const patientId = Number(row.patient_id);
    const startedAtValue = new Date(row.started_at).getTime();
    if (startedAtValue === firstConsultationTimestampByPatientId.get(patientId)) {
      consultationTypeCounters.set('1er RDV', Number(consultationTypeCounters.get('1er RDV')) + 1);
    } else {
      consultationTypeCounters.set('Suivi', Number(consultationTypeCounters.get('Suivi')) + 1);
    }

    const matchedUser = matchStatisticsUser(row.practitioner, scopedUsers);
    const label = matchedUser?.displayName || normalizeStatisticsText(row.practitioner) || 'Non renseigne';
    consultationUserCounters.set(label, Number(consultationUserCounters.get(label) ?? 0) + 1);
  }

  const overallBillingOperations = getBillingOperationsData({
    userId: requestingUserId,
    access,
    fromIso: evolutionRange.fromIso,
    toIso: evolutionRange.toIso,
    availableOfficeIds,
    filterOfficeIds: scopedOfficeIds,
    ownerUserId: null
  }).operations;
  const overallPaymentMethods = getStatisticsPaymentMethodDistribution({
    fromIso: evolutionRange.fromIso,
    toIso: evolutionRange.toIso,
    scopedOfficeIds,
    ownerUserId: null
  });

  const selectedUser = selectedUserId != null
    ? (scopedUsers.find((user) => user.id === selectedUserId) ?? null)
    : null;
  const userConsultationRows = selectedUser
    ? consultationRowsInWindow.filter((row) => matchStatisticsUser(row.practitioner, [selectedUser])?.id === selectedUser.id)
    : [];
  const userConsultationRowsAll = selectedUser
    ? scopedConsultationRows.filter((row) => matchStatisticsUser(row.practitioner, [selectedUser])?.id === selectedUser.id)
    : [];
  const userBillingOperations = selectedUser
    ? getBillingOperationsData({
      userId: requestingUserId,
      access,
      fromIso: evolutionRange.fromIso,
      toIso: evolutionRange.toIso,
      availableOfficeIds,
      filterOfficeIds: scopedOfficeIds,
      ownerUserId: selectedUser.id
    }).operations
    : [];
  const userPaymentMethods = selectedUser
    ? getStatisticsPaymentMethodDistribution({
      fromIso: evolutionRange.fromIso,
      toIso: evolutionRange.toIso,
      scopedOfficeIds,
      ownerUserId: selectedUser.id
    })
    : [];

  return {
    scope: {
      mode: scopeMode,
      offices: getBillingOfficeOptions(availableOfficeIds),
      selectedOfficeId,
      users: visibleUserOptions,
      selectedUserId,
      canViewPeerStatistics
    },
    filters: {
      years,
      availableYears: buildAvailableStatisticsYears(yearlyBreakdownYears, years),
      selectedYears: yearlyBreakdownYears,
      consultationGranularity
    },
    patients: {
      bySex: [...patientSexCounters.entries()].map(([label, count]) => ({ label, count })),
      byAgeRangeAndSex: [...ageRangeCounters.entries()].map(([label, values]) => ({ label, ...values })),
      topFollowedPatients: buildStatisticsRankedPatientItems(patientsInScope, consultationCountByPatientId),
      topMissedAppointments: buildStatisticsRankedPatientItems(patientsInScope, missedAppointmentCountByPatientId),
      topConsultationReasons: [...consultationReasonCounters.values()]
        .sort((left, right) => right.consultationCount - left.consultationCount || left.reason.localeCompare(right.reason, 'fr', { sensitivity: 'base' }))
        .slice(0, 10)
        .map((item, index) => ({ rank: index + 1, ...item })),
      topCities: [...cityCounters.values()]
        .sort((left, right) => right.patientCount - left.patientCount || left.city.localeCompare(right.city, 'fr', { sensitivity: 'base' }))
        .slice(0, 10)
        .map((item, index) => ({ rank: index + 1, ...item })),
      topAntecedents: [...antecedentCounters.values()]
        .sort((left, right) => right.patientCount - left.patientCount || left.label.localeCompare(right.label, 'fr', { sensitivity: 'base' }))
        .slice(0, 10)
        .map((item, index) => ({ rank: index + 1, ...item })),
      topReferrals: [...referralCounters.entries()]
        .map(([source, patientCount]) => ({ source, patientCount }))
        .sort((left, right) => right.patientCount - left.patientCount || left.source.localeCompare(right.source, 'fr', { sensitivity: 'base' }))
        .slice(0, 10)
        .map((item, index) => ({ rank: index + 1, ...item }))
    },
    consultations: {
      evolution: buildStatisticsConsultationEvolutionPoints(
        consultationRowsInWindow,
        consultationGranularity,
        evolutionRange.startYear,
        evolutionRange.currentYear
      ),
      monthlyByYear: buildStatisticsMonthlySeries(scopedConsultationRows, yearlyBreakdownYears, (row) => row.started_at, () => 1),
      byType: [...consultationTypeCounters.entries()].map(([label, count]) => ({ label, count })),
      byUser: [...consultationUserCounters.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'fr', { sensitivity: 'base' }))
    },
    payments: {
      revenueEvolution: buildStatisticsAnnualValuePoints(
        overallBillingOperations,
        evolutionRange.startYear,
        evolutionRange.currentYear,
        (row) => row.occurredAt,
        (row) => row.creditCents
      ),
      revenueMonthlyByYear: buildStatisticsMonthlySeries(overallBillingOperations, yearlyBreakdownYears, (row) => row.occurredAt, (row) => row.creditCents),
      profitEvolution: buildStatisticsAnnualValuePoints(
        overallBillingOperations,
        evolutionRange.startYear,
        evolutionRange.currentYear,
        (row) => row.occurredAt,
        (row) => row.creditCents - row.debitCents
      ),
      profitMonthlyByYear: buildStatisticsMonthlySeries(
        overallBillingOperations,
        yearlyBreakdownYears,
        (row) => row.occurredAt,
        (row) => row.creditCents - row.debitCents
      ),
      paymentMethods: overallPaymentMethods
    },
    userStats: selectedUser
      ? {
        user: {
          id: selectedUser.id,
          displayName: selectedUser.displayName
        },
        revenueEvolution: buildStatisticsAnnualValuePoints(
          userBillingOperations,
          evolutionRange.startYear,
          evolutionRange.currentYear,
          (row) => row.occurredAt,
          (row) => row.creditCents
        ),
        revenueMonthlyByYear: buildStatisticsMonthlySeries(userBillingOperations, yearlyBreakdownYears, (row) => row.occurredAt, (row) => row.creditCents),
        profitEvolution: buildStatisticsAnnualValuePoints(
          userBillingOperations,
          evolutionRange.startYear,
          evolutionRange.currentYear,
          (row) => row.occurredAt,
          (row) => row.creditCents - row.debitCents
        ),
        profitMonthlyByYear: buildStatisticsMonthlySeries(
          userBillingOperations,
          yearlyBreakdownYears,
          (row) => row.occurredAt,
          (row) => row.creditCents - row.debitCents
        ),
        consultationEvolution: buildStatisticsConsultationEvolutionPoints(
          userConsultationRows,
          consultationGranularity,
          evolutionRange.startYear,
          evolutionRange.currentYear
        ),
        consultationMonthlyByYear: buildStatisticsMonthlySeries(userConsultationRowsAll, yearlyBreakdownYears, (row) => row.started_at, () => 1),
        paymentMethods: userPaymentMethods
      }
      : null
  };
}

function getBillingOperationsData({ userId, access, fromIso, toIso, availableOfficeIds, filterOfficeIds, ownerUserId }) {
  if (!Array.isArray(availableOfficeIds) || availableOfficeIds.length === 0) {
    return {
      operations: [],
      summary: [
        { label: 'Credits periode', value: '0.00 EUR', trend: '0 operations' },
        { label: 'Debits periode', value: '0.00 EUR', trend: 'Aucune depense' },
        { label: 'Resultat', value: '0.00 EUR', trend: 'Neutre' }
      ],
      stats: {
        debitCents: 0,
        creditCents: 0,
        netCents: 0,
        operationCount: 0
      },
      offices: [],
      users: [],
      selectedOwnerUserId: null,
      selectedOfficeId: null
    };
  }

  const metaRows = db
    .prepare(
      `SELECT source_type, source_id, owner_user_id, retrocession_percent, retrocession_recipient, is_deleted
       FROM accounting_operation_meta`
    )
    .all();

  const metaByKey = new Map();
  for (const meta of metaRows) {
    metaByKey.set(`${meta.source_type}:${Number(meta.source_id)}`, {
      ownerUserId: meta.owner_user_id != null ? Number(meta.owner_user_id) : null,
      retrocessionPercent: Number(meta.retrocession_percent ?? 0),
      retrocessionRecipient: String(meta.retrocession_recipient ?? '').trim(),
      isDeleted: Number(meta.is_deleted) === 1
    });
  }

  const depositItemRows = db
    .prepare(
      `SELECT di.source_type, di.source_id, di.deposit_id, d.type AS deposit_type
       FROM accounting_deposit_items di
       INNER JOIN accounting_deposits d ON d.id = di.deposit_id
       WHERE d.is_deleted = 0`
    )
    .all();

  const depositItemByKey = new Map();
  for (const di of depositItemRows) {
    depositItemByKey.set(`${di.source_type}:${Number(di.source_id)}`, {
      depositId: Number(di.deposit_id),
      depositType: String(di.deposit_type)
    });
  }

  const invoices = db
    .prepare(
      `SELECT i.id, i.patient_id, i.invoice_number, i.amount_cents, i.issued_at,
              p.cipher_full_name,
              COALESCE(pay.paid_cents, 0) AS paid_cents,
              COALESCE(
                i.office_id,
                (
                  SELECT c.office_id
                  FROM consultations c
                  WHERE c.patient_id = i.patient_id AND date(c.started_at) = date(i.issued_at)
                  ORDER BY datetime(c.started_at) DESC, c.id DESC
                  LIMIT 1
                )
              ) AS office_id
       FROM invoices i
       INNER JOIN patients p ON p.id = i.patient_id
       LEFT JOIN (
         SELECT invoice_id, SUM(amount_cents) AS paid_cents
         FROM invoice_payments
         GROUP BY invoice_id
       ) pay ON pay.invoice_id = i.id
       WHERE datetime(i.issued_at) >= datetime(?)
         AND datetime(i.issued_at) <= datetime(?)`
    )
    .all(fromIso, toIso);

  const expenses = db
    .prepare(
      `SELECT id, occurred_at, office_id, owner_user_id, title, amount_cents, currency,
              payment_method, notes, retrocession_percent, retrocession_recipient
       FROM accounting_expenses
       WHERE is_deleted = 0
         AND datetime(occurred_at) >= datetime(?)
         AND datetime(occurred_at) <= datetime(?)`
    )
    .all(fromIso, toIso);

  const deposits = db
    .prepare(
      `SELECT id, occurred_at, office_id, owner_user_id, type, title, amount_cents, currency,
              notes, retrocession_percent, retrocession_recipient
       FROM accounting_deposits
       WHERE is_deleted = 0
         AND datetime(occurred_at) >= datetime(?)
         AND datetime(occurred_at) <= datetime(?)`
    )
    .all(fromIso, toIso);

  const operations = [];

  for (const row of invoices) {
    const operationId = `invoice:${Number(row.id)}`;
    const meta = metaByKey.get(operationId);
    if (meta?.isDeleted) {
      continue;
    }

    const officeId = row.office_id != null ? Number(row.office_id) : null;
    if (Array.isArray(filterOfficeIds) && filterOfficeIds.length > 0 && (officeId == null || !filterOfficeIds.includes(officeId))) {
      continue;
    }

    const effectiveOwner = meta?.ownerUserId ?? null;
    if (Number.isInteger(ownerUserId) && ownerUserId > 0 && effectiveOwner !== ownerUserId) {
      continue;
    }

    const depositItem = depositItemByKey.get(operationId);
    operations.push({
      id: operationId,
      sourceType: 'invoice',
      sourceId: Number(row.id),
      occurredAt: String(row.issued_at),
      title: `Consultation pour ${decryptSensitiveField(row.cipher_full_name)}`,
      debitCents: 0,
      creditCents: Number(row.amount_cents ?? 0),
      currency: 'EUR',
      officeId,
      ownerUserId: effectiveOwner,
      retrocessionPercent: meta?.retrocessionPercent ?? 0,
      retrocessionRecipient: meta?.retrocessionRecipient ?? '',
      invoiceNumber: String(row.invoice_number ?? '').trim(),
      remainingAmountCents: Math.max(0, Number(row.amount_cents ?? 0) - Number(row.paid_cents ?? 0)),
      depositId: depositItem?.depositId ?? null,
      depositType: depositItem?.depositType ?? null,
      paymentRef: {
        type: 'patient',
        patientId: Number(row.patient_id)
      }
    });
  }

  for (const row of expenses) {
    const officeId = row.office_id != null ? Number(row.office_id) : null;
    if (Array.isArray(filterOfficeIds) && filterOfficeIds.length > 0 && (officeId == null || !filterOfficeIds.includes(officeId))) {
      continue;
    }

    const effectiveOwner = row.owner_user_id != null ? Number(row.owner_user_id) : null;
    if (Number.isInteger(ownerUserId) && ownerUserId > 0 && effectiveOwner !== ownerUserId) {
      continue;
    }

    operations.push({
      id: `expense:${Number(row.id)}`,
      sourceType: 'expense',
      sourceId: Number(row.id),
      occurredAt: String(row.occurred_at),
      title: String(row.title ?? '').trim() || 'Depense',
      debitCents: Number(row.amount_cents ?? 0),
      creditCents: 0,
      currency: String(row.currency ?? 'EUR').trim() || 'EUR',
      officeId,
      ownerUserId: effectiveOwner,
      retrocessionPercent: Number(row.retrocession_percent ?? 0),
      retrocessionRecipient: String(row.retrocession_recipient ?? '').trim(),
      invoiceNumber: '',
      remainingAmountCents: 0,
      paymentRef: {
        type: 'expense',
        expenseId: Number(row.id)
      }
    });
  }

  for (const row of deposits) {
    const officeId = row.office_id != null ? Number(row.office_id) : null;
    if (Array.isArray(filterOfficeIds) && filterOfficeIds.length > 0 && (officeId == null || !filterOfficeIds.includes(officeId))) {
      continue;
    }

    const effectiveOwner = row.owner_user_id != null ? Number(row.owner_user_id) : null;
    if (Number.isInteger(ownerUserId) && ownerUserId > 0 && effectiveOwner !== ownerUserId) {
      continue;
    }

    operations.push({
      id: `deposit:${Number(row.id)}`,
      sourceType: 'deposit',
      sourceId: Number(row.id),
      occurredAt: String(row.occurred_at),
      title: String(row.title ?? '').trim() || (String(row.type ?? '').toLowerCase() === 'especes' ? 'Remise d\'especes' : 'Remise de cheques'),
      debitCents: 0,
      creditCents: Number(row.amount_cents ?? 0),
      currency: String(row.currency ?? 'EUR').trim() || 'EUR',
      officeId,
      ownerUserId: effectiveOwner,
      retrocessionPercent: Number(row.retrocession_percent ?? 0),
      retrocessionRecipient: String(row.retrocession_recipient ?? '').trim(),
      invoiceNumber: '',
      remainingAmountCents: 0,
      paymentRef: {
        type: 'deposit',
        depositId: Number(row.id)
      }
    });
  }

  operations.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  const debitCents = operations.reduce((sum, row) => sum + row.debitCents, 0);
  const creditCents = operations.reduce((sum, row) => sum + row.creditCents, 0);
  const netCents = creditCents - debitCents;

  const summary = [
    {
      label: 'Credits periode',
      value: `${(creditCents / 100).toFixed(2)} EUR`,
      trend: `${operations.length} operations`
    },
    {
      label: 'Debits periode',
      value: `${(debitCents / 100).toFixed(2)} EUR`,
      trend: debitCents > 0 ? 'Depenses enregistrees' : 'Aucune depense'
    },
    {
      label: 'Resultat',
      value: `${(netCents / 100).toFixed(2)} EUR`,
      trend: netCents >= 0 ? 'Positif' : 'Negatif'
    }
  ];

  const offices = getBillingOfficeOptions(availableOfficeIds);
  const users = getBillingUsersForOfficeIds(filterOfficeIds.length > 0 ? filterOfficeIds : availableOfficeIds);

  return {
    operations,
    summary,
    stats: {
      debitCents,
      creditCents,
      netCents,
      operationCount: operations.length
    },
    offices,
    users,
    selectedOwnerUserId: Number.isInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null,
    selectedOfficeId: filterOfficeIds.length === 1 ? filterOfficeIds[0] : null
  };
}

app.get('/api/statistics', authMiddleware, requirePermission('read-advanced-statistics'), (req, res) => {
  const scopeMode = normalizeStatisticsScopeMode(req.query.scopeMode);
  const years = normalizeStatisticsYears(req.query.years, 5);
  const yearlyBreakdownYears = parseStatisticsYearList(req.query.yearlyBreakdownYears, years);
  const consultationGranularity = normalizeStatisticsGranularity(req.query.consultationGranularity);

  const payload = buildStatisticsPayload({
    requestingUserId: req.user.sub,
    access: req.userAccess,
    scopeMode,
    requestedOfficeId: req.query.officeId,
    years,
    yearlyBreakdownYears,
    consultationGranularity,
    requestedUserId: req.query.userId
  });

  writeAuditLog(req.user.sub, 'READ_DASHBOARD', 'statistics', null, {
    scopeMode,
    officeId: payload.scope.selectedOfficeId,
    userId: payload.scope.selectedUserId,
    years,
    consultationGranularity
  });

  return res.json(payload);
});

app.get('/api/billing/operations', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const range = buildBillingDateRange(req.query.from, req.query.to);
  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);
  const ownerUserId = Number(req.query.userId);

  const payload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: range.fromIso,
    toIso: range.toIso,
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: Number.isInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null
  });

  writeAuditLog(req.user.sub, 'READ_LIST', 'billing', null, {
    from: range.fromIso,
    to: range.toIso,
    operationCount: payload.operations.length
  });

  return res.json({
    ...payload,
    from: range.fromIso,
    to: range.toIso
  });
});

app.get('/api/billing/insights', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const range = buildBillingDateRange(req.query.from, req.query.to);
  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);
  const requestedOfficeId = Number(req.query.officeId);

  if (Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 && filterOfficeIds.length === 0) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }

  const effectiveOfficeIds = filterOfficeIds.length > 0 ? filterOfficeIds : availableOfficeIds;
  const currentPayload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: range.fromIso,
    toIso: range.toIso,
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: null
  });

  const durationMs = Math.max(24 * 60 * 60 * 1000, range.to.getTime() - range.from.getTime() + 1);
  const previousFrom = new Date(range.from.getTime() - durationMs);
  const previousTo = new Date(range.to.getTime() - durationMs);
  const previousPayload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: previousFrom.toISOString(),
    toIso: previousTo.toISOString(),
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: null
  });

  const computeTrendPercent = (current, previous) => {
    if (!Number.isFinite(previous) || previous <= 0) {
      return current > 0 ? 100 : 0;
    }
    return Number((((current - previous) / previous) * 100).toFixed(2));
  };

  const paymentMethods = getStatisticsPaymentMethodDistribution({
    fromIso: range.fromIso,
    toIso: range.toIso,
    scopedOfficeIds: effectiveOfficeIds,
    ownerUserId: null
  });

  const buckets = {
    current: { count: 0, amountCents: 0 },
    late1to30: { count: 0, amountCents: 0 },
    late31to60: { count: 0, amountCents: 0 },
    late61plus: { count: 0, amountCents: 0 }
  };
  const topDebtorsMap = new Map();

  if (effectiveOfficeIds.length > 0) {
    const placeholders = effectiveOfficeIds.map(() => '?').join(', ');
    const unpaidRows = db
      .prepare(
        `SELECT i.id, i.invoice_number, i.amount_cents, i.issued_at, i.due_at, i.office_id,
                p.cipher_full_name,
                COALESCE(pay.paid_cents, 0) AS paid_cents
         FROM invoices i
         INNER JOIN patients p ON p.id = i.patient_id
         LEFT JOIN (
           SELECT invoice_id, SUM(amount_cents) AS paid_cents
           FROM invoice_payments
           GROUP BY invoice_id
         ) pay ON pay.invoice_id = i.id
         WHERE i.office_id IN (${placeholders})
           AND i.status <> 'payee'
         ORDER BY datetime(COALESCE(i.due_at, i.issued_at)) ASC, i.id ASC`
      )
      .all(...effectiveOfficeIds);

    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const row of unpaidRows) {
      const remainingAmountCents = Math.max(
        0,
        Number(row.amount_cents ?? 0) - Number(row.paid_cents ?? 0)
      );
      if (remainingAmountCents <= 0) {
        continue;
      }

      const dueAtValue = new Date(String(row.due_at ?? row.issued_at ?? '')).getTime();
      const isDueDateValid = Number.isFinite(dueAtValue);
      const daysLate = isDueDateValid ? Math.floor((nowMs - dueAtValue) / dayMs) : 0;

      if (!isDueDateValid || daysLate <= 0) {
        buckets.current.count += 1;
        buckets.current.amountCents += remainingAmountCents;
      } else if (daysLate <= 30) {
        buckets.late1to30.count += 1;
        buckets.late1to30.amountCents += remainingAmountCents;
      } else if (daysLate <= 60) {
        buckets.late31to60.count += 1;
        buckets.late31to60.amountCents += remainingAmountCents;
      } else {
        buckets.late61plus.count += 1;
        buckets.late61plus.amountCents += remainingAmountCents;
      }

      const patientName = decryptSensitiveField(row.cipher_full_name);
      const currentDebtor = topDebtorsMap.get(patientName) ?? {
        patientName,
        totalOutstandingCents: 0,
        invoiceCount: 0
      };
      currentDebtor.totalOutstandingCents += remainingAmountCents;
      currentDebtor.invoiceCount += 1;
      topDebtorsMap.set(patientName, currentDebtor);
    }
  }

  const topDebtors = [...topDebtorsMap.values()]
    .sort((left, right) => right.totalOutstandingCents - left.totalOutstandingCents || right.invoiceCount - left.invoiceCount)
    .slice(0, 10);

  const totalOutstandingCents =
    buckets.current.amountCents
    + buckets.late1to30.amountCents
    + buckets.late31to60.amountCents
    + buckets.late61plus.amountCents;
  const totalOutstandingCount =
    buckets.current.count
    + buckets.late1to30.count
    + buckets.late31to60.count
    + buckets.late61plus.count;

  writeAuditLog(req.user.sub, 'READ_DASHBOARD', 'billing-insights', null, {
    from: range.fromIso,
    to: range.toIso,
    operationCount: currentPayload.stats.operationCount,
    outstandingCount: totalOutstandingCount
  });

  return res.json({
    range: {
      fromIso: range.fromIso,
      toIso: range.toIso,
      previousFromIso: previousFrom.toISOString(),
      previousToIso: previousTo.toISOString()
    },
    kpis: {
      current: {
        creditsCents: currentPayload.stats.creditCents,
        debitsCents: currentPayload.stats.debitCents,
        netCents: currentPayload.stats.netCents,
        operationCount: currentPayload.stats.operationCount
      },
      previous: {
        creditsCents: previousPayload.stats.creditCents,
        debitsCents: previousPayload.stats.debitCents,
        netCents: previousPayload.stats.netCents,
        operationCount: previousPayload.stats.operationCount
      },
      trends: {
        creditsPercent: computeTrendPercent(currentPayload.stats.creditCents, previousPayload.stats.creditCents),
        debitsPercent: computeTrendPercent(currentPayload.stats.debitCents, previousPayload.stats.debitCents),
        netPercent: computeTrendPercent(currentPayload.stats.netCents, previousPayload.stats.netCents),
        operationsPercent: computeTrendPercent(currentPayload.stats.operationCount, previousPayload.stats.operationCount)
      }
    },
    receivables: {
      totalOutstandingCents,
      totalOutstandingCount,
      aging: buckets,
      topDebtors
    },
    paymentMethods,
    summary: currentPayload.summary
  });
});

app.get('/api/billing/forecast', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);
  const requestedOfficeId = Number(req.query.officeId);

  if (Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 && filterOfficeIds.length === 0) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }

  const effectiveOfficeIds = filterOfficeIds.length > 0 ? filterOfficeIds : availableOfficeIds;
  const now = new Date();
  const horizons = [30, 60, 90];

  const historicalFrom = new Date(now.getTime() - (90 * 24 * 60 * 60 * 1000)).toISOString();
  const historicalPayload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: historicalFrom,
    toIso: now.toISOString(),
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: null
  });

  const dailyNetCents = historicalPayload.stats.netCents / 90;
  const dayMs = 24 * 60 * 60 * 1000;
  const perHorizon = {};

  let unpaidRows = [];
  if (effectiveOfficeIds.length > 0) {
    unpaidRows = db
      .prepare(
        `SELECT i.id, i.amount_cents, i.issued_at, i.due_at, i.office_id,
                COALESCE(pay.paid_cents, 0) AS paid_cents
         FROM invoices i
         LEFT JOIN (
           SELECT invoice_id, SUM(amount_cents) AS paid_cents
           FROM invoice_payments
           GROUP BY invoice_id
         ) pay ON pay.invoice_id = i.id
         WHERE i.status <> 'payee'
         ORDER BY datetime(COALESCE(i.due_at, i.issued_at)) ASC, i.id ASC`
      )
      .all()
      .filter((row) => {
        const officeId = row.office_id != null ? Number(row.office_id) : null;
        return officeId != null && effectiveOfficeIds.includes(officeId);
      });
  }

  const overdueOutstandingCents = unpaidRows.reduce((sum, row) => {
    const remaining = Math.max(0, Number(row.amount_cents ?? 0) - Number(row.paid_cents ?? 0));
    if (remaining <= 0) {
      return sum;
    }

    const dueAtMs = new Date(String(row.due_at ?? row.issued_at ?? '')).getTime();
    if (!Number.isFinite(dueAtMs) || dueAtMs > now.getTime()) {
      return sum;
    }

    return sum + remaining;
  }, 0);

  for (const horizon of horizons) {
    const horizonEnd = new Date(now.getTime() + (horizon * dayMs));
    const expectedReceiptsCents = unpaidRows.reduce((sum, row) => {
      const remaining = Math.max(0, Number(row.amount_cents ?? 0) - Number(row.paid_cents ?? 0));
      if (remaining <= 0) {
        return sum;
      }

      const dueAtMs = new Date(String(row.due_at ?? row.issued_at ?? '')).getTime();
      if (!Number.isFinite(dueAtMs) || dueAtMs > horizonEnd.getTime()) {
        return sum;
      }

      return sum + remaining;
    }, 0);

    perHorizon[String(horizon)] = {
      expectedReceiptsCents,
      projectedNetRunRateCents: Math.round(dailyNetCents * horizon),
      horizonEndIso: horizonEnd.toISOString()
    };
  }

  writeAuditLog(req.user.sub, 'READ_DASHBOARD', 'billing-forecast', null, {
    officeCount: effectiveOfficeIds.length,
    overdueOutstandingCents
  });

  return res.json({
    generatedAt: now.toISOString(),
    officeIds: effectiveOfficeIds,
    trailing90Days: {
      creditsCents: historicalPayload.stats.creditCents,
      debitsCents: historicalPayload.stats.debitCents,
      netCents: historicalPayload.stats.netCents,
      averageDailyNetCents: Math.round(dailyNetCents)
    },
    overdueOutstandingCents,
    horizons: perHorizon
  });
});

app.get('/api/billing/alerts', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const requestedCategories = String(req.query.categories ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowedCategories = new Set(['overdue', 'dueSoon', 'highExpenses', 'unassigned']);
  if (requestedCategories.some((category) => !allowedCategories.has(category))) {
    return res.status(400).json({ message: 'Categorie d\'alerte invalide' });
  }
  const includeAllCategories = requestedCategories.length === 0;
  const includeOverdue = includeAllCategories || requestedCategories.includes('overdue');
  const includeDueSoon = includeAllCategories || requestedCategories.includes('dueSoon');
  const includeHighExpenses = includeAllCategories || requestedCategories.includes('highExpenses');
  const includeUnassigned = includeAllCategories || requestedCategories.includes('unassigned');

  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);
  const requestedOfficeId = Number(req.query.officeId);

  if (Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 && filterOfficeIds.length === 0) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }

  const effectiveOfficeIds = filterOfficeIds.length > 0 ? filterOfficeIds : availableOfficeIds;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  let overdueCritical = [];
  let dueSoon = [];
  let highExpenses = [];

  if (effectiveOfficeIds.length > 0) {
    const unpaidRows = db
      .prepare(
        `SELECT i.id, i.invoice_number, i.amount_cents, i.issued_at, i.due_at, i.office_id,
                p.cipher_full_name,
                COALESCE(pay.paid_cents, 0) AS paid_cents
         FROM invoices i
         INNER JOIN patients p ON p.id = i.patient_id
         LEFT JOIN (
           SELECT invoice_id, SUM(amount_cents) AS paid_cents
           FROM invoice_payments
           GROUP BY invoice_id
         ) pay ON pay.invoice_id = i.id
         WHERE i.status <> 'payee'
         ORDER BY datetime(COALESCE(i.due_at, i.issued_at)) ASC, i.id ASC`
      )
      .all()
      .filter((row) => {
        const officeId = row.office_id != null ? Number(row.office_id) : null;
        return officeId != null && effectiveOfficeIds.includes(officeId);
      });

    for (const row of unpaidRows) {
      const remainingAmountCents = Math.max(0, Number(row.amount_cents ?? 0) - Number(row.paid_cents ?? 0));
      if (remainingAmountCents <= 0) {
        continue;
      }

      const dueAtMs = new Date(String(row.due_at ?? row.issued_at ?? '')).getTime();
      if (!Number.isFinite(dueAtMs)) {
        continue;
      }

      const daysLate = Math.floor((now - dueAtMs) / dayMs);
      if (daysLate > 60) {
        overdueCritical.push({
          invoiceId: Number(row.id),
          invoiceNumber: String(row.invoice_number ?? '').trim(),
          patientName: decryptSensitiveField(row.cipher_full_name),
          dueAt: String(row.due_at ?? row.issued_at ?? ''),
          daysLate,
          remainingAmountCents,
          officeId: row.office_id != null ? Number(row.office_id) : null
        });
      } else if (daysLate <= 0 && dueAtMs <= now + (7 * dayMs)) {
        dueSoon.push({
          invoiceId: Number(row.id),
          invoiceNumber: String(row.invoice_number ?? '').trim(),
          patientName: decryptSensitiveField(row.cipher_full_name),
          dueAt: String(row.due_at ?? row.issued_at ?? ''),
          remainingAmountCents,
          officeId: row.office_id != null ? Number(row.office_id) : null
        });
      }
    }

    overdueCritical = overdueCritical
      .sort((left, right) => right.daysLate - left.daysLate || right.remainingAmountCents - left.remainingAmountCents)
      .slice(0, 20);
    dueSoon = dueSoon
      .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime() || right.remainingAmountCents - left.remainingAmountCents)
      .slice(0, 20);

    const expensesRows = db
      .prepare(
        `SELECT id, occurred_at, office_id, title, amount_cents, currency
         FROM accounting_expenses
         WHERE is_deleted = 0
           AND datetime(occurred_at) >= datetime(?)
         ORDER BY datetime(occurred_at) DESC, id DESC`
      )
      .all(new Date(now - (30 * dayMs)).toISOString())
      .filter((row) => {
        const officeId = row.office_id != null ? Number(row.office_id) : null;
        return officeId != null && effectiveOfficeIds.includes(officeId);
      });

    const avgExpenseCents = expensesRows.length > 0
      ? Math.round(expensesRows.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0) / expensesRows.length)
      : 0;
    const thresholdCents = avgExpenseCents > 0 ? Math.max(avgExpenseCents * 2, 50000) : 50000;

    highExpenses = expensesRows
      .filter((row) => Number(row.amount_cents ?? 0) >= thresholdCents)
      .slice(0, 20)
      .map((row) => ({
        expenseId: Number(row.id),
        occurredAt: String(row.occurred_at ?? ''),
        title: String(row.title ?? '').trim() || 'Depense',
        amountCents: Number(row.amount_cents ?? 0),
        currency: String(row.currency ?? 'EUR').trim() || 'EUR',
        officeId: row.office_id != null ? Number(row.office_id) : null
      }));
  }

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
  const operationsPayload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: monthStart,
    toIso: monthEnd,
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: null
  });
  const unassignedOwnerOperations = operationsPayload.operations
    .filter((operation) => operation.ownerUserId == null)
    .slice(0, 30)
    .map((operation) => ({
      id: operation.id,
      sourceType: operation.sourceType,
      occurredAt: operation.occurredAt,
      title: operation.title,
      officeId: operation.officeId
    }));

  writeAuditLog(req.user.sub, 'READ_DASHBOARD', 'billing-alerts', null, {
    overdueCriticalCount: includeOverdue ? overdueCritical.length : 0,
    dueSoonCount: includeDueSoon ? dueSoon.length : 0,
    highExpensesCount: includeHighExpenses ? highExpenses.length : 0,
    unassignedOwnerCount: includeUnassigned ? unassignedOwnerOperations.length : 0
  });

  return res.json({
    generatedAt: new Date().toISOString(),
    summary: {
      overdueCriticalCount: includeOverdue ? overdueCritical.length : 0,
      dueSoonCount: includeDueSoon ? dueSoon.length : 0,
      highExpensesCount: includeHighExpenses ? highExpenses.length : 0,
      unassignedOwnerCount: includeUnassigned ? unassignedOwnerOperations.length : 0
    },
    overdueCritical: includeOverdue ? overdueCritical : [],
    dueSoon: includeDueSoon ? dueSoon : [],
    highExpenses: includeHighExpenses ? highExpenses : [],
    unassignedOwnerOperations: includeUnassigned ? unassignedOwnerOperations : []
  });
});

app.get('/api/billing/alerts/export', authMiddleware, requirePermission('export-billing'), (req, res) => {
  const format = String(req.query.format ?? 'excel').trim().toLowerCase();
  if (!['json', 'excel'].includes(format)) {
    return res.status(400).json({ message: 'Format invalide' });
  }
  const requestedCategories = String(req.query.categories ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const allowedCategories = new Set(['overdue', 'dueSoon', 'highExpenses', 'unassigned']);
  if (requestedCategories.some((category) => !allowedCategories.has(category))) {
    return res.status(400).json({ message: 'Categorie d\'alerte invalide' });
  }
  const includeAllCategories = requestedCategories.length === 0;
  const includeOverdue = includeAllCategories || requestedCategories.includes('overdue');
  const includeDueSoon = includeAllCategories || requestedCategories.includes('dueSoon');
  const includeHighExpenses = includeAllCategories || requestedCategories.includes('highExpenses');
  const includeUnassigned = includeAllCategories || requestedCategories.includes('unassigned');

  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);
  const requestedOfficeId = Number(req.query.officeId);

  if (Number.isInteger(requestedOfficeId) && requestedOfficeId > 0 && filterOfficeIds.length === 0) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }

  const effectiveOfficeIds = filterOfficeIds.length > 0 ? filterOfficeIds : availableOfficeIds;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  let overdueCritical = [];
  let dueSoon = [];
  let highExpenses = [];

  if (effectiveOfficeIds.length > 0) {
    const unpaidRows = db
      .prepare(
        `SELECT i.id, i.invoice_number, i.amount_cents, i.issued_at, i.due_at, i.office_id,
                p.cipher_full_name,
                COALESCE(pay.paid_cents, 0) AS paid_cents
         FROM invoices i
         INNER JOIN patients p ON p.id = i.patient_id
         LEFT JOIN (
           SELECT invoice_id, SUM(amount_cents) AS paid_cents
           FROM invoice_payments
           GROUP BY invoice_id
         ) pay ON pay.invoice_id = i.id
         WHERE i.status <> 'payee'
         ORDER BY datetime(COALESCE(i.due_at, i.issued_at)) ASC, i.id ASC`
      )
      .all()
      .filter((row) => {
        const officeId = row.office_id != null ? Number(row.office_id) : null;
        return officeId != null && effectiveOfficeIds.includes(officeId);
      });

    for (const row of unpaidRows) {
      const remainingAmountCents = Math.max(0, Number(row.amount_cents ?? 0) - Number(row.paid_cents ?? 0));
      if (remainingAmountCents <= 0) {
        continue;
      }

      const dueAtMs = new Date(String(row.due_at ?? row.issued_at ?? '')).getTime();
      if (!Number.isFinite(dueAtMs)) {
        continue;
      }

      const daysLate = Math.floor((now - dueAtMs) / dayMs);
      if (daysLate > 60) {
        overdueCritical.push({
          invoiceId: Number(row.id),
          invoiceNumber: String(row.invoice_number ?? '').trim(),
          patientName: decryptSensitiveField(row.cipher_full_name),
          dueAt: String(row.due_at ?? row.issued_at ?? ''),
          daysLate,
          remainingAmountCents,
          officeId: row.office_id != null ? Number(row.office_id) : null
        });
      } else if (daysLate <= 0 && dueAtMs <= now + (7 * dayMs)) {
        dueSoon.push({
          invoiceId: Number(row.id),
          invoiceNumber: String(row.invoice_number ?? '').trim(),
          patientName: decryptSensitiveField(row.cipher_full_name),
          dueAt: String(row.due_at ?? row.issued_at ?? ''),
          remainingAmountCents,
          officeId: row.office_id != null ? Number(row.office_id) : null
        });
      }
    }

    overdueCritical = overdueCritical
      .sort((left, right) => right.daysLate - left.daysLate || right.remainingAmountCents - left.remainingAmountCents)
      .slice(0, 20);
    dueSoon = dueSoon
      .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime() || right.remainingAmountCents - left.remainingAmountCents)
      .slice(0, 20);

    const expensesRows = db
      .prepare(
        `SELECT id, occurred_at, office_id, title, amount_cents, currency
         FROM accounting_expenses
         WHERE is_deleted = 0
           AND datetime(occurred_at) >= datetime(?)
         ORDER BY datetime(occurred_at) DESC, id DESC`
      )
      .all(new Date(now - (30 * dayMs)).toISOString())
      .filter((row) => {
        const officeId = row.office_id != null ? Number(row.office_id) : null;
        return officeId != null && effectiveOfficeIds.includes(officeId);
      });

    const avgExpenseCents = expensesRows.length > 0
      ? Math.round(expensesRows.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0) / expensesRows.length)
      : 0;
    const thresholdCents = avgExpenseCents > 0 ? Math.max(avgExpenseCents * 2, 50000) : 50000;

    highExpenses = expensesRows
      .filter((row) => Number(row.amount_cents ?? 0) >= thresholdCents)
      .slice(0, 20)
      .map((row) => ({
        expenseId: Number(row.id),
        occurredAt: String(row.occurred_at ?? ''),
        title: String(row.title ?? '').trim() || 'Depense',
        amountCents: Number(row.amount_cents ?? 0),
        currency: String(row.currency ?? 'EUR').trim() || 'EUR',
        officeId: row.office_id != null ? Number(row.office_id) : null
      }));
  }

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
  const operationsPayload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: monthStart,
    toIso: monthEnd,
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: null
  });
  const unassignedOwnerOperations = operationsPayload.operations
    .filter((operation) => operation.ownerUserId == null)
    .slice(0, 30)
    .map((operation) => ({
      id: operation.id,
      sourceType: operation.sourceType,
      occurredAt: operation.occurredAt,
      title: operation.title,
      officeId: operation.officeId
    }));

  const payload = {
    generatedAt: new Date().toISOString(),
    summary: {
      overdueCriticalCount: includeOverdue ? overdueCritical.length : 0,
      dueSoonCount: includeDueSoon ? dueSoon.length : 0,
      highExpensesCount: includeHighExpenses ? highExpenses.length : 0,
      unassignedOwnerCount: includeUnassigned ? unassignedOwnerOperations.length : 0
    },
    overdueCritical: includeOverdue ? overdueCritical : [],
    dueSoon: includeDueSoon ? dueSoon : [],
    highExpenses: includeHighExpenses ? highExpenses : [],
    unassignedOwnerOperations: includeUnassigned ? unassignedOwnerOperations : []
  };

  writeAuditLog(req.user.sub, 'EXPORT', 'billing-alerts', null, {
    format,
    overdueCriticalCount: overdueCritical.length,
    dueSoonCount: dueSoon.length,
    highExpensesCount: highExpenses.length,
    unassignedOwnerCount: unassignedOwnerOperations.length
  });

  const datePart = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    const fileName = `billing-alerts-${datePart}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(JSON.stringify(payload, null, 2));
  }

  const header = ['Category', 'Id', 'Reference', 'Patient', 'Date', 'MetricA', 'AmountCents', 'OfficeId'];
  const rows = [];

  for (const item of payload.overdueCritical) {
    rows.push([
      'overdue-critical',
      String(item.invoiceId),
      item.invoiceNumber,
      item.patientName,
      item.dueAt,
      String(item.daysLate),
      String(item.remainingAmountCents),
      item.officeId != null ? String(item.officeId) : ''
    ]);
  }
  for (const item of payload.dueSoon) {
    rows.push([
      'due-soon',
      String(item.invoiceId),
      item.invoiceNumber,
      item.patientName,
      item.dueAt,
      '',
      String(item.remainingAmountCents),
      item.officeId != null ? String(item.officeId) : ''
    ]);
  }
  for (const item of payload.highExpenses) {
    rows.push([
      'high-expense',
      String(item.expenseId),
      '',
      '',
      item.occurredAt,
      item.title,
      String(item.amountCents),
      item.officeId != null ? String(item.officeId) : ''
    ]);
  }
  for (const item of payload.unassignedOwnerOperations) {
    rows.push([
      'unassigned-owner',
      String(item.id),
      item.sourceType,
      '',
      item.occurredAt,
      item.title,
      '',
      item.officeId != null ? String(item.officeId) : ''
    ]);
  }

  const csv = [header, ...rows]
    .map((line) => line.map((value) => serializeCsvCell(value, ';')).join(';'))
    .join('\n');

  const fileName = `billing-alerts-${datePart}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(`\ufeff${csv}`);
});

app.get('/api/billing/invoices/:id', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const invoice = getInvoiceDetail(id);
  if (!invoice) {
    return res.status(404).json({ message: 'Facture introuvable' });
  }

  const invoiceOfficeId = invoice.officeId;
  if (invoiceOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(invoiceOfficeId)) {
        return res.status(403).json({ message: 'Acces refuse - facture d\'un autre cabinet' });
      }
    }
  }

  writeAuditLog(req.user.sub, 'READ', 'invoices', String(id), {});

  return res.json({ invoice });
});

app.post('/api/billing/invoices', authMiddleware, requirePermission('invoice-consultation'), (req, res) => {
  const patientId = Number(req.body?.patientId);
  const consultationId = req.body?.consultationId != null ? Number(req.body.consultationId) : null;
  const officeId = req.body?.officeId != null ? Number(req.body.officeId) : null;
  const invoiceNumber = String(req.body?.invoiceNumber ?? '').trim();
  const amountCents = Math.round(Number(req.body?.amountCents ?? 0));
  const status = String(req.body?.status ?? 'payee').trim();
  const issuedAt = String(req.body?.issuedAt ?? new Date().toISOString()).trim();
  const notes = String(req.body?.notes ?? '').trim();
  const paymentMethod = String(req.body?.paymentMethod ?? '').trim();
  const currency = String(req.body?.currency ?? 'EUR').trim() || 'EUR';
  const lineItems = normalizeInvoiceLineItems(req.body?.lineItems, amountCents);
  const payments = normalizeInvoicePayments(req.body?.payments, paymentMethod, currency, amountCents, issuedAt);
  if (payments.some((payment) => inferPaymentMethodSystemKey(payment.paymentMethod) === 'cheque' && (!String(payment.bankName ?? '').trim() || !String(payment.chequeNumber ?? '').trim()))) {
    return res.status(400).json({ message: 'La banque et le numero de chèque sont obligatoires pour un paiement par chèque.' });
  }

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'Patient invalide' });
  }
  if (!invoiceNumber) {
    return res.status(400).json({ message: 'Numéro de facture requis' });
  }
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    return res.status(400).json({ message: 'Montant invalide' });
  }

  const patient = db.prepare('SELECT id, office_id FROM patients WHERE id = ? AND is_deleted = 0').get(patientId);
  if (!patient) {
    return res.status(404).json({ message: 'Patient introuvable' });
  }

  const patientOfficeId = patient.office_id != null ? Number(patient.office_id) : null;
  if (patientOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(patientOfficeId)) {
        return res.status(403).json({ message: 'Acces refuse - patient d\'un autre cabinet' });
      }
    }
  }

  const existing = db.prepare('SELECT id FROM invoices WHERE invoice_number = ?').get(invoiceNumber);
  if (existing) {
    return res.status(200).json({ invoiceId: Number(existing.id) });
  }

  const requestedOfficeId = Number.isInteger(officeId) && officeId > 0 ? officeId : null;
  if (requestedOfficeId !== null) {
    const scopedOfficeIds = getScopedBillingOfficeIds(req.userAccess, requestedOfficeId);
    if (!scopedOfficeIds.length) {
      return res.status(403).json({ message: 'Cabinet inaccessible' });
    }
  }

  const effectiveOfficeId = requestedOfficeId ?? patientOfficeId;
  const effectiveConsultationId = Number.isInteger(consultationId) && consultationId > 0 ? consultationId : null;
  const effectiveStatus = computeInvoiceStatusFromPayments(amountCents, payments, status);
  const dueAt = issuedAt;
  const notesCipher = notes ? encryptSensitiveField(notes) : '';

  const createInvoice = db.transaction(() => {
    const inserted = db.prepare(
      `INSERT INTO invoices
        (patient_id, invoice_number, amount_cents, status, issued_at, due_at, notes_cipher, office_id, consultation_id, payment_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      patientId,
      invoiceNumber,
      amountCents,
      effectiveStatus,
      issuedAt,
      dueAt,
      notesCipher,
      effectiveOfficeId,
      effectiveConsultationId,
      paymentMethod
    );

    const invoiceId = Number(inserted.lastInsertRowid);
    const insertLineItem = db.prepare(
      `INSERT INTO invoice_line_items (invoice_id, label, quantity, unit_amount_ht_cents, vat_rate, display_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertPayment = db.prepare(
      `INSERT INTO invoice_payments (invoice_id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const item of lineItems) {
      insertLineItem.run(
        invoiceId,
        item.label,
        item.quantity,
        item.unitAmountHtCents,
        item.vatRate,
        item.displayOrder
      );
    }

    for (const payment of payments) {
      insertPayment.run(
        invoiceId,
        payment.paidAt,
        payment.amountCents,
        payment.currency,
        payment.paymentMethod,
        payment.bankName ? encryptSensitiveField(payment.bankName) : '',
        payment.chequeNumber,
        payment.reference,
        payment.notes,
        req.user.sub
      );
    }

    return invoiceId;
  });

  const invoiceId = createInvoice();

  writeAuditLog(req.user.sub, 'CREATE', 'invoices', String(invoiceId), {
    patientId,
    invoiceNumber,
    amountCents,
    lineItemCount: lineItems.length,
    paymentCount: payments.length
  });

  return res.status(201).json({ invoiceId });
});

app.delete('/api/billing/invoices/:id', authMiddleware, requirePermission('cancel-invoice'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const row = db.prepare('SELECT id, office_id FROM invoices WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ message: 'Facture introuvable' });
  }

  const invoiceOfficeId = row.office_id != null ? Number(row.office_id) : null;
  if (invoiceOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(invoiceOfficeId)) {
        return res.status(403).json({ message: 'Acces refuse - facture d\'un autre cabinet' });
      }
    }
  }

  db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  writeAuditLog(req.user.sub, 'DELETE', 'invoices', String(id), {});

  return res.json({ ok: true });
});

app.put('/api/billing/invoices/:id/payments', authMiddleware, requirePermission('mark-payment'), (req, res) => {
  const invoiceId = Number(req.params.id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return res.status(400).json({ message: 'ID invalide' });
  }

  const invoice = db.prepare(
    `SELECT id, amount_cents, status, office_id
     FROM invoices
     WHERE id = ?`
  ).get(invoiceId);

  if (!invoice) {
    return res.status(404).json({ message: 'Facture introuvable' });
  }

  const invoiceOfficeId = invoice.office_id != null ? Number(invoice.office_id) : null;
  if (invoiceOfficeId !== null) {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (!isAdmin) {
      const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
      if (!accessibleOfficeIds.includes(invoiceOfficeId)) {
        return res.status(403).json({ message: 'Acces refuse - facture d\'un autre cabinet' });
      }
    }
  }

  const payments = normalizeInvoicePayments(
    req.body?.payments,
    '',
    'EUR',
    0,
    new Date().toISOString()
  );
  if (payments.some((payment) => inferPaymentMethodSystemKey(payment.paymentMethod) === 'cheque' && (!String(payment.bankName ?? '').trim() || !String(payment.chequeNumber ?? '').trim()))) {
    return res.status(400).json({ message: 'La banque et le numero de chèque sont obligatoires pour un paiement par chèque.' });
  }

  const replacePayments = db.transaction(() => {
    db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(invoiceId);

    for (const payment of payments) {
      appendInvoicePayment(invoiceId, payment, req.user.sub);
    }
    refreshInvoicePaymentState(invoiceId);
  });

  replacePayments();

  const detail = getInvoiceDetail(invoiceId);
  writeAuditLog(req.user.sub, 'UPDATE', 'invoices', String(invoiceId), {
    paymentCount: payments.length,
    status: detail?.status ?? String(invoice.status ?? '')
  });

  return res.json({ invoice: detail });
});

app.post('/api/billing/invoice-payments/grouped', authMiddleware, requirePermission('mark-payment'), (req, res) => {
  const invoiceIds = Array.isArray(req.body?.invoiceIds)
    ? [...new Set(req.body.invoiceIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];

  const amountCents = Math.round(Number(req.body?.payment?.amountCents ?? 0));
  const paidAt = String(req.body?.payment?.paidAt ?? new Date().toISOString()).trim() || new Date().toISOString();
  const currency = String(req.body?.payment?.currency ?? 'EUR').trim() || 'EUR';
  const paymentMethod = String(req.body?.payment?.paymentMethod ?? '').trim();
  const bankName = String(req.body?.payment?.bankName ?? '').trim();
  const chequeNumber = String(req.body?.payment?.chequeNumber ?? '').trim();
  const reference = String(req.body?.payment?.reference ?? '').trim();
  const notes = String(req.body?.payment?.notes ?? '').trim();

  if (invoiceIds.length === 0) {
    return res.status(400).json({ message: 'Selectionnez au moins une facture.' });
  }
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return res.status(400).json({ message: 'Montant invalide.' });
  }
  if (!paymentMethod) {
    return res.status(400).json({ message: 'Moyen de paiement requis.' });
  }
  if (inferPaymentMethodSystemKey(paymentMethod) === 'cheque' && (!bankName || !chequeNumber)) {
    return res.status(400).json({ message: 'La banque et le numero de chèque sont obligatoires pour un paiement par chèque.' });
  }

  const placeholders = invoiceIds.map(() => '?').join(', ');
  const invoices = db.prepare(
    `SELECT id, invoice_number, amount_cents, office_id, issued_at
     FROM invoices
     WHERE id IN (${placeholders})
     ORDER BY datetime(issued_at) ASC, id ASC`
  ).all(...invoiceIds);

  if (invoices.length !== invoiceIds.length) {
    return res.status(404).json({ message: 'Une ou plusieurs factures sont introuvables.' });
  }

  const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
  if (!isAdmin) {
    const accessibleOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
    for (const invoice of invoices) {
      const officeId = invoice.office_id != null ? Number(invoice.office_id) : null;
      if (officeId !== null && !accessibleOfficeIds.includes(officeId)) {
        return res.status(403).json({ message: 'Acces refuse - facture d\'un autre cabinet' });
      }
    }
  }

  const groupRef = `GP-${Date.now()}`;
  const allocateGroupedPayment = db.transaction(() => {
    let remainingCents = amountCents;
    const allocations = [];

    for (const invoice of invoices) {
      if (remainingCents <= 0) {
        break;
      }

      const alreadyPaidCents = Number(db.prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS paid
         FROM invoice_payments
         WHERE invoice_id = ?`
      ).get(invoice.id)?.paid ?? 0);

      const invoiceAmountCents = Number(invoice.amount_cents ?? 0);
      const remainingForInvoice = Math.max(0, invoiceAmountCents - alreadyPaidCents);
      const allocatedAmountCents = Math.min(remainingForInvoice, remainingCents);

      if (allocatedAmountCents <= 0) {
        continue;
      }

      appendInvoicePayment(invoice.id, {
        paidAt,
        amountCents: allocatedAmountCents,
        currency,
        paymentMethod,
        bankName,
        chequeNumber,
        reference,
        notes: [notes, `[encaissement groupe ${groupRef}]`].filter(Boolean).join(' | ')
      }, req.user.sub);
      refreshInvoicePaymentState(invoice.id);

      allocations.push({
        invoiceId: Number(invoice.id),
        invoiceNumber: String(invoice.invoice_number ?? '').trim(),
        allocatedAmountCents
      });

      remainingCents -= allocatedAmountCents;
    }

    return {
      allocations,
      remainingCents
    };
  });

  const result = allocateGroupedPayment();
  const allocatedAmountCents = result.allocations.reduce((sum, item) => sum + Number(item.allocatedAmountCents ?? 0), 0);

  writeAuditLog(req.user.sub, 'CREATE', 'grouped-invoice-payment', groupRef, {
    invoiceCount: invoices.length,
    totalAmountCents: amountCents,
    allocatedAmountCents,
    unallocatedAmountCents: Math.max(0, result.remainingCents)
  });

  return res.status(201).json({
    groupedPayment: {
      reference: groupRef,
      totalAmountCents: amountCents,
      allocatedAmountCents,
      unallocatedAmountCents: Math.max(0, result.remainingCents),
      allocations: result.allocations
    }
  });
});

app.post('/api/billing/expenses', authMiddleware, requirePermission('mark-payment'), (req, res) => {
  const occurredAt = String(req.body?.occurredAt ?? '').trim() || new Date().toISOString();
  const title = String(req.body?.title ?? '').trim();
  const amount = Number(req.body?.amount ?? 0);
  const currency = String(req.body?.currency ?? 'EUR').trim() || 'EUR';
  const officeId = Number(req.body?.officeId);
  const ownerUserId = Number(req.body?.ownerUserId);
  const paymentMethod = String(req.body?.paymentMethod ?? '').trim();
  const notes = String(req.body?.notes ?? '').trim();

  if (!title) {
    return res.status(400).json({ message: 'Titre requis' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Montant invalide' });
  }

  const officeIds = getScopedBillingOfficeIds(req.userAccess, officeId);
  if (!officeIds.length) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }
  const effectiveOfficeId = officeIds[0];

  const validatedOwnerUserId = Number.isInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null;
  const inserted = db.prepare(
    `INSERT INTO accounting_expenses
      (occurred_at, office_id, owner_user_id, title, amount_cents, currency, payment_method, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    occurredAt,
    effectiveOfficeId,
    validatedOwnerUserId,
    title,
    Math.round(amount * 100),
    currency,
    paymentMethod,
    notes,
    req.user.sub
  );

  writeAuditLog(req.user.sub, 'CREATE', 'billing-expense', String(inserted.lastInsertRowid), {
    officeId: effectiveOfficeId,
    amount
  });

  return res.status(201).json({
    expenseId: Number(inserted.lastInsertRowid)
  });
});

app.post('/api/billing/deposits', authMiddleware, requirePermission('mark-payment'), (req, res) => {
  const occurredAt = String(req.body?.occurredAt ?? '').trim() || new Date().toISOString();
  const type = String(req.body?.type ?? 'cheque').trim().toLowerCase() === 'especes' ? 'especes' : 'cheque';
  const title = type === 'especes' ? 'Remise d\'especes' : 'Remise de cheques';
  const amountRaw = Number(req.body?.amount ?? NaN);
  const currency = String(req.body?.currency ?? 'EUR').trim() || 'EUR';
  const officeId = Number(req.body?.officeId);
  const ownerUserId = Number(req.body?.ownerUserId);
  const notes = '';
  const operationIds = Array.isArray(req.body?.operationIds) ? req.body.operationIds : [];

  const userProfile = db
    .prepare(
      `SELECT username, last_name, first_name, bank_name_cipher, iban_cipher
       FROM users
       WHERE id = ?`
    )
    .get(req.user.sub);

  const trigramSeed = [
    String(userProfile?.last_name ?? ''),
    String(userProfile?.first_name ?? ''),
    String(userProfile?.username ?? '')
  ]
    .join('')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '');

  let trigram = 'USR';
  if (trigramSeed.length >= 3) {
    trigram = trigramSeed.slice(0, 3);
  } else if (trigramSeed.length === 2) {
    trigram = `${trigramSeed}X`;
  } else if (trigramSeed.length === 1) {
    trigram = `${trigramSeed}XX`;
  }

  const occurredAtDate = new Date(occurredAt);
  const safeDate = Number.isNaN(occurredAtDate.getTime()) ? new Date() : occurredAtDate;
  const yyyy = String(safeDate.getFullYear());
  const mm = String(safeDate.getMonth() + 1).padStart(2, '0');
  const dd = String(safeDate.getDate()).padStart(2, '0');
  const depositCode = `${trigram}-${yyyy}${mm}${dd}`;
  const bankNameCipher = String(userProfile?.bank_name_cipher ?? '');
  const accountLabel = safeDecryptField(String(userProfile?.iban_cipher ?? '')).trim();

  const officeIds = getScopedBillingOfficeIds(req.userAccess, officeId);
  if (!officeIds.length) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }
  const effectiveOfficeId = officeIds[0];

  const parsedOperationIds = operationIds
    .map((value) => parseBillingOperationId(value))
    .filter(Boolean);

  let computedAmountCents = 0;
  if (Number.isFinite(amountRaw) && amountRaw > 0) {
    computedAmountCents = Math.round(amountRaw * 100);
  } else if (parsedOperationIds.length > 0) {
    const invoiceIds = parsedOperationIds.filter((item) => item.sourceType === 'invoice').map((item) => item.sourceId);
    if (invoiceIds.length > 0) {
      const placeholders = invoiceIds.map(() => '?').join(', ');
      const invoiceRows = db
        .prepare(`SELECT id, amount_cents, office_id FROM invoices WHERE id IN (${placeholders})`)
        .all(...invoiceIds);
      if (invoiceRows.length !== invoiceIds.length) {
        return res.status(400).json({ message: 'Operations de remise invalides' });
      }
      const hasForeignOffice = invoiceRows.some((row) => Number(row.office_id) !== Number(effectiveOfficeId));
      if (hasForeignOffice) {
        return res.status(403).json({ message: 'Cabinet inaccessible' });
      }
      computedAmountCents += invoiceRows.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0);
    }
  }

  if (computedAmountCents <= 0) {
    return res.status(400).json({ message: 'Montant de remise invalide' });
  }

  const validatedOwnerUserId = Number.isInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null;
  const tx = db.transaction(() => {
    const inserted = db.prepare(
      `INSERT INTO accounting_deposits
        (occurred_at, office_id, owner_user_id, type, deposit_code, bank_name_cipher, account_label, title, amount_cents, currency, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      occurredAt,
      effectiveOfficeId,
      validatedOwnerUserId,
      type,
      depositCode,
      bankNameCipher,
      accountLabel,
      title,
      computedAmountCents,
      currency,
      notes,
      req.user.sub
    );

    const depositId = Number(inserted.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT OR IGNORE INTO accounting_deposit_items (deposit_id, source_type, source_id)
       VALUES (?, ?, ?)`
    );
    for (const item of parsedOperationIds) {
      insertItem.run(depositId, item.sourceType, item.sourceId);
    }

    return depositId;
  });

  const depositId = tx();

  writeAuditLog(req.user.sub, 'CREATE', 'billing-deposit', String(depositId), {
    officeId: effectiveOfficeId,
    amountCents: computedAmountCents,
    itemCount: parsedOperationIds.length
  });

  return res.status(201).json({ depositId });
});

app.get('/api/billing/deposits', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const type = String(req.query.type ?? 'cheque').trim().toLowerCase() === 'especes' ? 'especes' : 'cheque';
  const officeId = Number(req.query.officeId);
  const scopedOfficeIds = getScopedBillingOfficeIds(req.userAccess, officeId);

  if (!scopedOfficeIds.length) {
    return res.json({ deposits: [] });
  }

  const placeholders = scopedOfficeIds.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT d.id, d.type, d.deposit_code, d.occurred_at, d.bank_name_cipher, d.account_label, d.title,
            d.amount_cents, d.currency, d.office_id, d.notes, o.name AS office_name,
            (
              SELECT COUNT(*)
              FROM accounting_deposit_items di
              WHERE di.deposit_id = d.id AND di.source_type = 'invoice'
            ) AS cheque_count
     FROM accounting_deposits d
     LEFT JOIN offices o ON o.id = d.office_id
     WHERE d.is_deleted = 0
       AND d.type = ?
       AND d.office_id IN (${placeholders})
     ORDER BY datetime(d.occurred_at) DESC, d.id DESC`
  ).all(type, ...scopedOfficeIds);

  const itemRows = db.prepare(
    `SELECT deposit_id, source_type, source_id
     FROM accounting_deposit_items
     WHERE deposit_id IN (${rows.map(() => '?').join(', ') || 'NULL'})`
  ).all(...rows.map((row) => Number(row.id)));

  const itemMap = new Map();
  for (const row of itemRows) {
    const key = Number(row.deposit_id);
    if (!itemMap.has(key)) {
      itemMap.set(key, []);
    }
    itemMap.get(key).push(`${row.source_type}:${Number(row.source_id)}`);
  }

  return res.json({
    deposits: rows.map((row) => ({
      id: Number(row.id),
      type: row.type === 'especes' ? 'especes' : 'cheque',
      code: String(row.deposit_code ?? '').trim(),
      occurredAt: String(row.occurred_at),
      bankName: safeDecryptField(String(row.bank_name_cipher ?? '')).trim(),
      accountLabel: String(row.account_label ?? '').trim(),
      chequeCount: Number(row.cheque_count ?? 0),
      amountCents: Number(row.amount_cents ?? 0),
      currency: String(row.currency ?? 'EUR'),
      officeId: row.office_id != null ? Number(row.office_id) : null,
      officeName: String(row.office_name ?? '').trim(),
      title: String(row.title ?? '').trim(),
      notes: String(row.notes ?? '').trim(),
      operationIds: itemMap.get(Number(row.id)) ?? []
    }))
  });
});

app.get('/api/billing/deposit-candidates', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const type = String(req.query.type ?? 'cheque').trim().toLowerCase() === 'especes' ? 'especes' : 'cheque';
  const officeId = Number(req.query.officeId);
  const currentDepositIdRaw = Number(req.query.currentDepositId);
  const currentDepositId = Number.isInteger(currentDepositIdRaw) && currentDepositIdRaw > 0
    ? currentDepositIdRaw
    : null;
  const scopedOfficeIds = getScopedBillingOfficeIds(req.userAccess, officeId);

  if (!scopedOfficeIds.length) {
    return res.json({ candidates: [] });
  }

  if (currentDepositId != null) {
    const currentDeposit = db.prepare(
      `SELECT id, office_id, type
       FROM accounting_deposits
       WHERE id = ? AND is_deleted = 0`
    ).get(currentDepositId);

    if (!currentDeposit) {
      return res.status(404).json({ message: 'Remise introuvable' });
    }

    if (!scopedOfficeIds.includes(Number(currentDeposit.office_id))) {
      return res.status(403).json({ message: 'Cabinet inaccessible' });
    }

    const currentType = String(currentDeposit.type ?? '').trim().toLowerCase() === 'especes' ? 'especes' : 'cheque';
    if (currentType !== type) {
      return res.status(400).json({ message: 'Type de remise incoherent' });
    }
  }

  const placeholders = scopedOfficeIds.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT i.id, i.patient_id, i.consultation_id, i.invoice_number, i.issued_at, i.amount_cents, i.status, i.payment_method, i.office_id,
            p.cipher_full_name,
            ip.id AS payment_id, ip.paid_at, ip.bank_name_cipher, ip.cheque_number, ip.notes AS payment_notes
     FROM invoices i
     INNER JOIN patients p ON p.id = i.patient_id
     LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
     WHERE i.office_id IN (${placeholders})
       AND i.status = 'payee'
       AND NOT EXISTS (
         SELECT 1
         FROM accounting_deposit_items di
         INNER JOIN accounting_deposits d ON d.id = di.deposit_id
         WHERE di.source_type = 'invoice'
           AND di.source_id = i.id
           AND d.is_deleted = 0
           AND (? IS NULL OR di.deposit_id <> ?)
       )
     ORDER BY datetime(i.issued_at) DESC, i.id DESC, ip.paid_at DESC, ip.id DESC`
  ).all(...scopedOfficeIds, currentDepositId, currentDepositId);

  const extractGroupRef = (notes) => {
    const match = String(notes ?? '').match(/\[encaissement groupe\s+([^\]]+)\]/);
    return match ? match[1] : null;
  };

  const candidates = rows
    .filter((row) => billingPaymentMethodMatchesDepositType(row.payment_method, type))
    .map((row) => {
      const groupRef = extractGroupRef(row.payment_notes);
      return {
        operationId: `invoice:${Number(row.id)}`,
        sourceId: Number(row.id),
        patientId: row.patient_id != null ? Number(row.patient_id) : null,
        consultationId: row.consultation_id != null ? Number(row.consultation_id) : null,
        occurredAt: String(row.issued_at),
        patientName: decryptSensitiveField(row.cipher_full_name),
        invoiceNumber: String(row.invoice_number ?? '').trim(),
        amountCents: Number(row.amount_cents ?? 0),
        currency: 'EUR',
        paymentMethod: String(row.payment_method ?? '').trim(),
        officeId: row.office_id != null ? Number(row.office_id) : null,
        groupRef: groupRef,
        bankName: safeDecryptField(String(row.bank_name_cipher ?? '')).trim(),
        chequeNumber: String(row.cheque_number ?? '').trim(),
        paidAt: row.paid_at != null ? String(row.paid_at) : null
      };
    });

  return res.json({ candidates });
});

app.patch('/api/billing/deposits/:id', authMiddleware, requirePermission('mark-payment'), (req, res) => {
  const depositId = Number(req.params.id);
  if (!Number.isInteger(depositId) || depositId <= 0) {
    return res.status(400).json({ message: 'ID de remise invalide' });
  }

  const existing = db.prepare('SELECT id, office_id FROM accounting_deposits WHERE id = ? AND is_deleted = 0').get(depositId);
  if (!existing) {
    return res.status(404).json({ message: 'Remise introuvable' });
  }

  const officeIds = getScopedBillingOfficeIds(req.userAccess, Number(existing.office_id));
  if (!officeIds.length) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }

  const occurredAt = String(req.body?.occurredAt ?? '').trim() || new Date().toISOString();
  const code = String(req.body?.code ?? '').trim();
  const bankName = String(req.body?.bankName ?? '').trim();
  const accountLabel = String(req.body?.accountLabel ?? '').trim();
  const title = String(req.body?.title ?? '').trim() || 'Remise';
  const notes = String(req.body?.notes ?? '').trim();
  const amount = Number(req.body?.amount ?? 0);
  const operationIds = Array.isArray(req.body?.operationIds) ? req.body.operationIds : null;
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Montant invalide' });
  }

  let parsedOperationIds = null;
  if (operationIds) {
    parsedOperationIds = operationIds
      .map((value) => parseBillingOperationId(value))
      .filter(Boolean);

    const duplicateCheck = new Set(parsedOperationIds.map((item) => `${item.sourceType}:${item.sourceId}`));
    if (duplicateCheck.size !== parsedOperationIds.length) {
      return res.status(400).json({ message: 'Operations en double dans la remise' });
    }

    const invoiceIds = parsedOperationIds
      .filter((item) => item.sourceType === 'invoice')
      .map((item) => item.sourceId);

    if (invoiceIds.length > 0) {
      const invoicePlaceholders = invoiceIds.map(() => '?').join(', ');
      const invoiceRows = db
        .prepare(`SELECT id, office_id FROM invoices WHERE id IN (${invoicePlaceholders})`)
        .all(...invoiceIds);

      if (invoiceRows.length !== invoiceIds.length) {
        return res.status(400).json({ message: 'Operations de remise invalides' });
      }

      const hasForeignOffice = invoiceRows.some((row) => Number(row.office_id) !== Number(existing.office_id));
      if (hasForeignOffice) {
        return res.status(403).json({ message: 'Cabinet inaccessible' });
      }

      const conflicts = db
        .prepare(
          `SELECT di.source_id
           FROM accounting_deposit_items di
           INNER JOIN accounting_deposits d ON d.id = di.deposit_id
           WHERE di.source_type = 'invoice'
             AND di.source_id IN (${invoicePlaceholders})
             AND di.deposit_id <> ?
             AND d.is_deleted = 0`
        )
        .all(...invoiceIds, depositId);

      if (conflicts.length > 0) {
        return res.status(400).json({ message: 'Certaines operations sont deja affectees a une autre remise' });
      }
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE accounting_deposits
       SET occurred_at = ?, deposit_code = ?, bank_name_cipher = ?, account_label = ?, title = ?, notes = ?, amount_cents = ?
       WHERE id = ?`
    ).run(
      occurredAt,
      code,
      bankName ? encryptSensitiveField(bankName) : '',
      accountLabel,
      title,
      notes,
      Math.round(amount * 100),
      depositId
    );

    if (parsedOperationIds) {
      db.prepare('DELETE FROM accounting_deposit_items WHERE deposit_id = ?').run(depositId);
      const insertItem = db.prepare(
        `INSERT OR IGNORE INTO accounting_deposit_items (deposit_id, source_type, source_id)
         VALUES (?, ?, ?)`
      );
      for (const item of parsedOperationIds) {
        insertItem.run(depositId, item.sourceType, item.sourceId);
      }
    }
  });

  tx();

  return res.status(204).send();
});

app.delete('/api/billing/deposits/:id', authMiddleware, requirePermission('mark-payment'), (req, res) => {
  const depositId = Number(req.params.id);
  if (!Number.isInteger(depositId) || depositId <= 0) {
    return res.status(400).json({ message: 'ID de remise invalide' });
  }

  const existing = db.prepare('SELECT id, office_id FROM accounting_deposits WHERE id = ? AND is_deleted = 0').get(depositId);
  if (!existing) {
    return res.status(404).json({ message: 'Remise introuvable' });
  }

  const officeIds = getScopedBillingOfficeIds(req.userAccess, Number(existing.office_id));
  if (!officeIds.length) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }

  db.prepare('UPDATE accounting_deposits SET is_deleted = 1 WHERE id = ?').run(depositId);
  return res.status(204).send();
});

app.get('/api/billing/deposits/:id/detail', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const depositId = Number(req.params.id);
  if (!Number.isInteger(depositId) || depositId <= 0) {
    return res.status(400).json({ message: 'ID de remise invalide' });
  }

  const row = db.prepare(
    `SELECT d.id, d.type, d.deposit_code, d.occurred_at, d.bank_name_cipher, d.account_label, d.title,
            d.amount_cents, d.currency, d.office_id, d.notes,
            o.name AS office_name, o.address_line1, o.address_line2, o.postal_code, o.city, o.country, o.phone_landline, o.email
     FROM accounting_deposits d
     LEFT JOIN offices o ON o.id = d.office_id
     WHERE d.id = ? AND d.is_deleted = 0`
  ).get(depositId);

  if (!row) {
    return res.status(404).json({ message: 'Remise introuvable' });
  }

  const officeIds = getScopedBillingOfficeIds(req.userAccess, Number(row.office_id));
  if (!officeIds.length) {
    return res.status(403).json({ message: 'Cabinet inaccessible' });
  }

  const items = db.prepare(
    `SELECT i.id AS invoice_id, i.invoice_number, i.issued_at, i.amount_cents, p.cipher_full_name,
            ip.bank_name_cipher, ip.cheque_number, ip.notes AS payment_notes, ip.paid_at
     FROM accounting_deposit_items di
     INNER JOIN invoices i ON i.id = di.source_id AND di.source_type = 'invoice'
     INNER JOIN patients p ON p.id = i.patient_id
     LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
     WHERE di.deposit_id = ?
     ORDER BY datetime(i.issued_at) DESC, i.id DESC, ip.paid_at DESC, ip.id DESC`
  ).all(depositId);

  const extractGroupRef = (notes) => {
    const match = String(notes ?? '').match(/\[encaissement groupe\s+([^\]]+)\]/);
    return match ? match[1] : null;
  };

  return res.json({
    detail: {
      deposit: {
        id: Number(row.id),
        type: row.type === 'especes' ? 'especes' : 'cheque',
        code: String(row.deposit_code ?? '').trim(),
        occurredAt: String(row.occurred_at),
        bankName: safeDecryptField(String(row.bank_name_cipher ?? '')).trim(),
        accountLabel: String(row.account_label ?? '').trim(),
        chequeCount: items.length,
        amountCents: Number(row.amount_cents ?? 0),
        currency: String(row.currency ?? 'EUR'),
        officeId: row.office_id != null ? Number(row.office_id) : null,
        officeName: String(row.office_name ?? '').trim(),
        title: String(row.title ?? '').trim(),
        notes: String(row.notes ?? '').trim(),
        operationIds: items.map((item) => `invoice:${Number(item.invoice_id)}`)
      },
      office: {
        id: row.office_id != null ? Number(row.office_id) : null,
        name: String(row.office_name ?? '').trim(),
        address1: String(row.address_line1 ?? '').trim(),
        address2: String(row.address_line2 ?? '').trim(),
        postalCode: String(row.postal_code ?? '').trim(),
        city: String(row.city ?? '').trim(),
        phone: String(row.phone_landline ?? '').trim(),
        email: String(row.email ?? '').trim()
      },
      items: items.map((item) => ({
        operationId: `invoice:${Number(item.invoice_id)}`,
        occurredAt: String(item.issued_at),
        patientName: decryptSensitiveField(item.cipher_full_name),
        invoiceNumber: String(item.invoice_number ?? '').trim(),
        amountCents: Number(item.amount_cents ?? 0),
        currency: 'EUR',
        groupRef: extractGroupRef(item.payment_notes),
        bankName: safeDecryptField(String(item.bank_name_cipher ?? '')).trim(),
        chequeNumber: String(item.cheque_number ?? '').trim(),
        paidAt: item.paid_at != null ? String(item.paid_at) : null
      }))
    }
  });
});

app.patch('/api/billing/operations/bulk', authMiddleware, requirePermission('mark-payment'), (req, res) => {
  const operationIds = Array.isArray(req.body?.operationIds) ? req.body.operationIds : [];
  const parsed = operationIds
    .map((value) => parseBillingOperationId(value))
    .filter(Boolean);

  if (parsed.length === 0) {
    return res.status(400).json({ message: 'Aucune operation selectionnee' });
  }

  const ownerUserId = req.body?.ownerUserId == null ? undefined : Number(req.body.ownerUserId);
  const retrocessionPercent = req.body?.retrocessionPercent == null ? undefined : Number(req.body.retrocessionPercent);
  const retrocessionRecipient = req.body?.retrocessionRecipient == null ? undefined : String(req.body.retrocessionRecipient ?? '').trim();
  const shouldDelete = req.body?.delete === true;

  const upsertMeta = db.prepare(
    `INSERT INTO accounting_operation_meta (source_type, source_id, owner_user_id, retrocession_percent, retrocession_recipient, is_deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source_type, source_id)
     DO UPDATE SET
       owner_user_id = COALESCE(excluded.owner_user_id, accounting_operation_meta.owner_user_id),
       retrocession_percent = excluded.retrocession_percent,
       retrocession_recipient = excluded.retrocession_recipient,
       is_deleted = excluded.is_deleted,
       updated_at = CURRENT_TIMESTAMP`
  );

  const tx = db.transaction(() => {
    const isAdmin = req.userAccess?.role === 'admin' || req.userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    const accessibleOfficeIds = isAdmin ? null : getAccessibleBillingOfficeIds(req.userAccess);

    for (const item of parsed) {
      let row = null;
      if (item.sourceType === 'invoice') {
        row = db.prepare('SELECT office_id FROM invoices WHERE id = ?').get(item.sourceId);
      } else if (item.sourceType === 'expense') {
        row = db.prepare('SELECT office_id FROM accounting_expenses WHERE id = ?').get(item.sourceId);
      } else {
        row = db.prepare('SELECT office_id FROM accounting_deposits WHERE id = ?').get(item.sourceId);
      }

      if (!row) {
        throw new Error('Operation introuvable');
      }

      const officeId = row.office_id != null ? Number(row.office_id) : null;
      if (!isAdmin && (officeId == null || !accessibleOfficeIds.includes(officeId))) {
        throw new Error('Cabinet inaccessible');
      }

      if (item.sourceType === 'invoice') {
        upsertMeta.run(
          item.sourceType,
          item.sourceId,
          Number.isInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null,
          Number.isFinite(retrocessionPercent) ? retrocessionPercent : 0,
          retrocessionRecipient ?? '',
          shouldDelete ? 1 : 0
        );
        continue;
      }

      const tableName = item.sourceType === 'expense' ? 'accounting_expenses' : 'accounting_deposits';
      const updates = [];
      const params = [];

      if (Number.isInteger(ownerUserId) && ownerUserId > 0) {
        updates.push('owner_user_id = ?');
        params.push(ownerUserId);
      }
      if (Number.isFinite(retrocessionPercent)) {
        updates.push('retrocession_percent = ?');
        params.push(retrocessionPercent);
      }
      if (typeof retrocessionRecipient === 'string') {
        updates.push('retrocession_recipient = ?');
        params.push(retrocessionRecipient);
      }
      if (shouldDelete) {
        updates.push('is_deleted = 1');
      }

      if (updates.length === 0) {
        continue;
      }

      params.push(item.sourceId);
      db.prepare(`UPDATE ${tableName} SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  });

  try {
    tx();
  } catch (error) {
    const message = String(error?.message ?? '');
    if (message === 'Operation introuvable') {
      return res.status(404).json({ message: 'Operation introuvable' });
    }
    if (message === 'Cabinet inaccessible') {
      return res.status(403).json({ message: 'Cabinet inaccessible' });
    }
    throw error;
  }

  writeAuditLog(req.user.sub, 'UPDATE', 'billing-operations', null, {
    count: parsed.length,
    delete: shouldDelete
  });

  return res.status(204).send();
});

app.get('/api/billing/export', authMiddleware, requirePermission('export-billing'), (req, res) => {
  const format = String(req.query.format ?? 'json').trim().toLowerCase();
  if (!['json', 'excel'].includes(format)) {
    return res.status(400).json({ message: 'Format invalide' });
  }

  const mode = String(req.query.mode ?? 'standard').trim().toLowerCase();
  if (!['standard', 'analytical'].includes(mode)) {
    return res.status(400).json({ message: 'Mode d\'export invalide' });
  }

  const range = buildBillingDateRange(req.query.from, req.query.to);
  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);
  const ownerUserId = Number(req.query.userId);

  const payload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: range.fromIso,
    toIso: range.toIso,
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: Number.isInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null
  });

  const datePart = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    const fileName = `comptabilite-${mode}-${datePart}.json`;
    const officeNameById = new Map((payload.offices ?? []).map((office) => [Number(office.id), String(office.name ?? '').trim()]));
    const ownerNameById = new Map((payload.users ?? []).map((user) => [Number(user.id), String(user.displayName ?? '').trim()]));
    const operations = mode === 'analytical'
      ? payload.operations.map((row) => ({
        ...row,
        officeName: row.officeId != null ? String(officeNameById.get(Number(row.officeId)) ?? '') : '',
        ownerDisplayName: row.ownerUserId != null ? String(ownerNameById.get(Number(row.ownerUserId)) ?? '') : ''
      }))
      : payload.operations;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(JSON.stringify({
      meta: {
        exportedAt: new Date().toISOString(),
        from: range.fromIso,
        to: range.toIso,
        count: payload.operations.length,
        mode
      },
      summary: payload.summary,
      operations
    }, null, 2));
  }

  const fileName = `comptabilite-${mode}-${datePart}.csv`;
  const officeNameById = new Map((payload.offices ?? []).map((office) => [Number(office.id), String(office.name ?? '').trim()]));
  const ownerNameById = new Map((payload.users ?? []).map((user) => [Number(user.id), String(user.displayName ?? '').trim()]));

  const header = mode === 'analytical'
    ? ['Date', 'Titre', 'Debit', 'Credit', 'Devise', 'Retrocession', 'Facture', 'Type', 'SourceId', 'Cabinet', 'CabinetId', 'Praticien', 'PraticienId']
    : ['Date', 'Titre', 'Debit', 'Credit', 'Devise', 'Retrocession', 'Facture', 'Type'];

  const rows = payload.operations.map((row) => [
    row.occurredAt,
    row.title,
    (row.debitCents / 100).toFixed(2),
    (row.creditCents / 100).toFixed(2),
    row.currency,
    `${Number(row.retrocessionPercent ?? 0).toFixed(2)}% ${String(row.retrocessionRecipient ?? '').trim()}`.trim(),
    row.invoiceNumber,
    row.sourceType,
    ...(mode === 'analytical'
      ? [
        String(row.sourceId),
        row.officeId != null ? String(officeNameById.get(Number(row.officeId)) ?? '') : '',
        row.officeId != null ? String(row.officeId) : '',
        row.ownerUserId != null ? String(ownerNameById.get(Number(row.ownerUserId)) ?? '') : '',
        row.ownerUserId != null ? String(row.ownerUserId) : ''
      ]
      : [])
  ]);
  const csv = [header, ...rows]
    .map((line) => line.map((value) => serializeCsvCell(value, ';')).join(';'))
    .join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(`\ufeff${csv}`);
});

app.get('/api/billing/monthly-revenue', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);

  const payload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: from,
    toIso: to,
    availableOfficeIds,
    filterOfficeIds,
    // Badge should represent monthly office receipts visible to the user,
    // not only operations owned by the connected practitioner.
    ownerUserId: null
  });

  const receiptsCents = payload.operations.reduce((sum, item) => sum + item.creditCents, 0);
  return res.json({
    amountCents: receiptsCents,
    currency: 'EUR'
  });
});

app.get('/api/invoices/summary', authMiddleware, requirePermission('read-billing-kpis'), (req, res) => {
  const now = new Date();
  const range = {
    fromIso: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString(),
    toIso: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString()
  };

  const availableOfficeIds = getAccessibleBillingOfficeIds(req.userAccess);
  const filterOfficeIds = getScopedBillingOfficeIds(req.userAccess, req.query.officeId);
  const payload = getBillingOperationsData({
    userId: req.user.sub,
    access: req.userAccess,
    fromIso: range.fromIso,
    toIso: range.toIso,
    availableOfficeIds,
    filterOfficeIds,
    ownerUserId: null
  });

  writeAuditLog(req.user.sub, 'READ_LIST', 'invoices', null, { count: payload.operations.length });
  return res.json({ summary: payload.summary });
});

await ensureSeedData();

app.use((err, req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      message: `Payload trop volumineux. Reduisez la taille des pieces jointes (limite API: ${resolveBodyLimit(req.path)}).`
    });
  }

  if (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    return res.status(500).json({ message: 'Erreur interne du serveur.' });
  }

  return res.status(500).json({ message: 'Erreur interne du serveur.' });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Secure SQLite API ready on http://localhost:${port}`);
});

processExpiredPatients();
const retentionCheckIntervalMs = 24 * 60 * 60 * 1000;
const retentionCheckInterval = setInterval(processExpiredPatients, retentionCheckIntervalMs);
