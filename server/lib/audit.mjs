// Journal d'audit inviolable (RGPD Art. 30).
//
// Chaîne à l'épreuve de l'altération : chaque ligne porte un HMAC sur ses champs
// IMMUABLES (action, entity, entity_id, created_at) plus le hash de la ligne
// précédente. Signé avec la clé serveur : toute altération (édition d'une ligne,
// suppression au milieu de la chaîne) est détectable et infalsifiable sans la clé.
// user_id et metadata sont volontairement exclus, car mutés légitimement ensuite
// (anonymisation du user_id, chiffrement rétroactif des PII en metadata).
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

import crypto from 'node:crypto';

/** @typedef {any} Db */

/**
 * Formate une ligne d'audit pour l'API. Fonction pure.
 * @param {any} row
 */
export function mapAuditLogRow(row) {
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

/**
 * Crée les primitives du journal d'audit liées à une base et une clé.
 * @param {Db} db
 * @param {() => Buffer} getKey Getter de la clé courante (redéfinissable au runtime).
 */
export function createAuditLog(db, getKey) {
  /**
   * @param {string} prevHash
   * @param {string} action
   * @param {string} entity
   * @param {string|null} entityId
   * @param {string} createdAt
   * @returns {string}
   */
  function computeAuditIntegrityHash(prevHash, action, entity, entityId, createdAt) {
    return crypto
      .createHmac('sha256', getKey())
      // Séparateur NUL (comme l'original) : il ne peut pas apparaître dans les
      // champs, ce qui évite toute ambiguïté d'assemblage avant le HMAC.
      .update([prevHash ?? '', action ?? '', entity ?? '', entityId ?? '', createdAt ?? ''].join('\0'))
      .digest('hex');
  }

  /**
   * Écrit une entrée d'audit, chaînée par HMAC à la précédente.
   * @param {number|null} userId
   * @param {string} action
   * @param {string} entity
   * @param {string|null} [entityId]
   * @param {Record<string, unknown>|null} [metadata]
   */
  function writeAuditLog(userId, action, entity, entityId, metadata = null) {
    const createdAt = new Date().toISOString();
    const prev = db
      .prepare('SELECT integrity_hash FROM audit_logs WHERE integrity_hash IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get();
    const integrityHash = computeAuditIntegrityHash(prev?.integrity_hash ?? '', action, entity, entityId ?? null, createdAt);
    db.prepare(
      'INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata, created_at, integrity_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId ?? null, action, entity, entityId ?? null, metadata ? JSON.stringify(metadata) : null, createdAt, integrityHash);
  }

  /**
   * Journalise un évènement de sécurité d'authentification (entrée d'audit SECURITY).
   * @param {any} req Requête Express.
   * @param {string} event
   * @param {Record<string, unknown>} [details]
   */
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

  /**
   * Vérifie la chaîne d'intégrité. Chaque ligne est contrôlée contre le hash
   * stocké de la précédente ; une rupture signale une édition ou une suppression.
   * @returns {{ checkedRows: number, brokenLinks: Array<{id: number, createdAt: string, action: string, entity: string}>, intact: boolean }}
   */
  function verifyAuditLogChain() {
    const rows = db
      .prepare(
        'SELECT id, action, entity, entity_id, created_at, integrity_hash FROM audit_logs WHERE integrity_hash IS NOT NULL ORDER BY id ASC'
      )
      .all();
    /** @type {Array<{id: number, createdAt: string, action: string, entity: string}>} */
    const brokenLinks = [];
    /** @type {string|null} */
    let prevHash = null;
    for (const row of rows) {
      if (prevHash !== null) {
        const expected = computeAuditIntegrityHash(prevHash, row.action, row.entity, row.entity_id ?? null, row.created_at);
        if (expected !== row.integrity_hash) {
          brokenLinks.push({ id: Number(row.id), createdAt: row.created_at, action: row.action, entity: row.entity });
        }
      }
      prevHash = row.integrity_hash;
    }
    return { checkedRows: rows.length, brokenLinks, intact: brokenLinks.length === 0 };
  }

  return { writeAuditLog, writeAuthSecurityLog, verifyAuditLogChain };
}
