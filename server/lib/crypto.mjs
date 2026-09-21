// Chiffrement des champs sensibles au repos (AES-256-GCM).
//
// Premier module extrait de server/index.mjs (découpage, Priorité 2). Aucun
// changement de comportement : les fonctions sont identiques à l'original, la
// seule différence est que la clé est fournie par un getter, ce qui préserve la
// possibilité de la définir au runtime (assistant d'installation).

import crypto from 'node:crypto';

/**
 * Crée les primitives de chiffrement de champ, liées à une clé courante.
 *
 * @param {() => Buffer} getKey Retourne la clé AES-256 (Buffer de 32 octets)
 *   courante. Un getter (et non la clé elle-même) pour refléter une éventuelle
 *   redéfinition de la clé au runtime (setup).
 * @returns {{
 *   encryptSensitiveField: (plainText: string) => string,
 *   decryptSensitiveField: (cipherText: string) => string,
 *   safeDecryptField: (cipherText: unknown) => string,
 *   restoreCipherField: (value: unknown) => string
 * }}
 */
export function createFieldCrypto(getKey) {
  /**
   * Chiffre une chaîne. Renvoie base64(iv[12] + authTag[16] + ciphertext).
   * @param {string} plainText
   * @returns {string}
   */
  function encryptSensitiveField(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  /**
   * Déchiffre une valeur produite par encryptSensitiveField. Lève si la clé est
   * mauvaise ou la donnée altérée (tag GCM invalide).
   * @param {string} cipherText
   * @returns {string}
   */
  function decryptSensitiveField(cipherText) {
    const payload = Buffer.from(cipherText, 'base64');
    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
  }

  /**
   * Déchiffre en tolérant l'échec : renvoie la valeur telle quelle si elle n'est
   * pas déchiffrable (utile pour les champs historiquement en clair).
   * @param {unknown} cipherText
   * @returns {string}
   */
  function safeDecryptField(cipherText) {
    const text = String(cipherText ?? '');
    try {
      return decryptSensitiveField(text);
    } catch {
      return text;
    }
  }

  /**
   * Normalise vers du ciphertext (idempotent) : laisse intacte une valeur déjà
   * chiffrée, chiffre une valeur en clair. Utilisé par les migrations et le restore.
   * @param {unknown} value
   * @returns {string}
   */
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

  return { encryptSensitiveField, decryptSensitiveField, safeDecryptField, restoreCipherField };
}
