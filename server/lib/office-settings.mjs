// Paramètres cabinet : fonctions pures de normalisation.
//
// Horaires d'ouverture, durée de séance, devise, format et configuration des
// numéros de facture, modèle de facture (mise en page, styles, réglages
// globaux), titres et contenus de courrier, prestations, méthodes de paiement
// (dont clé système), et normalisation des identifiants de cabinet.
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Les lectures
// et écritures liées à la base (prestations, méthodes de paiement, délégations,
// réglages généraux et agenda, mapOfficeRow) restent dans index.mjs.

import { OFFICE_OPENING_DAY_KEYS } from './agenda.mjs';

// Format d'une heure d'ouverture (HH:MM sur 24 h).
const OFFICE_OPENING_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function createDefaultOfficeOpeningHours() {
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

export function normalizeOfficeOpeningHours(/** @type {any} */ rawOpeningHours) {
  const normalized = /** @type {Record<string, any>} */ (createDefaultOfficeOpeningHours());

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

export function parseOfficeOpeningHours(/** @type {any} */ rawJson) {
  if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
    return createDefaultOfficeOpeningHours();
  }

  try {
    return normalizeOfficeOpeningHours(JSON.parse(rawJson));
  } catch {
    return createDefaultOfficeOpeningHours();
  }
}

export function normalizeOfficeDefaultSessionDurationMinutes(/** @type {any} */ rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    return 60;
  }

  return Math.min(Math.max(parsed, 15), 90);
}

export function normalizeOfficeDevise(/** @type {any} */ rawValue) {
  const value = String(rawValue ?? '').trim().toUpperCase();
  return ['EUR', 'USD', 'CHF', 'GBP', 'CAD'].includes(value) ? value : 'EUR';
}

export function normalizeOfficeInvoiceNumberFormat(/** @type {any} */ rawValue) {
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

export function normalizeOfficeInvoiceNumberingConfiguration(/** @type {any} */ rawValue) {
  const value = String(rawValue ?? '').trim();
  return value === 'Numérotation par praticien' ? value : 'Numérotation globale au cabinet';
}

export function clampInvoiceTemplateLayoutValue(/** @type {any} */ value, /** @type {any} */ min, /** @type {any} */ max, /** @type {any} */ fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function defaultInvoiceTemplateBlock(/** @type {any} */ x, /** @type {any} */ y, /** @type {any} */ w) {
  return { x, y, w, visible: true, fontSize: 10, color: '#000000', borderStyle: 'none' };
}

export function defaultInvoiceTemplateLayout() {
  return {
    logo: defaultInvoiceTemplateBlock(4, 4, 24),
    practitioner: defaultInvoiceTemplateBlock(30, 4, 32),
    patient: defaultInvoiceTemplateBlock(64, 4, 32),
    invoiceMeta: defaultInvoiceTemplateBlock(64, 20, 32),
    lineItems: defaultInvoiceTemplateBlock(4, 32, 92),
    totals: defaultInvoiceTemplateBlock(56, 74, 40),
    payment: defaultInvoiceTemplateBlock(4, 74, 50),
    mentions: defaultInvoiceTemplateBlock(4, 86, 92),
    signature: defaultInvoiceTemplateBlock(60, 92, 36),
    _global: { primaryColor: '#4d92d1', fontFamily: 'helvetica', showPageNumber: false, footerText: '' }
  };
}

export function normalizeInvoiceTemplateBlockStyle(/** @type {any} */ candidate, /** @type {any} */ fallback) {
  const visible = candidate?.visible !== false;
  const fontSize = clampInvoiceTemplateLayoutValue(candidate?.fontSize, 9, 14, fallback?.fontSize ?? 10);
  const rawColor = String(candidate?.color ?? fallback?.color ?? '#000000');
  const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#000000';
  const borderStyle = ['none', 'line', 'box'].includes(candidate?.borderStyle) ? candidate.borderStyle : 'none';
  const customLabel = typeof candidate?.customLabel === 'string' ? candidate.customLabel.slice(0, 80) : undefined;
  const content = typeof candidate?.content === 'string' ? candidate.content.slice(0, 5000) : undefined;
  return {
    visible, fontSize, color, borderStyle,
    ...(customLabel != null ? { customLabel } : {}),
    ...(content != null ? { content } : {})
  };
}

export function normalizeInvoiceTemplateGlobalSettings(/** @type {any} */ candidate) {
  const validFonts = ['helvetica', 'courier', 'times'];
  const rawColor = String(candidate?.primaryColor ?? '#4d92d1');
  const primaryColor = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#4d92d1';
  const fontFamily = validFonts.includes(candidate?.fontFamily) ? candidate.fontFamily : 'helvetica';
  const showPageNumber = Boolean(candidate?.showPageNumber);
  const footerText = String(candidate?.footerText ?? '').slice(0, 200);
  return { primaryColor, fontFamily, showPageNumber, footerText };
}

export function normalizeInvoiceTemplateLayoutJson(/** @type {any} */ rawValue) {
  const normalized = /** @type {Record<string, any>} */ (defaultInvoiceTemplateLayout());
  let source = /** @type {Record<string, any>} */ ({});

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

  const blockKeys = ['logo', 'practitioner', 'patient', 'invoiceMeta', 'lineItems', 'totals', 'payment', 'mentions', 'signature'];
  for (const key of blockKeys) {
    const candidate = source?.[key];
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const fallback = normalized[key];
    const style = normalizeInvoiceTemplateBlockStyle(candidate, fallback);
    const next = {
      x: clampInvoiceTemplateLayoutValue(candidate.x, 0, 96, fallback.x),
      y: clampInvoiceTemplateLayoutValue(candidate.y, 0, 96, fallback.y),
      w: clampInvoiceTemplateLayoutValue(candidate.w, 20, 96, fallback.w),
      ...style
    };

    if (next.x + next.w > 100) {
      next.x = Math.max(0, 100 - next.w);
    }

    normalized[key] = next;
  }

  if (source?._global && typeof source._global === 'object') {
    normalized._global = normalizeInvoiceTemplateGlobalSettings(source._global);
  }

  return JSON.stringify(normalized);
}

export function normalizeOfficeLetterTitle(/** @type {any} */ rawValue) {
  return String(rawValue ?? '').trim().slice(0, 200);
}

export function normalizeOfficeLetterContent(/** @type {any} */ rawValue) {
  return String(rawValue ?? '').trim().slice(0, 20000);
}

export function normalizeOfficeServiceTypesPayload(/** @type {any} */ rawServiceTypes) {
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
        id: id != null && Number.isInteger(id) && id > 0 ? id : null,
        label,
        amountHtCents: Math.max(0, Math.round((Number(item?.amountHt) || 0) * 100)),
        vatRate: Math.min(Math.max(Number(item?.vatRate) || 0, 0), 100),
        displayOrder: index + 1
      };
    })
    .filter(Boolean);
}

export function getDefaultOfficePaymentMethods() {
  return [
    { systemKey: 'cb', label: 'Carte bleu (CB)', displayOrder: 1 },
    { systemKey: 'especes', label: 'Espèces', displayOrder: 2 },
    { systemKey: 'cheque', label: 'Chèque', displayOrder: 3 }
  ];
}

export function inferPaymentMethodSystemKey(/** @type {any} */ rawLabel) {
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

export function normalizeOfficePaymentMethodsPayload(/** @type {any} */ rawPaymentMethods) {
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
        id: id != null && Number.isInteger(id) && id > 0 ? id : null,
        label,
        isActive: Boolean(item?.isActive),
        displayOrder: index + 1
      };
    })
    .filter(Boolean);
}

export function normalizeOfficeIds(/** @type {any} */ officeIds, fallbackOfficeId = null) {
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
