// Facturation : cœur des factures et des paiements.
//
// Deux couches :
//  1. Fonctions PURES : identifiants d'opération, normalisation des méthodes de
//     paiement, plage de dates, normalisation des lignes et des paiements, et
//     calcul du statut d'une facture à partir de ses paiements.
//  2. Une fabrique createBillingService(db, deps) qui ferme sur la base et renvoie
//     les opérations liées à la base : détail d'une facture, ajout d'un paiement,
//     recalcul de l'état de paiement, et listes (praticiens, cabinets).
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Les routes HTTP
// restent dans index.mjs. Le chiffrement de champs et la lecture des méthodes de
// paiement d'un cabinet sont injectés (utilisés aussi ailleurs).
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

/** @typedef {any} Db */

/**
 * Décompose un format de numéro de facture en préfixe (période) et largeur du
 * compteur. Reproduit exactement les formats configurables côté cabinet.
 * Le préfixe encode la période (année, année-mois, ou année-mois-jour) ; le
 * numéro final est `${prefix}-${compteur zéro-paddé sur digits}`.
 * Fonction pure.
 * @param {any} format
 * @param {Date} date
 * @returns {{ prefix: string, digits: number }}
 */
export function buildInvoiceNumberParts(format, date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const value = String(format ?? '');

  if (value === 'AAAA-XXXXXX') {
    return { prefix: year, digits: 6 };
  }
  if (value === 'AAAAMM-XXXXXX') {
    return { prefix: `${year}${month}`, digits: 6 };
  }
  if (value === 'AAAAMMJJ-XXXXXX') {
    return { prefix: `${year}${month}${day}`, digits: 6 };
  }
  if (value === 'AAAAMM-XXXX : RAZ mensuelle (déconseillé)') {
    return { prefix: `${year}${month}`, digits: 4 };
  }
  if (value === 'AAAA-XXXX : RAZ annuel') {
    return { prefix: year, digits: 4 };
  }
  // Défaut : même comportement que le format par jour, 6 chiffres.
  return { prefix: `${year}${month}${day}`, digits: 6 };
}

/**
 * Formate un numéro de facture depuis un préfixe, une largeur et une valeur.
 * @param {string} prefix
 * @param {number} digits
 * @param {number} value
 * @returns {string}
 */
export function formatInvoiceNumber(prefix, digits, value) {
  return `${prefix}-${String(value).padStart(digits, '0')}`;
}

/**
 * Extrait la partie numérique (suffixe) d'un numéro de facture pour un préfixe
 * donné. Renvoie 0 si le numéro ne correspond pas au préfixe. Fonction pure.
 * @param {any} invoiceNumber
 * @param {string} prefix
 * @returns {number}
 */
export function parseInvoiceNumberSuffix(invoiceNumber, prefix) {
  const value = String(invoiceNumber ?? '');
  const expected = `${prefix}-`;
  if (!value.startsWith(expected)) {
    return 0;
  }
  const suffix = value.slice(expected.length);
  if (!/^\d+$/.test(suffix)) {
    return 0;
  }
  const parsed = Number(suffix);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function parseBillingOperationId(/** @type {any} */ rawValue) {
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

export function normalizeBillingPaymentMethod(/** @type {any} */ rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function billingPaymentMethodMatchesDepositType(/** @type {any} */ rawMethod, /** @type {any} */ depositType) {
  const method = normalizeBillingPaymentMethod(rawMethod);
  if (!method) {
    return false;
  }

  if (depositType === 'cheque') {
    return method.includes('cheq') || method.includes('chq');
  }

  return method.includes('espece') || method.includes('cash') || method.includes('liquide');
}

export function buildBillingDateRange(/** @type {any} */ fromRaw, /** @type {any} */ toRaw) {
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

export function normalizeInvoiceLineItems(/** @type {any} */ rawItems, /** @type {any} */ fallbackAmountCents) {
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

export function normalizeInvoicePayments(/** @type {any} */ rawPayments, /** @type {any} */ fallbackPaymentMethod, /** @type {any} */ fallbackCurrency, /** @type {any} */ amountCents, /** @type {any} */ issuedAt) {
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

export function computeInvoiceStatusFromPayments(/** @type {any} */ totalAmountCents, /** @type {any} */ payments, /** @type {any} */ requestedStatus) {
  const requested = String(requestedStatus ?? '').trim();
  const paidAmountCents = payments.reduce((/** @type {any} */ sum, /** @type {any} */ item) => sum + Number(item.amountCents ?? 0), 0);
  const effectiveTotal = Math.max(0, Math.round(Number(totalAmountCents ?? 0)));

  if (paidAmountCents <= 0) {
    return requested === 'annulee' ? 'annulee' : 'impayee';
  }
  if (paidAmountCents >= effectiveTotal) {
    return 'payee';
  }
  return 'partiellement_payee';
}

export function createBillingService(/** @type {Db} */ db, /** @type {{ encryptSensitiveField: (v: any) => any, decryptSensitiveField: (v: any) => any, safeDecryptField: (v: any) => any, readOfficePaymentMethods: (officeId: any) => any[] }} */ { encryptSensitiveField, decryptSensitiveField, safeDecryptField, readOfficePaymentMethods }) {
  /**
   * Attribue le prochain numéro de facture séquentiel pour un cabinet et une
   * période, de façon atomique. DOIT être appelée dans la transaction de
   * création. Le prochain compteur est le maximum entre la valeur enregistrée et
   * le plus grand suffixe déjà présent (garde-fou contre tout numéro non tracé,
   * par exemple importé), plus un. Le compteur est ensuite mis à jour et le
   * numéro produit est garanti non réutilisé pour ce cabinet et cette période.
   * @param {{ officeId: number, format: any, issuedAt: any }} params
   * @returns {string}
   */
  function allocateNextInvoiceNumber({ officeId, format, issuedAt }) {
    const date = new Date(String(issuedAt ?? ''));
    const effectiveDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const { prefix, digits } = buildInvoiceNumberParts(format, effectiveDate);

    const counterRow = db
      .prepare('SELECT last_value FROM invoice_number_sequences WHERE office_id = ? AND period_key = ?')
      .get(officeId, prefix);
    const counterValue = counterRow ? Number(counterRow.last_value) : 0;

    // Garde-fou : plus grand suffixe déjà utilisé pour ce cabinet et ce préfixe.
    const existing = db
      .prepare("SELECT invoice_number FROM invoices WHERE office_id = ? AND invoice_number LIKE ? || '-%'")
      .all(officeId, prefix);
    let maxExisting = 0;
    for (const row of existing) {
      const suffix = parseInvoiceNumberSuffix(row.invoice_number, prefix);
      if (suffix > maxExisting) {
        maxExisting = suffix;
      }
    }

    const nextValue = Math.max(counterValue, maxExisting) + 1;

    db.prepare(
      `INSERT INTO invoice_number_sequences (office_id, period_key, last_value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(office_id, period_key) DO UPDATE SET last_value = excluded.last_value, updated_at = excluded.updated_at`
    ).run(officeId, prefix, nextValue, new Date().toISOString());

    return formatInvoiceNumber(prefix, digits, nextValue);
  }

  function getInvoiceDetail(/** @type {any} */ invoiceId) {
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

    const paidAmountCents = payments.reduce((/** @type {any} */ sum, /** @type {any} */ item) => sum + Number(item.amount_cents ?? 0), 0);

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
      lineItems: lineItems.map((/** @type {any} */ item) => ({
        id: Number(item.id),
        label: String(item.label ?? '').trim(),
        quantity: Number(item.quantity ?? 0),
        unitAmountHtCents: Number(item.unit_amount_ht_cents ?? 0),
        vatRate: Number(item.vat_rate ?? 0),
        displayOrder: Number(item.display_order ?? 0)
      })),
      payments: payments.map((/** @type {any} */ item) => ({
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

  function appendInvoicePayment(/** @type {any} */ invoiceId, /** @type {any} */ payment, /** @type {any} */ createdBy) {
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

  function refreshInvoicePaymentState(/** @type {any} */ invoiceId) {
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
    ).all(invoiceId).map((/** @type {any} */ row) => ({
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
      paidAmountCents: payments.reduce((/** @type {any} */ sum, /** @type {any} */ item) => sum + Number(item.amountCents ?? 0), 0)
    };
  }

  function getBillingUsersForOfficeIds(/** @type {any} */ officeIds) {
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
      .map((/** @type {any} */ row) => {
        const firstName = String(row.first_name ?? '').trim();
        const lastName = String(row.last_name ?? '').trim();
        const displayName = `${lastName.toUpperCase()} ${firstName}`.trim() || String(row.username ?? '').trim();
        return {
          id: Number(row.id),
          displayName
        };
      });
  }

  function getBillingOfficeOptions(/** @type {any} */ officeIds) {
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
      .map((/** @type {any} */ row) => {
        const officeId = Number(row.id);
        const paymentMethods = readOfficePaymentMethods(officeId)
          .filter((/** @type {any} */ item) => item.isActive)
          .map((/** @type {any} */ item) => String(item.label ?? '').trim())
          .filter((/** @type {any} */ item) => item.length > 0);

        return {
          id: officeId,
          name: String(row.name ?? '').trim(),
          paymentMethods: [...new Set(paymentMethods)]
        };
      });
  }

  return {
    allocateNextInvoiceNumber,
    getInvoiceDetail,
    appendInvoicePayment,
    refreshInvoicePaymentState,
    getBillingUsersForOfficeIds,
    getBillingOfficeOptions
  };
}
