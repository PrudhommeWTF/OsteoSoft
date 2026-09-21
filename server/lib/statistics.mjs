// Statistiques et tableau de bord.
//
// Deux couches :
//  1. Fonctions PURES : normalisation des paramètres (périmètre, granularité,
//     années), découpage, extraction d'antécédents et construction des séries.
//  2. Une fabrique createStatisticsService(db, deps) qui ferme sur la base et
//     renvoie les agrégations : périmètre de cabinets, utilisateurs, tranche
//     d'âge, motifs de consultation, classement des patients, correspondance
//     praticien, répartition des paiements et assemblage complet du tableau de
//     bord (buildStatisticsPayload).
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Les routes HTTP
// restent dans index.mjs. Les fonctions transverses (chiffrement, âge, clé de nom,
// cartes de consultation/antécédents, opérations comptables, options de cabinet,
// notes patient, sexe) sont injectées ; le catalogue de permissions vient
// d'access.mjs.
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

import { SUPER_ADMIN_PROFILE_ID, hasPermission } from './access.mjs';

/** @typedef {any} Db */

export function normalizeStatisticsScopeMode(/** @type {any} */ rawValue) {
  return String(rawValue ?? '').trim() === 'consolidated' ? 'consolidated' : 'active-office';
}

export function normalizeStatisticsGranularity(/** @type {any} */ rawValue) {
  const value = String(rawValue ?? '').trim();
  if (value === 'quarter' || value === 'year') {
    return value;
  }
  return 'month';
}

export function normalizeStatisticsYears(/** @type {any} */ rawValue, fallbackValue = 5) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    return fallbackValue;
  }
  return Math.min(Math.max(parsed, 1), 10);
}

export function parseStatisticsYearList(/** @type {any} */ rawValue, fallbackYears = 5) {
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

export function buildAvailableStatisticsYears(/** @type {any} */ selectedYears, fallbackYears = 5) {
  const currentYear = new Date().getFullYear();
  const windowSize = Math.min(Math.max(fallbackYears, selectedYears.length, 5), 10);
  return Array.from({ length: windowSize }, (_value, index) => currentYear - index);
}

export function getStatisticsEvolutionRange(/** @type {any} */ years) {
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

export function normalizeStatisticsText(/** @type {any} */ value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function splitStatisticsPatientName(/** @type {any} */ fullName) {
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

export function stripStatisticsHtml(/** @type {any} */ rawValue) {
  return normalizeStatisticsText(String(rawValue ?? '').replace(/<[^>]*>/g, ' '));
}

export function parseStatisticsAntecedents(/** @type {any} */ medicalHistoryRaw) {
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

export function buildStatisticsAnnualValuePoints(/** @type {any} */ rows, /** @type {any} */ startYear, /** @type {any} */ endYear, /** @type {any} */ getDateValue, /** @type {any} */ getValue) {
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

export function buildStatisticsMonthlySeries(/** @type {any} */ rows, /** @type {any} */ selectedYears, /** @type {any} */ getDateValue, /** @type {any} */ getValue) {
  const monthFormatter = new Intl.DateTimeFormat('fr-FR', { month: 'short' });

  return selectedYears.map((/** @type {any} */ year) => {
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

export function buildStatisticsConsultationEvolutionPoints(/** @type {any} */ rows, /** @type {any} */ granularity, /** @type {any} */ startYear, /** @type {any} */ endYear) {
  if (granularity === 'year') {
    return buildStatisticsAnnualValuePoints(rows, startYear, endYear, (/** @type {any} */ row) => row.started_at, () => 1);
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

/**
 * Crée les agrégations statistiques liées à la base OsteoSoft.
 * @param {Db} db
 * @param {{
 *   decryptSensitiveField: (v: any) => any,
 *   getAgeFromBirthDate: (birthDate: any) => any,
 *   normalizePersonNameKey: (name: any) => any,
 *   parsePatientNotesFromCipher: (cipher: any) => any,
 *   normalizePatientSexLabel: (sex: any) => any,
 *   getAccessibleBillingOfficeIds: (access: any) => any[],
 *   getBillingOfficeOptions: (officeIds: any) => any[],
 *   getBillingOperationsData: (params: any) => any,
 *   buildPatientAntecedentsMap: (rows: any) => any,
 *   buildEmptyConsultationSections: () => any,
 *   buildConsultationSectionsMap: (rows: any) => any,
 *   buildConsultationReasonItemsMap: (rows: any) => any
 * }} deps
 */
export function createStatisticsService(db, {
  decryptSensitiveField,
  getAgeFromBirthDate,
  normalizePersonNameKey,
  parsePatientNotesFromCipher,
  normalizePatientSexLabel,
  getAccessibleBillingOfficeIds,
  getBillingOfficeOptions,
  getBillingOperationsData,
  buildPatientAntecedentsMap,
  buildEmptyConsultationSections,
  buildConsultationSectionsMap,
  buildConsultationReasonItemsMap
}) {
  function getStatisticsUsersForOfficeIds(/** @type {any} */ officeIds) {
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
      .map((/** @type {any} */ row) => {
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

  function getScopedStatisticsOfficeIds(/** @type {any} */ access, /** @type {any} */ scopeMode, /** @type {any} */ requestedOfficeId) {
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

  function getStatisticsAgeRangeFromBirthDate(/** @type {any} */ birthDate) {
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

  function parseStatisticsConsultationReasons(/** @type {any} */ structuredItems = [], /** @type {any} */ structuredSections = null) {
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

  function buildStatisticsRankedPatientItems(/** @type {any} */ rows, /** @type {any} */ countByPatientId) {
    return rows
      .map((/** @type {any} */ row) => {
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
      .filter((/** @type {any} */ item) => item.count > 0)
      .sort((/** @type {any} */ left, /** @type {any} */ right) => right.count - left.count || left.fullName.localeCompare(right.fullName, 'fr', { sensitivity: 'base' }))
      .slice(0, 10)
      .map((/** @type {any} */ item, /** @type {any} */ index) => ({
        rank: index + 1,
        ...item
      }));
  }

  function matchStatisticsUser(/** @type {any} */ practitioner, /** @type {any} */ users) {
    const key = normalizePersonNameKey(practitioner);
    if (!key) {
      return null;
    }

    return users.find((/** @type {any} */ user) => user.matchKeys.includes(key)) ?? null;
  }

  /** @param {{ fromIso: any, toIso: any, scopedOfficeIds: any, ownerUserId: any }} params */
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

  /** @param {{ requestingUserId: any, access: any, scopeMode: any, requestedOfficeId: any, years: any, yearlyBreakdownYears: any, consultationGranularity: any, requestedUserId: any }} params */
  function buildStatisticsPayload({ requestingUserId, access, scopeMode, requestedOfficeId, years, yearlyBreakdownYears, consultationGranularity, requestedUserId }) {
    const { availableOfficeIds, scopedOfficeIds, selectedOfficeId } = getScopedStatisticsOfficeIds(access, scopeMode, requestedOfficeId);
    const canViewPeerStatistics = access.role === 'admin'
      || access.profileId === SUPER_ADMIN_PROFILE_ID
      || hasPermission(access.rights, 'read-peer-statistics');
    const scopedUsers = getStatisticsUsersForOfficeIds(scopedOfficeIds.length > 0 ? scopedOfficeIds : availableOfficeIds);
    const selfFallbackRow = db
      .prepare('SELECT id, username, first_name, last_name FROM users WHERE id = ? AND is_active = 1')
      .get(requestingUserId);

    if (selfFallbackRow && !scopedUsers.some((/** @type {any} */ user) => user.id === requestingUserId)) {
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
      : scopedUsers.filter((/** @type {any} */ user) => user.id === requestingUserId)
    ).map((/** @type {any} */ user) => ({
      id: user.id,
      displayName: user.displayName
    }));

    const selectedUserId = (() => {
      const parsed = Number(requestedUserId);
      if (Number.isInteger(parsed) && visibleUserOptions.some((/** @type {any} */ user) => user.id === parsed)) {
        return parsed;
      }

      if (visibleUserOptions.some((/** @type {any} */ user) => user.id === requestingUserId)) {
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
        `SELECT id, patient_id, started_at, office_id, practitioner, user_id, profile
         FROM consultations`
      )
      .all();
    const appointmentRows = db
      .prepare(
        `SELECT id, patient_id, starts_at, status, office_id
         FROM appointments`
      )
      .all();

    const scopedConsultationRows = consultationRows.filter((/** @type {any} */ row) => {
      const officeId = row.office_id != null ? Number(row.office_id) : null;
      return scopedOfficeIds.length > 0 && officeId != null && scopedOfficeIds.includes(officeId);
    });
    const scopedAppointmentRows = appointmentRows.filter((/** @type {any} */ row) => {
      const officeId = row.office_id != null ? Number(row.office_id) : null;
      return scopedOfficeIds.length > 0 && officeId != null && scopedOfficeIds.includes(officeId);
    });

    const patientIdsInScope = new Set([
      ...scopedConsultationRows.map((/** @type {any} */ row) => Number(row.patient_id)),
      ...scopedAppointmentRows.map((/** @type {any} */ row) => Number(row.patient_id))
    ]);

    const patientsInScope = patientRows.filter((/** @type {any} */ row) => patientIdsInScope.has(Number(row.id)));
    const patientRowById = new Map(patientsInScope.map((/** @type {any} */ row) => [Number(row.id), row]));
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

    const consultationRowsInWindow = scopedConsultationRows.filter((/** @type {any} */ row) => {
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

      const matchedUser = row.user_id != null
        ? (scopedUsers.find((/** @type {any} */ u) => u.id === Number(row.user_id)) ?? matchStatisticsUser(row.practitioner, scopedUsers))
        : matchStatisticsUser(row.practitioner, scopedUsers);
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
      ? (scopedUsers.find((/** @type {any} */ user) => user.id === selectedUserId) ?? null)
      : null;
    const userConsultationRows = selectedUser
      ? consultationRowsInWindow.filter((/** @type {any} */ row) => {
          if (row.user_id != null) {
            return Number(row.user_id) === selectedUser.id;
          }
          return matchStatisticsUser(row.practitioner, [selectedUser])?.id === selectedUser.id;
        })
      : [];
    const userConsultationRowsAll = selectedUser
      ? scopedConsultationRows.filter((/** @type {any} */ row) => {
          if (row.user_id != null) {
            return Number(row.user_id) === selectedUser.id;
          }
          return matchStatisticsUser(row.practitioner, [selectedUser])?.id === selectedUser.id;
        })
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
        monthlyByYear: buildStatisticsMonthlySeries(scopedConsultationRows, yearlyBreakdownYears, (/** @type {any} */ row) => row.started_at, () => 1),
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
          (/** @type {any} */ row) => row.occurredAt,
          (/** @type {any} */ row) => row.creditCents
        ),
        revenueMonthlyByYear: buildStatisticsMonthlySeries(overallBillingOperations, yearlyBreakdownYears, (/** @type {any} */ row) => row.occurredAt, (/** @type {any} */ row) => row.creditCents),
        profitEvolution: buildStatisticsAnnualValuePoints(
          overallBillingOperations,
          evolutionRange.startYear,
          evolutionRange.currentYear,
          (/** @type {any} */ row) => row.occurredAt,
          (/** @type {any} */ row) => row.creditCents - row.debitCents
        ),
        profitMonthlyByYear: buildStatisticsMonthlySeries(
          overallBillingOperations,
          yearlyBreakdownYears,
          (/** @type {any} */ row) => row.occurredAt,
          (/** @type {any} */ row) => row.creditCents - row.debitCents
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
            (/** @type {any} */ row) => row.occurredAt,
            (/** @type {any} */ row) => row.creditCents
          ),
          revenueMonthlyByYear: buildStatisticsMonthlySeries(userBillingOperations, yearlyBreakdownYears, (/** @type {any} */ row) => row.occurredAt, (/** @type {any} */ row) => row.creditCents),
          profitEvolution: buildStatisticsAnnualValuePoints(
            userBillingOperations,
            evolutionRange.startYear,
            evolutionRange.currentYear,
            (/** @type {any} */ row) => row.occurredAt,
            (/** @type {any} */ row) => row.creditCents - row.debitCents
          ),
          profitMonthlyByYear: buildStatisticsMonthlySeries(
            userBillingOperations,
            yearlyBreakdownYears,
            (/** @type {any} */ row) => row.occurredAt,
            (/** @type {any} */ row) => row.creditCents - row.debitCents
          ),
          consultationEvolution: buildStatisticsConsultationEvolutionPoints(
            userConsultationRows,
            consultationGranularity,
            evolutionRange.startYear,
            evolutionRange.currentYear
          ),
          consultationMonthlyByYear: buildStatisticsMonthlySeries(userConsultationRowsAll, yearlyBreakdownYears, (/** @type {any} */ row) => row.started_at, () => 1),
          paymentMethods: userPaymentMethods
        }
        : null
    };
  }

  return {
    getStatisticsUsersForOfficeIds,
    getScopedStatisticsOfficeIds,
    getStatisticsPaymentMethodDistribution,
    buildStatisticsPayload
  };
}
