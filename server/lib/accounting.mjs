// Comptabilité : agrégation du registre des opérations (factures, dépenses,
// dépôts) sur une période et un périmètre de cabinets, avec retrocessions et
// méta-données d'opération.
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Les routes HTTP
// (relevé, aperçus, prévisions, alertes, dépôts, dépenses, export) restent dans
// index.mjs et appellent getBillingOperationsData. Le déchiffrement de champs et
// les listes cabinets/praticiens sont injectés (issus du chiffrement et du module
// facturation).
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

/** @typedef {any} Db */

/**
 * Crée l'agrégation comptable liée à la base.
 * @param {Db} db
 * @param {{
 *   decryptSensitiveField: (v: any) => any,
 *   getBillingOfficeOptions: (officeIds: any) => any[],
 *   getBillingUsersForOfficeIds: (officeIds: any) => any[]
 * }} deps
 */
export function createAccountingService(db, { decryptSensitiveField, getBillingOfficeOptions, getBillingUsersForOfficeIds }) {
  /** @param {{ userId: any, access: any, fromIso: any, toIso: any, availableOfficeIds: any, filterOfficeIds: any, ownerUserId: any }} params */
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

  return { getBillingOperationsData };
}
