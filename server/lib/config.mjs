// Configuration serveur dérivée de l'environnement.
//
// Regroupe la lecture des variables d'environnement générales et les valeurs par
// défaut associées, hors configuration propre à un domaine (limites de
// sauvegarde, clé de chiffrement, origine CORS, dossier statique) qui restent
// avec leur domaine.
//
// loadServerConfig est PURE : elle prend l'environnement et le répertoire courant
// en paramètres (valeurs par défaut : process.env et process.cwd()), ce qui la
// rend testable sans variables globales. assertConfigUsable applique les gardes
// de sécurité au démarrage (refus de la clé JWT de développement en dehors du
// mode développement). Comportement identique à celui embarqué auparavant dans
// server/index.mjs.

import path from 'node:path';

// Valeur sentinelle de la clé JWT de développement : autorisée uniquement en mode
// développement, refusée partout ailleurs par assertConfigUsable.
export const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me';

// Constantes de session/transport, non dérivées de l'environnement.
export const SESSION_COOKIE_NAME = 'os_session';
export const CSRF_COOKIE_NAME = 'os_csrf';
export const SESSION_COOKIE_PATH = '/';

/**
 * Construit la configuration serveur à partir de l'environnement.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ cwd?: string }} [options]
 */
export function loadServerConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const dataDir = path.resolve(cwd, 'server/data');

  // Une clé JWT vide ou faite d'espaces est traitée comme absente : elle retombe
  // sur la sentinelle de développement (que la garde rejette ensuite) plutôt que
  // de signer silencieusement des jetons avec une clé vide.
  const jwtSecret = env.JWT_SECRET && env.JWT_SECRET.trim()
    ? env.JWT_SECRET
    : DEV_JWT_SECRET;

  return {
    port: Number(env.API_PORT ?? 4199),
    dataDir,
    dbPath: path.resolve(dataDir, 'osteo.db'),
    jwtSecret,
    isProduction: env.NODE_ENV === 'production',
    // Le mode développement doit être choisi EXPLICITEMENT. Toute autre valeur de
    // NODE_ENV, y compris absente, est traitée comme un déploiement réel : les
    // gardes ci-dessous se déclenchent sauf si NODE_ENV=development. On évite ainsi
    // de démarrer silencieusement une instance de production avec la clé publique.
    isDevelopment: env.NODE_ENV === 'development',
    allowRemoteSetup: /^(1|true|yes)$/i.test(String(env.ALLOW_REMOTE_SETUP ?? 'false')),
    requestBodyLimit: env.API_BODY_LIMIT ?? '5mb',
    largeRequestBodyLimit: env.API_LARGE_BODY_LIMIT ?? '200mb',
    maxPatientDocumentBytes: Number(env.MAX_PATIENT_DOCUMENT_BYTES ?? 15 * 1024 * 1024),
    trustedProxies: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1'
      ? 1
      : (env.TRUST_PROXY === 'loopback' ? 'loopback' : false),
    sessionRememberMaxAgeMs: Number(env.SESSION_REMEMBER_MAX_AGE_MS ?? 12 * 60 * 60 * 1000),
    sessionDefaultMaxAgeMs: Number(env.SESSION_DEFAULT_MAX_AGE_MS ?? 2 * 60 * 60 * 1000),
    sessionRememberTtl: env.SESSION_REMEMBER_TTL ?? '12h',
    sessionDefaultTtl: env.SESSION_DEFAULT_TTL ?? '2h',
    // Rétention du journal d'audit : 10 ans (3650 jours) par défaut, alignée sur la
    // rétention des données patient. Mettre 0 pour désactiver la purge automatique.
    auditLogRetentionDays: Number(env.AUDIT_LOG_RETENTION_DAYS ?? 3650),
    // Rétention des brouillons : un brouillon non modifié depuis 7 jours est
    // considéré comme orphelin et purgé.
    draftRetentionDays: Number(env.DRAFT_RETENTION_DAYS ?? 7)
  };
}

/**
 * Applique les gardes de sécurité au démarrage. Refuse de démarrer avec la clé
 * JWT publique de développement hors mode développement ; avertit si elle est
 * utilisée en développement. Comportement identique à l'ancienne version inline.
 *
 * @param {{ isDevelopment: boolean, jwtSecret: string }} config
 * @param {{ onWarn?: (message: string) => void }} [options]
 */
export function assertConfigUsable(config, { onWarn } = {}) {
  if (!config.isDevelopment && config.jwtSecret === DEV_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET must be set to a strong non-empty value unless NODE_ENV=development. ' +
      'Refusing to start with the public development secret.'
    );
  }

  if (config.isDevelopment && config.jwtSecret === DEV_JWT_SECRET) {
    onWarn?.('WARNING: Using development JWT secret. Set JWT_SECRET for safer local environments.');
  }
}
