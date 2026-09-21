// Patients et consultations : fonctions pures du domaine central.
//
// Normalisation et lecture des données patient/consultation qui ne dépendent ni
// de la base ni du chiffrement : profils de consultation d'un cabinet, modèles de
// courrier, antécédents (catégories, tri, extraction), items de motif et sections
// de consultation, libellé de sexe, date de rétention, type de consultation, clé
// de rapprochement à l'import.
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Les opérations
// liées à la base et au chiffrement (insertion de consultation, remplacement des
// antécédents, cartes déchiffrées, anonymisation, rétention effective) restent
// dans index.mjs, notamment parce qu'elles sont injectées dans d'autres modules
// et que leur ordre d'initialisation y est contraint.

// Clés des sections d'une consultation (contenu chiffré par section).
export const CONSULTATION_SECTION_KEYS = ['motifMainHtml', 'testsHtml', 'schemaHtml', 'treatmentsHtml', 'remarksHtml'];

export function normalizeOfficeConsultationProfiles(/** @type {any} */ rawProfiles) {
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
          .map((/** @type {any} */ reason) => String(reason ?? '').trim())
          .filter((/** @type {any} */ reason) => reason.length > 0)
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

export function parseOfficeConsultationProfiles(/** @type {any} */ rawJson) {
  if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
    return [];
  }

  try {
    return normalizeOfficeConsultationProfiles(JSON.parse(rawJson));
  } catch {
    return [];
  }
}

export function normalizePatientLetterTemplates(/** @type {any} */ rawValue) {
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

export function extractAntecedentCategories(/** @type {any} */ medicalHistoryRaw) {
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

export function buildAntecedentSortKey(/** @type {any} */ precision, /** @type {any} */ display) {
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

export function parsePatientAntecedentsFromMedicalHistory(/** @type {any} */ medicalHistoryRaw) {
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

export function normalizeConsultationReasonItems(/** @type {any} */ rawItems) {
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

export function buildEmptyConsultationSections() {
  return {
    motifMainHtml: '',
    testsHtml: '',
    schemaHtml: '',
    treatmentsHtml: '',
    remarksHtml: ''
  };
}

export function normalizeConsultationSectionsPayload(/** @type {any} */ rawSections) {
  const source = rawSections && typeof rawSections === 'object' ? rawSections : {};
  const normalized = /** @type {Record<string, any>} */ (buildEmptyConsultationSections());

  for (const key of CONSULTATION_SECTION_KEYS) {
    normalized[key] = String(source[key] ?? '');
  }

  return normalized;
}

export function hasConsultationSectionsContent(/** @type {any} */ sections) {
  return CONSULTATION_SECTION_KEYS.some((key) => String(sections?.[key] ?? '').trim().length > 0);
}

export function buildDataImportPatientKey(/** @type {any} */ lastName, /** @type {any} */ firstName, /** @type {any} */ birthDate) {
  return [
    String(lastName ?? '').trim().toLowerCase(),
    String(firstName ?? '').trim().toLowerCase(),
    String(birthDate ?? '').trim()
  ].join('|');
}

export function normalizePatientSexLabel(/** @type {any} */ rawSex) {
  if (rawSex === 'F') {
    return 'Femme';
  }
  if (rawSex === 'M') {
    return 'Homme';
  }
  return 'Non renseigne';
}

export function computePatientRetentionDateIso(/** @type {any} */ birthDateIso = null) {
  // Base rule: 10 years from today (used when no consultation date is known)
  const tenYearsFromNow = new Date();
  tenYearsFromNow.setFullYear(tenYearsFromNow.getFullYear() + 10);

  // GDPR / Code de la santé publique: medical records for minors must be kept
  // until at least the patient's 28th birthday (10 years after majority at 18).
  if (birthDateIso) {
    const minorThreshold = new Date(birthDateIso);
    minorThreshold.setFullYear(minorThreshold.getFullYear() + 28);
    if (minorThreshold > tenYearsFromNow) {
      return minorThreshold.toISOString().slice(0, 10);
    }
  }

  return tenYearsFromNow.toISOString().slice(0, 10);
}

export function buildDefaultPatientNotes() {
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

export function inferConsultationType(/** @type {any} */ reason) {
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
