// Mise a jour depuis l'interface : capacite de la machine, declencheur, statut.
//
// Le service (non privilegie) ne fait JAMAIS la mise a jour lui-meme : il depose
// un fichier declencheur dans son dossier de donnees, et une unite systemd
// `.path` executee en root (installee par deploy/lxc/install.sh) lance le script
// `osteosoft-self-update.sh`. Le service garde ainsi son durcissement systemd,
// sans sudo.
//
// Repris de Foyer-App (meme deploiement LXC), porte en JS/JSDoc.

import fs from 'node:fs';
import path from 'node:path';

/** Emplacement ou deploy/lxc/install.sh depose le script root. */
export const SELF_UPDATE_HELPER_DEFAULT = '/usr/local/sbin/osteosoft-self-update.sh';

/** Fichiers ecrits dans le dossier de donnees (seul dossier inscriptible du service). */
export const UPDATE_TRIGGER_FILE = '.update-trigger';
export const UPDATE_STATUS_FILE = 'update-status.json';
export const UPDATE_LOG_FILE = 'update.log';

/** Temps SANS PROGRESSION au-dela duquel une mise a jour est tenue pour interrompue. */
export const UPDATE_STALE_MS = 15 * 60 * 1000;

/**
 * Un tag de version, et rien d'autre.
 *
 * Le fichier declencheur est ecrit par le service NON PRIVILEGIE et lu EN ROOT :
 * ce filtre est la frontiere de privilege. Aucun caractere interpretable par le
 * shell (espace, point-virgule, slash, `$`...) ne peut y passer. Le script root
 * revalide de son cote avec la meme regle.
 */
const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function isValidReleaseTag(/** @type {any} */ tag) {
  return typeof tag === 'string' && tag.length <= 64 && RELEASE_TAG_RE.test(tag);
}

/**
 * @typedef {object} SelfUpdateCapability
 * @property {boolean} possible
 * @property {'disabled' | 'missing'} [reason]
 *   `disabled` : refusee explicitement sur cette machine (OSTEOSOFT_SELF_UPDATE=false) ;
 *   `missing`  : la machine n'a pas le dispositif (script root absent).
 * @property {string} helper Chemin reellement inspecte (pour le depannage).
 */

/**
 * Ce que la machine sait faire, CONSTATE et non declare : on regarde si le
 * script root est present. OSTEOSOFT_SELF_UPDATE ne sert que d'interrupteur
 * d'arret (une valeur fausse coupe le bouton meme si le script est la).
 * @param {{ refusal?: string, helper?: string }} [env]
 * @returns {SelfUpdateCapability}
 */
export function selfUpdateCapability(env = {}) {
  const helper = env.helper || SELF_UPDATE_HELPER_DEFAULT;
  const refusal = String(env.refusal ?? '').trim();
  if (refusal && /^(0|false|no|off)$/i.test(refusal)) {
    return { possible: false, reason: 'disabled', helper };
  }
  try {
    if (fs.statSync(helper).isFile()) return { possible: true, helper };
  } catch {
    // script absent
  }
  return { possible: false, reason: 'missing', helper };
}

/** « 22 minutes », « 3 heures », « 6 jours ». */
export function sinceLabel(/** @type {number} */ ms) {
  if (!Number.isFinite(ms)) return 'un long moment';
  const min = Math.round(ms / 60000);
  if (min < 120) return `${min} minute${min > 1 ? 's' : ''}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} heures`;
  return `${Math.round(h / 24)} jours`;
}

/**
 * @typedef {object} UpdateStatus
 * @property {string} state `idle` | `running` | `done` | `error`
 * @property {string} [message]
 * @property {number} [ts] Millisecondes, reecrites a chaque etape du script.
 */

/**
 * L'etat a servir a l'interface. Une mise a jour « running » qui ne progresse
 * plus (service redemarre, machine rebootee, unite jamais declenchee) laisserait
 * l'interface bloquee pour toujours : passe le delai, on la declare interrompue,
 * avec le chemin du journal.
 * @param {UpdateStatus} status
 * @param {number} now
 * @param {string} logPath
 * @param {number} [staleMs]
 * @returns {UpdateStatus}
 */
export function freshUpdateStatus(status, now, logPath, staleMs = UPDATE_STALE_MS) {
  if (status.state !== 'running') return status;
  const age = typeof status.ts === 'number' ? now - status.ts : Infinity;
  if (age <= staleMs) return status;
  return {
    state: 'error',
    message: `Mise à jour interrompue : aucune progression depuis ${sinceLabel(age)}. `
      + `Voir ${logPath}, puis relancez depuis l'application.`,
    ts: status.ts
  };
}

/**
 * Lit l'etat courant depuis le dossier de donnees (etat neutre si absent ou
 * illisible : un fichier corrompu ne doit pas bloquer l'interface).
 * @param {string} dataDir
 * @param {number} [now]
 * @returns {UpdateStatus}
 */
export function readUpdateStatus(dataDir, now = Date.now()) {
  const statusPath = path.join(dataDir, UPDATE_STATUS_FILE);
  try {
    if (fs.existsSync(statusPath)) {
      const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      if (parsed && typeof parsed.state === 'string') {
        return freshUpdateStatus(parsed, now, path.join(dataDir, UPDATE_LOG_FILE));
      }
    }
  } catch {
    // illisible : etat neutre
  }
  return { state: 'idle' };
}

/**
 * Depose le declencheur (lu par l'unite systemd root) et marque l'etat
 * « running ». Refuse tout ce qui n'est pas un tag de version valide.
 * @param {string} dataDir
 * @param {string} tag
 * @param {number} [now]
 */
export function writeUpdateTrigger(dataDir, tag, now = Date.now()) {
  if (!isValidReleaseTag(tag)) {
    throw new Error('Tag de version invalide.');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, UPDATE_STATUS_FILE),
    JSON.stringify({ state: 'running', message: `Mise à jour vers ${tag} lancée…`, ts: now })
  );
  fs.writeFileSync(path.join(dataDir, UPDATE_TRIGGER_FILE), `tag=${tag}\n`);
}
