// Patients et consultations : opérations liées à la base et au chiffrement.
//
// Complète le volet pur (server/lib/patients.mjs) par les écritures et lectures
// chiffrées : insertion d'une consultation depuis une note, remplacement des
// antécédents, motifs et sections, cartes déchiffrées, notes patient, rétention
// effective, purge des dossiers expirés, et rapprochement/patients rapides.
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Instanciée
// APRÈS l'agenda (dont elle utilise le calendrier par défaut et la détection de
// chevauchement) et AVANT l'import WebOsteo et les statistiques (qui reçoivent
// plusieurs de ces primitives en injection). Les fonctions pures viennent des
// modules patients/agenda/statistiques ; le reste est injecté.
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

import {
  parsePatientAntecedentsFromMedicalHistory,
  normalizeConsultationReasonItems,
  buildEmptyConsultationSections,
  normalizeConsultationSectionsPayload,
  hasConsultationSectionsContent,
  computePatientRetentionDateIso,
  buildDefaultPatientNotes,
  CONSULTATION_SECTION_KEYS
} from './patients.mjs';
import { alignDateToOfficeSlot, getFirstOpeningMinute } from './agenda.mjs';
import { parseStatisticsAntecedents } from './statistics.mjs';

/** @typedef {any} Db */

/**
 * Crée les opérations patients/consultations liées à la base.
 * @param {Db} db
 * @param {{
 *   encryptSensitiveField: (v: any) => any,
 *   decryptSensitiveField: (v: any) => any,
 *   safeDecryptField: (v: any) => any,
 *   writeAuditLog: (userId: any, action: any, entity: any, entityId?: any, metadata?: any) => any,
 *   anonymizePatientTx: (patientId: any) => any,
 *   getDefaultCalendarForUser: (userId: any, officeIdFilter?: any) => any,
 *   findOverlappingAppointmentForPatient: (patientId: any, localCalendarId: any, startsAtIso: any, durationMinutes: any) => any,
 *   normalizeOfficeDefaultSessionDurationMinutes: (v: any) => any,
 *   parseOfficeOpeningHours: (rawJson: any) => any,
 *   resolveUserIdFromPractitionerText: (text: any) => any,
 *   normalizeAuditValue: (value: any) => any,
 *   normalizePersonNameKey: (name: any) => any
 * }} deps
 */
export function createPatientRecords(db, {
  encryptSensitiveField,
  decryptSensitiveField,
  safeDecryptField,
  writeAuditLog,
  anonymizePatientTx,
  getDefaultCalendarForUser,
  findOverlappingAppointmentForPatient,
  normalizeOfficeDefaultSessionDurationMinutes,
  parseOfficeOpeningHours,
  resolveUserIdFromPractitionerText,
  normalizeAuditValue,
  normalizePersonNameKey
}) {
  function isPatientProcessingRestricted(/** @type {any} */ patientId) {
    const id = Number(patientId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const row = db.prepare('SELECT processing_restricted FROM patients WHERE id = ? AND is_deleted = 0').get(id);
    return !!(row && Number(row.processing_restricted) === 1);
  }

  function processExpiredPatients() {
    const today = new Date().toISOString().slice(0, 10);

    // Anonymise patients whose retention period has expired, including those
    // whose processing was restricted following consent withdrawal (RGPD Art. 18).
    const expired = db.prepare(
      `SELECT id, retention_until, processing_restricted FROM patients
       WHERE is_deleted = 0
         AND retention_until IS NOT NULL
         AND retention_until < ?`
    ).all(today);

    for (const { id, retention_until: retentionUntil, processing_restricted: processingRestricted } of expired) {
      anonymizePatientTx(id);
      writeAuditLog(null, 'AUTO_ANONYMIZE', 'patients', String(id), {
        reason: processingRestricted ? 'processing_restricted_retention_expired' : 'retention_expired',
        retentionUntil
      });
    }

    return expired.length;
  }

  function resolveConsultationSchedulingContextFromRaw(/** @type {any} */ consultationNoteRaw, /** @type {any} */ options = {}) {
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

  function updatePatientRetentionFields(/** @type {any} */ patientId, /** @type {any} */ consultationDateIso) {
    // Compute candidate retention date: consultation + 10 years
    // Also compute birth_date + 28 years (French law: minor records kept until age 28)
    // and use whichever is later.
    db.prepare(
      `UPDATE patients SET
         last_visit = CASE WHEN last_visit IS NULL OR date(?) > last_visit THEN date(?) ELSE last_visit END,
         retention_until = CASE
           WHEN birth_date IS NOT NULL AND date(birth_date, '+28 years') > date(?, '+10 years')
             THEN CASE WHEN retention_until IS NULL OR date(birth_date, '+28 years') > retention_until THEN date(birth_date, '+28 years') ELSE retention_until END
           ELSE
             CASE WHEN retention_until IS NULL OR date(?, '+10 years') > retention_until THEN date(?, '+10 years') ELSE retention_until END
         END
       WHERE id = ?`
    ).run(consultationDateIso, consultationDateIso, consultationDateIso, consultationDateIso, consultationDateIso, patientId);
  }

  function insertConsultationFromNote(/** @type {any} */ patientId, /** @type {any} */ consultationNoteRaw, /** @type {any} */ options = {}) {
    const raw = String(consultationNoteRaw ?? '').trim();
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch { return null; }

    const normalizedReasonItems = Array.isArray(data.reasonItems)
      ? data.reasonItems
        .map((/** @type {any} */ item) => ({
          label: String(item?.label ?? '').trim(),
          value: String(item?.value ?? '').trim(),
          important: Boolean(item?.important)
        }))
        .filter((/** @type {any} */ item, /** @type {any} */ index, /** @type {any} */ all) => item.label && all.findIndex((/** @type {any} */ candidate) => candidate.label === item.label) === index)
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
          (patient_id, started_at, office_id, practitioner, user_id, title, important, height_cm, weight_kg,
           eva_before, eva_after, profile)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        patientId,
        alignedStartIso,
        consultationOfficeId,
        String(data.practitioner ?? '').trim(),
        resolveUserIdFromPractitionerText(String(data.practitioner ?? '')),
        encryptSensitiveField(String(data.title ?? '').trim()),
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

  function storeAntecedentTypes(/** @type {any} */ labels) {
    if (!labels.length) {
      return;
    }

    const upsertAntecedentType = db.prepare(
      'INSERT OR IGNORE INTO antecedent_types (label) VALUES (?)'
    );

    const insertMany = db.transaction((/** @type {any} */ items) => {
      for (const label of items) {
        upsertAntecedentType.run(label);
      }
    });

    const unique = [...new Set(labels.map((/** @type {any} */ label) => label.trim()).filter(Boolean))];
    insertMany(unique);
  }

  function replacePatientAntecedents(/** @type {any} */ patientId, /** @type {any} */ medicalHistoryRaw) {
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return;
    }

    const antecedents = parsePatientAntecedentsFromMedicalHistory(medicalHistoryRaw);
    const replaceMany = db.transaction((/** @type {any} */ id, /** @type {any} */ items) => {
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
          encryptSensitiveField(item.category),
          encryptSensitiveField(item.description),
          item.important ? 1 : 0,
          item.sortKey
        );
      }
    });

    replaceMany(patientId, antecedents);
  }

  function replaceConsultationReasonItems(/** @type {any} */ consultationId, /** @type {any} */ reasonItems) {
    if (!Number.isInteger(consultationId) || consultationId <= 0) {
      return;
    }

    const normalized = normalizeConsultationReasonItems(reasonItems);
    const replaceMany = db.transaction((/** @type {any} */ id, /** @type {any} */ items) => {
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

  function replaceConsultationSections(/** @type {any} */ consultationId, /** @type {any} */ sections) {
    if (!Number.isInteger(consultationId) || consultationId <= 0) {
      return;
    }

    const normalized = normalizeConsultationSectionsPayload(sections);
    const replaceMany = db.transaction((/** @type {any} */ id, /** @type {any} */ nextSections) => {
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

  function getConsultationReasonItems(/** @type {any} */ consultationId) {
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
        .map((/** @type {any} */ row) => ({
          label: String(row.label ?? '').trim(),
          value: safeDecryptField(row.value).trim(),
          important: Boolean(row.important)
        }))
        .filter((/** @type {any} */ item) => item.label.length > 0);
    }

    return [];
  }

  function getConsultationSections(/** @type {any} */ consultationId) {
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
      const sections = /** @type {Record<string, any>} */ (buildEmptyConsultationSections());
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

  function getPatientAntecedentItems(/** @type {any} */ patientId, medicalHistoryRaw = null) {
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
        .map((/** @type {any} */ row) => ({
          category: safeDecryptField(row.category ?? '').trim(),
          label: safeDecryptField(row.description).trim(),
          important: Boolean(row.important)
        }))
        .filter((/** @type {any} */ item) => item.category.length > 0 || item.label.length > 0);
    }

    const fallback = parseStatisticsAntecedents(medicalHistoryRaw);
    if (fallback.length > 0) {
      replacePatientAntecedents(patientId, medicalHistoryRaw);
    }

    return fallback;
  }

  function buildConsultationReasonItemsMap(/** @type {any} */ rows) {
    const consultationIds = [...new Set(
      rows
        .map((/** @type {any} */ row) => Number(row?.id))
        .filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0)
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
      map.set(consultationId, items.filter((/** @type {any} */ item) => item.label.length > 0));
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

  function buildConsultationSectionsMap(/** @type {any} */ rows) {
    const consultationIds = [...new Set(
      rows
        .map((/** @type {any} */ row) => Number(row?.id))
        .filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0)
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

  function buildPatientAntecedentsMap(/** @type {any} */ rows) {
    const patientIds = [...new Set(
      rows
        .map((/** @type {any} */ row) => Number(row?.id))
        .filter((/** @type {any} */ id) => Number.isInteger(id) && id > 0)
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
        category: safeDecryptField(row.category ?? '').trim(),
        label: safeDecryptField(row.description).trim(),
        important: Boolean(row.important)
      });
      map.set(patientId, items.filter((/** @type {any} */ item) => item.category.length > 0 || item.label.length > 0));
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

  function buildPatientUpdateChanges(/** @type {any} */ beforeSnapshot, /** @type {any} */ afterSnapshot) {
    const labels = /** @type {Record<string, string>} */ ({
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
    });

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

  function parsePatientNotesFromCipher(/** @type {any} */ cipherMedicalNotes) {
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

  function findOrCreateQuickPatientForAppointment(/** @type {any} */ lastName, /** @type {any} */ firstName, /** @type {any} */ officeId) {
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

    const notes = /** @type {Record<string, any>} */ (buildDefaultPatientNotes());
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
        0,
        computePatientRetentionDateIso(),
        normalizedOfficeId
      );

    return Number(inserted.lastInsertRowid);
  }

  function findOrCreatePrivatePlaceholderPatient(/** @type {any} */ officeId) {
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

  return {
    isPatientProcessingRestricted,
    processExpiredPatients,
    resolveConsultationSchedulingContextFromRaw,
    updatePatientRetentionFields,
    insertConsultationFromNote,
    storeAntecedentTypes,
    replacePatientAntecedents,
    replaceConsultationReasonItems,
    replaceConsultationSections,
    getConsultationReasonItems,
    getConsultationSections,
    getPatientAntecedentItems,
    buildConsultationReasonItemsMap,
    buildConsultationSectionsMap,
    buildPatientAntecedentsMap,
    buildPatientUpdateChanges,
    parsePatientNotesFromCipher,
    findOrCreateQuickPatientForAppointment,
    findOrCreatePrivatePlaceholderPatient
  };
}
