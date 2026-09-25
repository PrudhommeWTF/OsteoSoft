// Import WebOsteo : conversion d'une base WebOsteo (.bck ou .data/.sqlite) vers
// le schéma OsteoSoft, pour un cabinet cible. Remplacement atomique des données
// du cabinet dans une transaction unique.
//
// Extraction pure depuis server/index.mjs, comportement inchangé. La route HTTP
// (validation, décodage, extraction de l'archive, fichier temporaire, réponse et
// nettoyage) reste dans index.mjs et appelle importWebOsteoDatabase avec la base
// WebOsteo déjà ouverte. Les fonctions partagées (chiffrement, rétention,
// rattachement des cabinets, etc.) sont injectées.
//
// weoDb et db sont typés de façon lâche (any) : better-sqlite3 n'expose pas de types.

import crypto from 'node:crypto';
import argon2 from 'argon2';

/** @typedef {any} Db */

// Champ WebOsteo normalisé en chaîne (jamais null/undefined).
/** @param {any} val */
function str(val) { return String(val ?? '').trim(); }

// Champ WebOsteo normalisé en nombre fini (0 par défaut).
/** @param {any} val */
function num(val) { const n = Number(val); return Number.isFinite(n) ? n : 0; }

// Heure par défaut appliquée à une date sans heure (YYYYMMDD).
const DEFAULT_TIME_FOR_DATE_ONLY = '08:00:00';

/**
 * Convertit une date WebOsteo YYYYMMDD en YYYY-MM-DD. Renvoie null si invalide.
 * @param {any} raw
 * @returns {string|null}
 */
export function parseWeoDate(raw) {
  const s = str(raw);
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return null;
}

/**
 * Convertit un horodatage WebOsteo YYYYMMDDHHmm (ou YYYYMMDD) en ISO 8601 UTC.
 * Renvoie null si invalide.
 * @param {any} raw
 * @returns {string|null}
 */
export function parseWeoDateTime(raw) {
  const s = str(raw);
  if (s.length >= 12 && /^\d{12}/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00.000Z`;
  }
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${DEFAULT_TIME_FOR_DATE_ONLY}.000Z`;
  }
  return null;
}

/**
 * Traduit le statut marital WebOsteo vers le vocabulaire OsteoSoft.
 * @param {any} raw
 * @returns {string}
 */
export function mapMaritalStatus(raw) {
  const v = str(raw).toLowerCase();
  if (v === 'c' || v === 'cel' || v === 'celibataire') return 'Celibataire';
  if (v === 'm' || v === 'marie' || v === 'married') return 'Marie(e)';
  if (v === 'p' || v === 'pacs' || v === 'pacse') return 'Pacse(e)';
  if (v === 'd' || v === 'div' || v === 'divorce') return 'Divorce(e)';
  if (v === 'v' || v === 'veuf' || v === 'veuve') return 'Veuf(ve)';
  return 'Non renseigne';
}

/**
 * Traduit le sexe WebOsteo vers le vocabulaire OsteoSoft.
 * @param {any} raw
 * @returns {string}
 */
export function mapSex(raw) {
  const v = str(raw).toLowerCase();
  if (v === 'f') return 'F';
  if (v === 'm') return 'M';
  return 'Non renseigne';
}

/**
 * Crée l'opération d'import WebOsteo liée à la base OsteoSoft.
 * @param {Db} db
 * @param {{
 *   encryptSensitiveField: (value: any) => any,
 *   decryptSensitiveField: (value: any) => any,
 *   resolveUserIdFromPractitionerText: (text: any) => any,
 *   parseImportedNullableNumber: (value: any) => any,
 *   formatRelatedPeople: (names: any) => any,
 *   updatePatientRetentionFields: (patientId: any, consultationDateIso: any) => any,
 *   computePatientRetentionDateIso: (birthDateIso: any) => any,
 *   syncUserOffices: (userId: any, officeIds: any) => any,
 *   storeAntecedentTypes: (labels: any) => any,
 *   replaceConsultationSections: (consultationId: any, sections: any) => any,
 *   CURRENT_CONSENT_FORM_VERSION: string
 * }} deps
 */
export function createWebOsteoImport(db, {
  encryptSensitiveField,
  decryptSensitiveField,
  resolveUserIdFromPractitionerText,
  parseImportedNullableNumber,
  formatRelatedPeople,
  updatePatientRetentionFields,
  computePatientRetentionDateIso,
  syncUserOffices,
  storeAntecedentTypes,
  replaceConsultationSections,
  CURRENT_CONSENT_FORM_VERSION
}) {
  /**
   * Importe une base WebOsteo déjà ouverte dans le cabinet cible. Renvoie le
   * décompte des entités importées, les erreurs non bloquantes et les mots de
   * passe temporaires générés pour les utilisateurs importés.
   * `patientListing` (optionnel) : rapprocheur issu de l'export « liste patients »
   * WebOsteo (server/lib/webosteo-listing.mjs). Quand il est fourni, l'identite
   * en clair (nom, telephones, email, adresse, code postal, ville, n. securite
   * sociale) provient de l'export, car ces champs sont CHIFFRES dans la base.
   * @param {{ weoDb: Db, officeId: number, userId: number, weoDocumentFiles: Map<string, { base64: string, mimeType: string, sizeBytes: number }>, patientListing?: { match: (p: any) => any, stats: any } | null }} params
   */
  async function importWebOsteoDatabase({ weoDb, officeId, userId, weoDocumentFiles, patientListing = null }) {
    // Longueur du texte clair d'origine d'un champ chiffre WebOsteo : le
    // chiffrement produit 2 octets par octet UTF-8 du clair.
    /** @param {any} v */
    const encLen = (v) => { try { return Math.round(Buffer.from(str(v), 'base64').length / 2); } catch { return 0; } };
    // Helpers de conversion (str, num, parseWeoDate, parseWeoDateTime,
    // mapMaritalStatus, mapSex) : fonctions pures définies au niveau module.

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

    /** @type {Array<{ entity: string, message: string }>} */
    const errors = [];
    /** @type {Record<string, string>} */
    const tempPasswords = {};
    const userLoginToUsername = new Map(); // WebOsteo login -> OsteoSoft username
    const weoPatientIdToOsteoId = new Map(); // WebOsteo patient.id -> OsteoSoft patients.id
    const weoPatientIdToFullName = new Map(); // WebOsteo patient.id -> full name (plain text)
    const weoConsultationIdToOsteoId = new Map(); // WebOsteo consultation.id -> OsteoSoft consultations.id
    const weoPaymentIdToOsteoInvoicePaymentId = new Map(); // WebOsteo paiement.id -> OsteoSoft invoice_payments.id

    let importedUsers = 0;
    let importedPatients = 0;
    let importedConsultations = 0;
    let importedAppointments = 0;
    let importedInvoices = 0;
    let importedContacts = 0;
    let importedDeposits = 0;
    let importedDocuments = 0;
    let updatedRelatedPeople = 0;

    // ---- Pré-calcul des mots de passe utilisateurs (async, avant la transaction) ----
    // argon2.hash is async and cannot run inside a synchronous better-sqlite3 transaction,
    // so we compute all password hashes up-front before entering the transaction.
    let weoUsers = [];
    try { weoUsers = weoDb.prepare('SELECT * FROM utilisateur').all(); } catch { /* table may not exist */ }

    let weoCourriers = [];
    try { weoCourriers = weoDb.prepare('SELECT * FROM courrier_entrant').all(); } catch { /* table may not exist */ }

    // userPreparedData: Map<login, { hash, tempPassword, isActive, retro }>
    const userPreparedData = new Map();
    for (const wu of weoUsers) {
      const username = str(wu.login);
      if (!username) continue;
      try {
        const tempPassword = crypto.randomBytes(8).toString('hex');
        const hash = await argon2.hash(tempPassword, {
          type: argon2.argon2id,
          memoryCost: 2 ** 16,
          timeCost: 3,
          parallelism: 1
        });
        // Support multiple WebOsteo field names for active status:
        // - 'enabled': 'oui'/'non' or '1'/'0'
        // - 'actif': '1'/'0' or 'true'/'false'
        const rawActive = wu.actif ?? wu.enabled ?? wu.is_active ?? wu.statut ?? null;
        const rawActiveStr = str(rawActive).toLowerCase();
        const isActive = (rawActiveStr === '0' || rawActiveStr === 'non' || rawActiveStr === 'false' || rawActiveStr === 'inactif') ? 0 : 1;
        const retro = num(wu.retro_defaut);
        userPreparedData.set(username, { hash, tempPassword, isActive, retro });
      } catch (err) {
        errors.push({ entity: 'utilisateur', message: `Login ${username}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Import principal dans une transaction atomique ----
    // All deletions and ALL insertions are wrapped in a single transaction so that
    // a crash or error mid-import never leaves the office in a partially-empty state.
    // Deletion order respects FK constraints (foreign_keys = ON):
    //   appointments and consultations reference patient_id without ON DELETE CASCADE,
    //   so they must be deleted before patients.
    //   invoice_line_items, invoice_payments and patient_payment_credit_allocations
    //   cascade from invoices/credits respectively.
    //   patient_antecedents, patient_documents and patient_payment_credits cascade from patients.
    db.transaction(() => {
      // ---- Remplacement des données du cabinet cible ----
      db.prepare('DELETE FROM appointments WHERE office_id = ?').run(officeId);
      db.prepare('DELETE FROM invoices WHERE office_id = ?').run(officeId);
      db.prepare('DELETE FROM patient_payment_credits WHERE office_id = ?').run(officeId);
      db.prepare('DELETE FROM consultations WHERE office_id = ?').run(officeId);
      db.prepare('DELETE FROM patients WHERE office_id = ?').run(officeId);
      db.prepare('DELETE FROM directory_contacts WHERE office_id = ?').run(officeId);
      // Les remises bancaires du cabinet sont aussi remplacées, sinon un second
      // import créerait des doublons (elles n'ont ni identifiant source ni upsert).
      // Les accounting_deposit_items disparaissent par cascade (ON DELETE CASCADE).
      db.prepare('DELETE FROM accounting_deposits WHERE office_id = ?').run(officeId);

    // ---- Utilisateurs ----
    for (const wu of weoUsers) {
      try {
        const username = str(wu.login);
        if (!username) continue;
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) {
          userLoginToUsername.set(username, username);
          continue;
        }

        const prepared = userPreparedData.get(username);
        if (!prepared) continue; // hash failed earlier, already recorded in errors

        // Webosteo users always receive a practitioner role at the application level.
        // Their access rights are scoped to the target office through office_user_delegations,
        // not through the application-level 'admin' role.
        const role = 'practitioner';

        const inserted = db.prepare(
          `INSERT INTO users (username, password_hash, role, is_active, profile_id, office_id, last_name, first_name, email, mobile_phone, country, siret, adeli_code, rpps_code, ape_naf_code, color_hex, retrocession_percent, must_change_password)
           VALUES (?, ?, ?, ?, 'cabinet-member', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
          username,
          prepared.hash,
          role,
          prepared.isActive,
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
          prepared.retro
        );

        const newUserId = Number(inserted.lastInsertRowid);

        // Grant the user access to the target office at cabinet level only.
        syncUserOffices(newUserId, [officeId]);
        db.prepare(
          `INSERT OR REPLACE INTO office_user_delegations (office_id, user_id, profile_id) VALUES (?, ?, 'cabinet-member')`
        ).run(officeId, newUserId);

        tempPasswords[username] = prepared.tempPassword;
        userLoginToUsername.set(username, username);
        importedUsers += 1;
      } catch (err) {
        errors.push({ entity: 'utilisateur', message: `Login ${str(wu.login)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Patients ----
    let weoPatients = [];
    try { weoPatients = weoDb.prepare('SELECT * FROM patient').all(); } catch { /* ignore */ }

    const now = new Date().toISOString();

    for (const wp of weoPatients) {
      try {
        const pid = str(wp.id);
        if (!pid) continue;

        // Identite : priorite a l'export « liste patients » (clair), puis a la
        // recuperation via l'agenda, puis aux champs bruts de la base (chiffres).
        const listed = patientListing ? patientListing.match({
          prenom: str(wp.prenom),
          sexe: str(wp.sexe),
          dob: str(wp.date_naissance),
          cree: str(wp.created),
          encLen: {
            nom: encLen(wp.nom),
            tel: encLen(wp.telephone1) || encLen(wp.telephone2),
            cp: encLen(wp.code_postal),
            ville: encLen(wp.ville),
            email: encLen(wp.email)
          }
        }) : null;
        const recovered = nameRecovery.get(pid);
        const lastName = (listed && listed.nom)
          ? listed.nom
          : (recovered ? recovered.nom : (str(wp.nom) || '[Non dechiffre]'));
        // Le prenom est en clair dans la base WebOsteo ; l'export sert de secours.
        const firstName = str(wp.prenom) || (listed && listed.prenom) || (recovered ? recovered.prenom : '') || '[Non dechiffre]';
        const fullName = `${lastName} ${firstName}`.trim();
        const birthDate = parseWeoDate(wp.date_naissance);
        const retentionUntil = computePatientRetentionDateIso(birthDate || null);

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
              weoPatientIdToFullName.set(pid, existingName.trim());
              duplicate = true;
              break;
            }
          } catch { /* ignore decrypt error */ }
        }
        if (duplicate) continue;

        const sex = mapSex(wp.sexe);
        const maritalStatus = mapMaritalStatus(wp.statut_marital);
        const childrenCount = Math.max(0, num(wp.nombre_enfant));

        // Coordonnees : clair de l'export si disponible, sinon champs bruts.
        const mobilePhone = listed ? str(listed.telephone1) : (str(wp.telephone1) || str(wp.portable) || '');
        const landlinePhone = listed ? str(listed.telephone2) : str(wp.telephone2);

        const medicalRecord = {
          generalRemarks: [str(wp.remarques_antecedents), str(wp.remarques)].filter(Boolean).join('\n').trim(),
          medicalHistory: '',
          consultationNote: '',
          relatedPeople: '',
          mobilePhone,
          landlinePhone,
          email: listed ? str(listed.email) : str(wp.email),
          address1: listed ? str(listed.adresse1) : str(wp.adresse1),
          address2: listed ? str(listed.adresse2) : str(wp.adresse2),
          postalCode: listed ? str(listed.code_postal) : str(wp.code_postal),
          city: listed ? str(listed.ville) : str(wp.ville),
          country: str(wp.pays) || 'France',
          maritalStatus,
          childrenCount,
          occupationOrSchool: str(wp.profession),
          hobbies: str(wp.activites),
          primaryDoctor: str(wp.medecin),
          socialSecurityNumber: listed ? str(listed.secu) : str(wp.secu),
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
          encryptSensitiveField(mobilePhone || landlinePhone || 'Non renseigne'),
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
        weoPatientIdToFullName.set(pid, fullName);
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
        const dateDisplay = parseWeoDate(str(ap.date_debut ?? ap.date ?? '')) || '';

        storeAntecedentTypes([category]);

        db.prepare(
          `INSERT INTO patient_antecedents (patient_id, date_precision, date_display, category, description, important, sort_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          'date',
          encryptSensitiveField(dateDisplay),
          encryptSensitiveField(category),
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

    const findExistingConsultation = db.prepare(
      'SELECT id FROM consultations WHERE patient_id = ? AND started_at = ? AND office_id = ?'
    );
    for (const wc of weoConsultations) {
      try {
        const patientId = weoPatientIdToOsteoId.get(str(wc.patient));
        if (!patientId) continue;

        const startedAt = parseWeoDateTime(wc.date_consult);
        if (!startedAt) continue;

        // Idempotency: skip if this consultation was already imported
        const existingConsult = findExistingConsultation.get(patientId, startedAt, officeId);
        if (existingConsult) {
          weoConsultationIdToOsteoId.set(str(wc.id), Number(existingConsult.id));
          continue;
        }

        const practitioner = str(wc.createdby);
        const heightCm = parseImportedNullableNumber(wc.taille);
        const weightKg = parseImportedNullableNumber(wc.poids);
        const evaBefore = Math.min(10, Math.max(0, num(wc.douleur)));
        const evaAfter = Math.min(10, Math.max(0, num(wc.douleur2 ?? wc.douleur_apres)));
        const important = str(wc.important) === '1' ? 1 : 0;
        const profile = str(wc.nourrisson).toLowerCase() === 'oui' ? 'Nourrisson' : 'Adulte';
        // Use titre if present, otherwise derive a plain-text title from remarques_motifs (WebOsteo ≥ v7)
        // or motif (older schema fallback)
        const rawTitle = str(wc.titre) || str(wc.remarques_motifs ?? wc.motif)
          .replace(/<[^>]*>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ').trim();
        const title = rawTitle.slice(0, 200);

        const inserted = db.prepare(
          `INSERT INTO consultations (patient_id, started_at, office_id, practitioner, user_id, title, important, height_cm, weight_kg, eva_before, eva_after, profile)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          startedAt,
          officeId,
          practitioner.slice(0, 100),
          resolveUserIdFromPractitionerText(practitioner),
          encryptSensitiveField(title),
          important,
          heightCm,
          weightKg,
          evaBefore,
          evaAfter,
          profile
        );

        const consultationId = Number(inserted.lastInsertRowid);
        weoConsultationIdToOsteoId.set(str(wc.id), consultationId);

        replaceConsultationSections(consultationId, {
          motifMainHtml: str(wc.remarques_motifs ?? wc.motif),
          testsHtml: str(wc.tests),
          schemaHtml: str(wc.schemadysfonctionnel),
          treatmentsHtml: str(wc.traitement),
          remarksHtml: str(wc.remarques)
        });

        updatePatientRetentionFields(patientId, startedAt);
        importedConsultations += 1;
      } catch (err) {
        errors.push({ entity: 'consultation', message: `ID ${str(wc.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Agenda ----
    let weoAgenda = [];
    try { weoAgenda = weoDb.prepare('SELECT * FROM agenda').all(); } catch { /* ignore */ }

    const findExistingAppointment = db.prepare(
      'SELECT id FROM appointments WHERE patient_id = ? AND starts_at = ? AND office_id = ?'
    );
    for (const wa of weoAgenda) {
      try {
        const patientId = weoPatientIdToOsteoId.get(str(wa.patient));
        if (!patientId) continue;

        const startsAt = parseWeoDateTime(wa.start_rdv);
        if (!startsAt) continue;

        // Idempotency: skip if this appointment was already imported
        const existingAppt = findExistingAppointment.get(patientId, startsAt, officeId);
        if (existingAppt) continue;

        const libelle = str(wa.libelle);
        const statut = str(wa.statut).toLowerCase();
        let status = 'Confirme';
        if (statut === 'absent' || str(wa.absent).toLowerCase() === 'oui') {
          status = 'Absent';
        }

        db.prepare(
          `INSERT INTO appointments (patient_id, starts_at, reason_cipher, status, office_id, local_calendar_id, consultation_id, practitioner, user_id, is_private)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          startsAt,
          encryptSensitiveField(libelle),
          status,
          officeId,
          null,
          null,
          str(wa.createdby).slice(0, 100),
          resolveUserIdFromPractitionerText(str(wa.createdby)),
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
        let invoiceStatus = 'impayee';
        if (etatPaiement === 'paye') invoiceStatus = 'payee';
        else if (etat === 'annulee') invoiceStatus = 'annulee';

        const consultationId = weoConsultationIdToOsteoId.get(str(wf.id_consultation)) ?? null;
        // Use formatted number if available, otherwise raw number, otherwise generate unique fallback
        const invoiceNumber = str(wf.numero_formatte) || str(wf.numero) || `WEO-${str(wf.id)}`;
        // mode_paiement does not exist on the facture table in WebOsteo — derive from the first payment record
        const firstPfEntry = paiementsByFacture.get(str(wf.id))?.[0];
        const firstPaiementData = firstPfEntry ? paiementById.get(str(firstPfEntry.id_paiement)) : null;
        const invoicePaymentMethod = firstPaiementData ? str(firstPaiementData.moyen_paiement) : '';

        const inserted = db.prepare(
          `INSERT INTO invoices (patient_id, invoice_number, amount_cents, status, issued_at, due_at, notes_cipher, office_id, consultation_id, payment_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          patientId,
          invoiceNumber,
          amountCents,
          invoiceStatus,
          issuedAt,
          issuedAt,
          encryptSensitiveField(str(wf.commentaire)),
          officeId,
          consultationId,
          invoicePaymentMethod
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
            const ipInserted = db.prepare(
              `INSERT INTO invoice_payments (invoice_id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              invoiceId,
              paidAt,
              Math.round(num(paiement.montant) * 100),
              str(wf.devise) || 'EUR',
              str(paiement.moyen_paiement),
              str(paiement.paiement_banque) ? encryptSensitiveField(str(paiement.paiement_banque)) : '',
              str(paiement.cheque_emetteur),
              str(paiement.reference),
              str(paiement.commentaire) || str(paiement.libelle)
            );
            const weoPaiementId = str(paiement.id);
            if (weoPaiementId && !weoPaymentIdToOsteoInvoicePaymentId.has(weoPaiementId)) {
              weoPaymentIdToOsteoInvoicePaymentId.set(weoPaiementId, Number(ipInserted.lastInsertRowid));
            }
          } catch { /* ignore payment errors */ }
        }

        // Fallback: if no paiement_facture rows exist for this paid invoice, synthesize
        // a payment using the invoice amount and date (date_paiement / mode_paiement do not
        // exist as columns in the WebOsteo facture table, so we use issuedAt and empty method)
        if (paiementFactures.length === 0 && invoiceStatus === 'payee') {
          try {
            db.prepare(
              `INSERT INTO invoice_payments (invoice_id, paid_at, amount_cents, currency, payment_method, bank_name_cipher, cheque_number, reference, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              invoiceId,
              issuedAt,
              amountCents,
              str(wf.devise) || 'EUR',
              '',
              '',
              '',
              '',
              ''
            );
          } catch { /* ignore */ }
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
          userId,
          userId
        );
        importedContacts += 1;
      } catch (err) {
        errors.push({ entity: 'contact', message: `ID ${str(wc.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Documents patients (courriers entrants) ----
    // courrier_entrant stores metadata; the actual file bytes were extracted from the zip's
    // patients/ folder into weoDocumentFiles before the transaction.
    // patient_documents cascade-delete from patients, so no explicit DELETE is needed here.
    for (const wc of weoCourriers) {
      try {
        const patientId = weoPatientIdToOsteoId.get(str(wc.patient));
        if (!patientId) continue;
        const fileName = str(wc.titre);
        if (!fileName) continue;
        const fileData = weoDocumentFiles.get(fileName);
        if (!fileData) continue; // file not present in zip (e.g. .data import without folder)

        const consultationId = weoConsultationIdToOsteoId.get(str(wc.consultation)) ?? null;
        const createdAt = parseWeoDate(wc.date_courrier)
          ? `${parseWeoDate(wc.date_courrier)}T00:00:00.000Z`
          : new Date().toISOString();

        db.prepare(
          `INSERT OR IGNORE INTO patient_documents
            (document_ref, patient_id, consultation_id, office_id, created_by, file_name, mime_type, size_bytes, title_cipher, comment_cipher, content_cipher, document_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `doc-weo-${str(wc.id)}`,
          patientId,
          consultationId,
          officeId,
          null,
          fileName,
          fileData.mimeType,
          fileData.sizeBytes,
          null,
          wc.comment ? encryptSensitiveField(str(wc.comment)) : null,
          encryptSensitiveField(fileData.base64),
          'document',
          createdAt
        );
        importedDocuments += 1;
      } catch (err) {
        errors.push({ entity: 'document', message: `ID ${str(wc.id)}: ${err instanceof Error ? err.message : 'Erreur'}` });
      }
    }

    // ---- Liens de parenté ----
    // Map WebOsteo family/kinship relationships to OsteoSoft relatedPeople field.
    // Try common WebOsteo column name variations defensively.
    let weoLiensParente = [];
    try { weoLiensParente = weoDb.prepare('SELECT * FROM lien_parente').all(); } catch { /* table may not exist */ }

    if (weoLiensParente.length > 0) {
      // relatedPeopleByOsteoId: osteoPatientId -> Set of related full names
      const relatedPeopleByOsteoId = new Map();
      const addRelated = (/** @type {any} */ osteoId, /** @type {any} */ relatedName) => {
        if (!relatedPeopleByOsteoId.has(osteoId)) relatedPeopleByOsteoId.set(osteoId, new Set());
        relatedPeopleByOsteoId.get(osteoId).add(relatedName);
      };

      for (const lp of weoLiensParente) {
        try {
          // Support multiple possible column name conventions
          const pid1 = str(lp.patient ?? lp.patient1 ?? lp.id_patient ?? lp.patient_id ?? '');
          const pid2 = str(lp.patient_lie ?? lp.patient2 ?? lp.id_patient_lie ?? lp.patient_lie_id ?? '');
          if (!pid1 || !pid2 || pid1 === pid2) continue;

          const osteoId1 = weoPatientIdToOsteoId.get(pid1);
          const osteoId2 = weoPatientIdToOsteoId.get(pid2);
          const name1 = weoPatientIdToFullName.get(pid1);
          const name2 = weoPatientIdToFullName.get(pid2);

          if (osteoId1 && name2) addRelated(osteoId1, name2);
          if (osteoId2 && name1) addRelated(osteoId2, name1);
        } catch (err) {
          errors.push({ entity: 'lien_parente', message: err instanceof Error ? err.message : 'Erreur' });
        }
      }

      // Update cipher_medical_notes for each affected patient
      for (const [osteoId, relatedNames] of relatedPeopleByOsteoId) {
        try {
          const row = db.prepare('SELECT cipher_medical_notes FROM patients WHERE id = ?').get(osteoId);
          if (!row) continue;
          const notes = JSON.parse(decryptSensitiveField(row.cipher_medical_notes));
          notes.relatedPeople = formatRelatedPeople([...relatedNames]);
          db.prepare('UPDATE patients SET cipher_medical_notes = ? WHERE id = ?')
            .run(encryptSensitiveField(JSON.stringify(notes)), osteoId);
          updatedRelatedPeople += 1;
        } catch { /* ignore individual update errors */ }
      }
    }

    // ---- Remises bancaires (comptabilité) ----
    // WebOsteo stores remittances either as two separate typed tables (remise_cheque /
    // remise_especes — current schema) or as a single generic table (older schemas).
    // We try the two-table approach first, then fall back to the generic candidates.

    const insertDeposit = (/** @type {any} */ wr, /** @type {any} */ type, /** @type {any} */ amountCents, /** @type {any} */ paiementIdsByRemise) => {
      const weoRemiseId = str(wr.id ?? '');
      const occurredRaw = wr.date_remise ?? wr.date_encaissement ?? wr.date_depot ?? wr.date ?? null;
      const occurredAt = parseWeoDate(occurredRaw);
      if (!occurredAt) return;

      const rawBanque = str(wr.banque ?? wr.etablissement ?? wr.bank ?? '');
      const reference = str(wr.reference ?? wr.code ?? wr.ref ?? '');
      const notes = str(wr.commentaire ?? wr.comment ?? wr.libelle ?? wr.notes ?? '');
      const title = type === 'especes' ? 'Remise d\'especes' : 'Remise de cheques';
      const createdByLogin = str(wr.createdby ?? wr.utilisateur ?? wr.login ?? '');
      const ownerUser = createdByLogin
        ? db.prepare('SELECT id FROM users WHERE username = ?').get(createdByLogin)
        : null;
      const ownerUserId = ownerUser ? ownerUser.id : null;

      const depositResult = db.prepare(
        `INSERT INTO accounting_deposits (occurred_at, office_id, owner_user_id, type, deposit_code, bank_name_cipher, account_label, title, amount_cents, currency, notes, retrocession_percent, retrocession_recipient, is_deleted, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `${occurredAt}T10:00:00.000Z`,
        officeId,
        ownerUserId,
        type,
        reference || `WEO-${weoRemiseId}`,
        rawBanque ? encryptSensitiveField(rawBanque) : '',
        '',
        title,
        amountCents,
        'EUR',
        notes,
        0,
        '',
        0,
        ownerUserId
      );
      const depositId = Number(depositResult.lastInsertRowid);
      importedDeposits += 1;

      const linkedPaiementIds = paiementIdsByRemise.get(weoRemiseId) ?? [];
      for (const weoPaiementId of linkedPaiementIds) {
        const osteoIpId = weoPaymentIdToOsteoInvoicePaymentId.get(weoPaiementId);
        if (!osteoIpId) continue;
        try {
          db.prepare(
            `INSERT OR IGNORE INTO accounting_deposit_items (deposit_id, source_type, source_id, created_at) VALUES (?, ?, ?, ?)`
          ).run(depositId, 'invoice', osteoIpId, new Date().toISOString());
        } catch { /* ignore duplicate / FK errors */ }
      }
    };

    // Approach 1: two dedicated tables (remise_cheque / remise_especes) — WebOsteo current schema
    let usedTwoTableApproach = false;
    try {
      const remiseCheques = weoDb.prepare('SELECT * FROM remise_cheque').all();
      const remiseEspeces = weoDb.prepare('SELECT * FROM remise_especes').all();
      usedTwoTableApproach = true;

      // In the two-table schema, each paiement references its remittance directly (no junction
      // table). Column names vary across versions, so resolve them defensively: prefer a typed
      // foreign key (id_remise_cheque / id_remise_especes), then fall back to a generic
      // id_remise/remise column disambiguated by the payment method.
      const chequeRemiseToPaiementIds = new Map();
      const especesRemiseToPaiementIds = new Map();
      const pushPaiement = (/** @type {any} */ map, /** @type {any} */ remiseKey, /** @type {any} */ paiementId) => {
        if (!remiseKey || !paiementId) return;
        if (!map.has(remiseKey)) map.set(remiseKey, []);
        map.get(remiseKey).push(paiementId);
      };
      for (const p of weoPaiements) {
        const pid = str(p.id);
        if (!pid) continue;
        const chequeRef = str(p.id_remise_cheque ?? p.remise_cheque ?? '');
        if (chequeRef) { pushPaiement(chequeRemiseToPaiementIds, chequeRef, pid); continue; }
        const especesRef = str(p.id_remise_especes ?? p.remise_especes ?? '');
        if (especesRef) { pushPaiement(especesRemiseToPaiementIds, especesRef, pid); continue; }
        const genericRef = str(p.id_remise ?? p.remise ?? '');
        if (!genericRef) continue;
        const method = str(p.moyen_paiement ?? p.mode_paiement ?? '').toLowerCase();
        if (method.includes('espece') || method.includes('cash')) {
          pushPaiement(especesRemiseToPaiementIds, genericRef, pid);
        } else if (method.includes('cheque') || method.includes('chèque')) {
          pushPaiement(chequeRemiseToPaiementIds, genericRef, pid);
        }
      }

      for (const wr of remiseCheques) {
        try {
          const amountCents = Math.round(num(wr.montant_cheques ?? wr.montant ?? 0) * 100);
          insertDeposit(wr, 'cheque', amountCents, chequeRemiseToPaiementIds);
        } catch (err) {
          errors.push({ entity: 'remise_cheque', message: `ID ${str(wr.id ?? '')}: ${err instanceof Error ? err.message : 'Erreur'}` });
        }
      }
      for (const wr of remiseEspeces) {
        try {
          const amountCents = Math.round(num(wr.montant ?? 0) * 100);
          insertDeposit(wr, 'especes', amountCents, especesRemiseToPaiementIds);
        } catch (err) {
          errors.push({ entity: 'remise_especes', message: `ID ${str(wr.id ?? '')}: ${err instanceof Error ? err.message : 'Erreur'}` });
        }
      }
    } catch { /* tables don't exist, fall through to generic approach */ }

    // Approach 2: generic single table (older WebOsteo schemas)
    if (!usedTwoTableApproach) {
      let weoRemises = [];
      let weoRemisePaiements = [];
      const remiseCandidates = ['encaissement', 'remise_bancaire', 'remise', 'depot_banque'];
      const remisePaiementCandidates = ['encaissement_paiement', 'remise_bancaire_paiement', 'remise_paiement', 'depot_banque_paiement'];

      for (let i = 0; i < remiseCandidates.length; i++) {
        try {
          weoRemises = weoDb.prepare(`SELECT * FROM ${remiseCandidates[i]}`).all();
          try { weoRemisePaiements = weoDb.prepare(`SELECT * FROM ${remisePaiementCandidates[i]}`).all(); } catch { /* no junction table */ }
          break;
        } catch { /* table not found, try next */ }
      }

      const paiementIdsByRemise = new Map();
      for (const rp of weoRemisePaiements) {
        const remiseId = str(rp.id_encaissement ?? rp.id_remise ?? rp.id_depot ?? rp.encaissement_id ?? rp.remise_id ?? '');
        const paiementId = str(rp.id_paiement ?? rp.paiement_id ?? '');
        if (!remiseId || !paiementId) continue;
        if (!paiementIdsByRemise.has(remiseId)) paiementIdsByRemise.set(remiseId, []);
        paiementIdsByRemise.get(remiseId).push(paiementId);
      }

      const mapRemiseType = (/** @type {any} */ raw) => {
        const v = str(raw).toLowerCase();
        if (v.includes('cheque') || v.includes('chèque') || v === 'ch') return 'cheque';
        if (v.includes('espece') || v.includes('espèce') || v.includes('cash') || v === 'es') return 'especes';
        return v || 'cheque';
      };

      for (const wr of weoRemises) {
        try {
          const type = mapRemiseType(wr.type_remise ?? wr.type_encaissement ?? wr.type ?? wr.mode ?? '');
          const amountCents = Math.round(num(wr.montant ?? wr.montant_total ?? wr.montant_cheques ?? wr.amount ?? 0) * 100);
          insertDeposit(wr, type, amountCents, paiementIdsByRemise);
        } catch (err) {
          errors.push({ entity: 'remise', message: `ID ${str(wr.id ?? '')}: ${err instanceof Error ? err.message : 'Erreur'}` });
        }
      }
    }
    })(); // end of atomic import transaction

    return {
      importedUsers,
      importedPatients,
      importedConsultations,
      importedAppointments,
      importedInvoices,
      importedContacts,
      importedDeposits,
      importedDocuments,
      updatedRelatedPeople,
      errors,
      tempPasswords,
      listing: patientListing ? patientListing.stats : null
    };
  }

  return { importWebOsteoDatabase };
}
