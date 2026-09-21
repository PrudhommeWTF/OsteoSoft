// Sauvegarde et restauration des données (export/import complet).
//
// Deux couches :
//  1. Constantes de format et limites de volume, plus des fonctions PURES :
//     empreinte stable des données (checksum), lecture de version majeure, et
//     filtrage d'une sauvegarde par cabinets (cloisonnement à l'export).
//  2. Une fabrique createBackupService(db, deps) qui ferme sur la base et renvoie
//     les opérations liées à la base : validation d'enveloppe, construction du
//     snapshot complet, et restauration destructive (remplacement intégral).
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Les routes HTTP
// restent dans index.mjs et appellent ces primitives. restoreCipherField et
// normalizeColorHex sont injectés (ils servent aussi hors sauvegarde).
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

import crypto from 'node:crypto';

/** @typedef {any} Db */

// En-tête d'une archive de sauvegarde chiffrée (magie + version de format).
const ENCRYPTED_BACKUP_MAGIC = Buffer.from('OSTEOBK1', 'utf8'); // 8 octets
const ENCRYPTED_BACKUP_SALT_BYTES = 16;
const ENCRYPTED_BACKUP_IV_BYTES = 12;
const ENCRYPTED_BACKUP_TAG_BYTES = 16;

/**
 * Chiffre une archive de sauvegarde avec une phrase de passe. La clé est dérivée
 * par scrypt (sel aléatoire), le chiffrement est AES-256-GCM. Format de sortie :
 * magie(8) + sel(16) + iv(12) + tag(16) + texte chiffré. Fonction pure.
 * @param {Buffer} archiveBuffer Contenu en clair (par ex. un ZIP).
 * @param {string} passphrase
 * @returns {Buffer}
 */
export function encryptBackupArchive(archiveBuffer, passphrase) {
  const pass = String(passphrase ?? '');
  if (pass.length < 12) {
    throw new Error('Phrase de passe trop courte (au moins 12 caractères)');
  }
  const salt = crypto.randomBytes(ENCRYPTED_BACKUP_SALT_BYTES);
  const iv = crypto.randomBytes(ENCRYPTED_BACKUP_IV_BYTES);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(archiveBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTED_BACKUP_MAGIC, salt, iv, tag, ciphertext]);
}

/**
 * Déchiffre une archive de sauvegarde chiffrée par encryptBackupArchive. Lève une
 * erreur si le format est invalide ou la phrase de passe incorrecte (échec
 * d'authentification GCM). Fonction pure.
 * @param {Buffer} encryptedBuffer
 * @param {string} passphrase
 * @returns {Buffer}
 */
export function decryptBackupArchive(encryptedBuffer, passphrase) {
  const buffer = Buffer.isBuffer(encryptedBuffer) ? encryptedBuffer : Buffer.from(encryptedBuffer ?? '');
  const headerBytes = ENCRYPTED_BACKUP_MAGIC.length + ENCRYPTED_BACKUP_SALT_BYTES + ENCRYPTED_BACKUP_IV_BYTES + ENCRYPTED_BACKUP_TAG_BYTES;
  if (buffer.length <= headerBytes || !buffer.subarray(0, ENCRYPTED_BACKUP_MAGIC.length).equals(ENCRYPTED_BACKUP_MAGIC)) {
    throw new Error('Archive chiffrée invalide (format non reconnu)');
  }
  let offset = ENCRYPTED_BACKUP_MAGIC.length;
  const salt = buffer.subarray(offset, offset += ENCRYPTED_BACKUP_SALT_BYTES);
  const iv = buffer.subarray(offset, offset += ENCRYPTED_BACKUP_IV_BYTES);
  const tag = buffer.subarray(offset, offset += ENCRYPTED_BACKUP_TAG_BYTES);
  const ciphertext = buffer.subarray(offset);

  const key = crypto.scryptSync(String(passphrase ?? ''), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Phrase de passe incorrecte ou archive corrompue');
  }
}

/**
 * Indique si un buffer est une archive de sauvegarde chiffrée (magie reconnue).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isEncryptedBackupArchive(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= ENCRYPTED_BACKUP_MAGIC.length
    && buffer.subarray(0, ENCRYPTED_BACKUP_MAGIC.length).equals(ENCRYPTED_BACKUP_MAGIC);
}

export const BACKUP_MANIFEST_FORMAT = 'osteosoft-backup';
export const BACKUP_MANIFEST_VERSION = 1;
export const MAX_BACKUP_RESTORE_PAYLOAD_BYTES = Number(process.env.MAX_BACKUP_RESTORE_PAYLOAD_BYTES ?? 35 * 1024 * 1024);
export const MAX_BACKUP_DOCUMENT_PAYLOAD_BYTES = Number(process.env.MAX_BACKUP_DOCUMENT_PAYLOAD_BYTES ?? 20 * 1024 * 1024);
export const BACKUP_COLLECTION_LIMITS = {
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

/**
 * Extrait le numéro de version majeure d'une chaîne de version.
 * @param {any} version
 * @returns {number|null}
 */
export function parseMajorVersion(version) {
  const normalized = String(version ?? '').trim();
  const match = normalized.match(/^(\d+)/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Empreinte SHA-256 stable des données : les objets sont triés par clé avant
 * sérialisation, de sorte que l'ordre des propriétés n'affecte pas le checksum.
 * @param {any} data
 * @returns {string}
 */
export function computeBackupDataSha256(data) {
  /**
   * @param {any} value
   * @returns {any}
   */
  const normalizeForStableHash = (value) => {
    if (Array.isArray(value)) {
      return value.map((/** @type {any} */ item) => normalizeForStableHash(item));
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

/**
 * Empreinte SHA-256 historique (sans normalisation d'ordre), conservée pour
 * valider les sauvegardes produites avant l'introduction du checksum stable.
 * @param {any} data
 * @returns {string}
 */
export function computeBackupDataSha256Legacy(data) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}

/**
 * Restreint une sauvegarde aux cabinets donnés (cloisonnement à l'export) :
 * ne conserve que les entités rattachées, directement ou transitivement, à l'un
 * des cabinets sélectionnés. Fonction pure.
 * @param {any} data
 * @param {any} officeIds
 */
export function filterBackupDataByOfficeIds(data, officeIds) {
  const normalizedOfficeIds = [...new Set((Array.isArray(officeIds) ? officeIds : [])
    .map((/** @type {any} */ officeId) => Number(officeId))
    .filter((/** @type {number} */ officeId) => Number.isInteger(officeId) && officeId > 0))];

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
  const patients = data.patients.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id)));
  const patientIdSet = new Set(patients.map((/** @type {any} */ row) => Number(row.id)).filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0));

  const consultations = data.consultations.filter(
    (/** @type {any} */ row) => officeIdSet.has(Number(row.office_id)) || patientIdSet.has(Number(row.patient_id))
  );
  const consultationIdSet = new Set(consultations.map((/** @type {any} */ row) => Number(row.id)).filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0));

  const appointments = data.appointments.filter(
    (/** @type {any} */ row) =>
      patientIdSet.has(Number(row.patient_id))
      || officeIdSet.has(Number(row.office_id))
      || consultationIdSet.has(Number(row.consultation_id))
  );

  const invoices = data.invoices.filter(
    (/** @type {any} */ row) => officeIdSet.has(Number(row.office_id)) || patientIdSet.has(Number(row.patient_id))
  );
  const invoiceIdSet = new Set(invoices.map((/** @type {any} */ row) => Number(row.id)).filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0));

  const accountingDeposits = data.accountingDeposits.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id)));
  const depositIdSet = new Set(accountingDeposits.map((/** @type {any} */ row) => Number(row.id)).filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0));

  const accountingExpenses = data.accountingExpenses.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id)));
  const expenseIdSet = new Set(accountingExpenses.map((/** @type {any} */ row) => Number(row.id)).filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0));

  const userOffices = data.userOffices.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id)));
  const officeUserDelegations = data.officeUserDelegations.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id)));
  const userIdSet = new Set(
    [
      ...userOffices.map((/** @type {any} */ row) => Number(row.user_id)),
      ...officeUserDelegations.map((/** @type {any} */ row) => Number(row.user_id))
    ].filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0)
  );

  const users = data.users.filter((/** @type {any} */ row) => {
    const userId = Number(row.id);
    const legacyOfficeId = Number(row.office_id);
    return userIdSet.has(userId) || officeIdSet.has(legacyOfficeId);
  });

  const profileIdSet = new Set(users.map((/** @type {any} */ row) => String(row.profile_id ?? '').trim()).filter((/** @type {any} */ id) => id.length > 0));

  return {
    ...data,
    accessProfiles: data.accessProfiles.filter((/** @type {any} */ row) => profileIdSet.has(String(row.id ?? '').trim())),
    users,
    userOffices,
    officeUserDelegations,
    patients,
    appointments,
    invoices,
    invoiceLineItems: data.invoiceLineItems.filter((/** @type {any} */ row) => invoiceIdSet.has(Number(row.invoice_id))),
    invoicePayments: data.invoicePayments.filter((/** @type {any} */ row) => invoiceIdSet.has(Number(row.invoice_id))),
    accountingExpenses,
    accountingDeposits,
    accountingDepositItems: data.accountingDepositItems.filter((/** @type {any} */ row) => depositIdSet.has(Number(row.deposit_id))),
    accountingOperationMeta: data.accountingOperationMeta.filter((/** @type {any} */ row) => {
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
    consultationReasonItems: data.consultationReasonItems.filter((/** @type {any} */ row) => consultationIdSet.has(Number(row.consultation_id))),
    consultationSections: data.consultationSections.filter((/** @type {any} */ row) => consultationIdSet.has(Number(row.consultation_id))),
    patientDocuments: data.patientDocuments.filter(
      (/** @type {any} */ row) => patientIdSet.has(Number(row.patient_id)) || officeIdSet.has(Number(row.office_id))
    ),
    patientAntecedents: data.patientAntecedents.filter((/** @type {any} */ row) => patientIdSet.has(Number(row.patient_id))),
    serviceTypes: data.serviceTypes.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id))),
    paymentMethods: data.paymentMethods.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id))),
    localCalendars: data.localCalendars.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id))),
    directoryContacts: data.directoryContacts.filter((/** @type {any} */ row) => officeIdSet.has(Number(row.office_id))),
    config: [],
    patientDrafts: [],
    auditLogs: data.auditLogs.filter((/** @type {any} */ row) => userIdSet.has(Number(row.user_id)))
  };
}

/**
 * Crée les opérations de sauvegarde/restauration liées à une base.
 * @param {Db} db
 * @param {{ restoreCipherField: (value: any) => any, normalizeColorHex: (value: any, fallback?: string) => string }} deps
 */
export function createBackupService(db, { restoreCipherField, normalizeColorHex }) {
  /**
   * Valide et normalise une enveloppe de sauvegarde (taille, limites de volume,
   * manifest et checksum, compatibilité de version majeure).
   * @param {any} backupPayload
   */
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
        (/** @type {number} */ total, /** @type {any} */ row) => total + Buffer.byteLength(String(row?.content_cipher ?? ''), 'utf8'),
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

  /**
   * Construit le snapshot complet (manifest + meta + données), éventuellement
   * restreint à un ensemble de cabinets.
   * @param {{ officeIds?: number[] }} [options]
   */
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
                practitioner, user_id, is_private, private_label_cipher, created_at
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
        `SELECT id, patient_id, started_at, office_id, practitioner, user_id, title, important,
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
                content_cipher, document_type, created_at
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
        `SELECT id, user_id, action, entity, entity_id, metadata, created_at, integrity_hash
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

  /**
   * Restauration destructive : remplace intégralement le contenu de la base par
   * celui de la sauvegarde (dans une transaction, foreign_keys désactivées).
   * @param {any} backupPayload
   * @param {Map<number, { hash: string, tempPassword?: string }>} [prehashedUserPasswords]
   */
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
          practitioner, user_id, is_private, private_label_cipher, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
           id, patient_id, started_at, office_id, practitioner, user_id, title, important,
           height_cm, weight_kg, eva_before, eva_after, profile, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
           content_cipher, document_type, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        `INSERT INTO audit_logs (id, user_id, action, entity, entity_id, metadata, created_at, integrity_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

        if ((officeId == null || !Number.isInteger(officeId) || officeId <= 0) && typeof row.cabinet_name === 'string' && row.cabinet_name.trim()) {
          const office = db.prepare('SELECT id FROM offices WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1').get(row.cabinet_name);
          officeId = office ? Number(office.id) : null;
        }

        if (officeId == null || !Number.isInteger(officeId) || officeId <= 0) {
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
          restoreCipherField(row.bank_name_cipher ?? ''),
          restoreCipherField(row.iban_cipher ?? ''),
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
          restoreCipherField(String(row.category ?? '').trim()),
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
          row.user_id != null ? Number(row.user_id) : null,
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
          restoreCipherField(row.bank_name_cipher ?? ''),
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
          restoreCipherField(row.bank_name_cipher ?? ''),
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
          row.user_id != null ? Number(row.user_id) : null,
          restoreCipherField(String(row.title ?? '')),
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
          row.document_type ?? 'document',
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
          row.created_at ?? new Date().toISOString(),
          row.integrity_hash ?? null
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

  return { normalizeBackupEnvelope, buildDataBackupSnapshot, restoreDataBackupSnapshot };
}
