// Releases GitHub : quelle version est proposee, et laquelle est la plus recente ?
//
// Deux canaux, parce que le depot publie les deux : les versions stables et les
// preversions (« pre-release ») qui les preparent. Le reglage du canal decide de
// ce que l'instance regarde. Contrainte d'API derriere ce choix :
// `/releases/latest` EXCLUT les preversions par construction (aucun parametre
// pour les inclure). Les voir impose de lister les releases et de choisir
// soi-meme la plus haute.
//
// La comparaison de versions porte donc aussi sur les preversions : sans cela,
// une instance en 1.3.0-rc.1 ne verrait jamais arriver 1.3.0-rc.2.
//
// Repris de Foyer-App (deploy LXC identique), porte en JS/JSDoc. Le fetch et la
// base de l'API sont injectables : les tests eprouvent le choix du canal sans
// appeler GitHub.

/** @typedef {'latest' | 'prerelease'} UpdateChannel */

/**
 * @typedef {object} Release
 * @property {string} tag
 * @property {string} name
 * @property {string} body
 * @property {string} url
 * @property {string} publishedAt
 * @property {boolean} prerelease Vrai pour une preversion (l'ecran le dit).
 */

export const GITHUB_API_DEFAULT = 'https://api.github.com';

/** Normalise une valeur de reglage en canal valide (stable par defaut). */
export function normalizeUpdateChannel(/** @type {any} */ value) {
  return value === 'prerelease' ? 'prerelease' : 'latest';
}

/** Un tag qui porte un suffixe de preversion, au sens semver : `v1.3.0-rc.1`. */
export function isPrereleaseTag(/** @type {string} */ tag) {
  return /^v?\d+(\.\d+)*-/.test(String(tag ?? '').trim());
}

/**
 * `1.3.0-rc.2` -> { num: [1,3,0], pre: ['rc','2'] }. Les metadonnees de build
 * (`+...`) ne comptent pas.
 * @param {string} v
 */
function splitVersion(v) {
  const s = String(v || '').trim().replace(/^v/, '').split('+')[0];
  const dash = s.indexOf('-');
  const core = dash < 0 ? s : s.slice(0, dash);
  const pre = dash < 0 ? [] : s.slice(dash + 1).split('.').filter(Boolean);
  const num = core.split('.').map((n) => parseInt(n, 10) || 0);
  return { num: [num[0] || 0, num[1] || 0, num[2] || 0], pre };
}

/**
 * Comparaison de deux versions, suffixe de preversion compris (semver 11).
 * Negatif si `a` precede `b`. Une preversion est ANTERIEURE a la version qu'elle
 * prepare (1.3.0-rc.1 < 1.3.0), et un identifiant numerique passe avant un
 * identifiant alphanumerique (rc.1 < rc.beta).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function semverCmp(a, b) {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.num[i] !== pb.num[i]) return pa.num[i] - pb.num[i];
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
      continue;
    }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** @param {any} j @returns {Release} */
function fromGithubJson(j) {
  return {
    tag: String(j.tag_name),
    name: j.name || String(j.tag_name),
    body: j.body || '',
    url: j.html_url || '',
    publishedAt: j.published_at || '',
    prerelease: Boolean(j.prerelease)
  };
}

/**
 * Le plus haut tag du depot, quand aucune release ne convient (depot qui pose
 * des tags sans publier de release). Le canal s'y applique aussi.
 * @param {string} base
 * @param {string} repo
 * @param {UpdateChannel} channel
 * @param {(url: string) => Promise<any>} get
 * @returns {Promise<Release>}
 */
async function highestTag(base, repo, channel, get) {
  const res = await get(`${base}/repos/${repo}/tags?per_page=100`);
  if (!res.ok) throw new Error(res.status === 404 ? 'aucune release ni tag' : `GitHub HTTP ${res.status}`);
  const tags = await res.json();
  const names = (Array.isArray(tags) ? tags : [])
    .map((/** @type {any} */ t) => String(t?.name || ''))
    .filter((n) => /^v?\d+\.\d+/.test(n))
    .filter((n) => channel === 'prerelease' || !isPrereleaseTag(n))
    .sort(semverCmp);
  const top = names[names.length - 1];
  if (!top) {
    throw new Error(channel === 'prerelease' ? 'aucune release ni tag de version' : 'aucune version stable publiee');
  }
  return {
    tag: top,
    name: top,
    body: '',
    url: `https://github.com/${repo}/releases/tag/${top}`,
    publishedAt: '',
    prerelease: isPrereleaseTag(top)
  };
}

/**
 * La version proposee par le canal demande.
 * @param {object} params
 * @param {string} params.repo `proprietaire/depot`
 * @param {UpdateChannel} params.channel
 * @param {Record<string, string>} [params.headers]
 * @param {string} [params.apiBase] Base de l'API (surchargee en test).
 * @param {typeof fetch} [params.doFetch]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<Release>}
 */
export async function fetchRelease({
  repo,
  channel,
  headers = {},
  apiBase = GITHUB_API_DEFAULT,
  doFetch = fetch,
  timeoutMs = 8000
}) {
  const base = String(apiBase).replace(/\/+$/, '');
  /** @param {string} url */
  const get = (url) => doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

  if (channel === 'prerelease') {
    const list = await get(`${base}/repos/${repo}/releases?per_page=30`);
    if (list.ok) {
      const raw = await list.json();
      // Un brouillon n'est publie pour personne : le proposer ferait echouer le
      // telechargement sans explication.
      const published = (Array.isArray(raw) ? raw : []).filter((/** @type {any} */ r) => r && !r.draft && r.tag_name);
      /** @type {any} */
      let top = null;
      for (const r of published) {
        if (!top || semverCmp(String(r.tag_name), String(top.tag_name)) > 0) top = r;
      }
      if (top) return fromGithubJson(top);
    } else if (list.status !== 404) {
      throw new Error(`GitHub HTTP ${list.status}`);
    }
  } else {
    const rel = await get(`${base}/repos/${repo}/releases/latest`);
    if (rel.ok) return fromGithubJson(await rel.json());
    if (rel.status !== 404) throw new Error(`GitHub HTTP ${rel.status}`);
  }
  return highestTag(base, repo, channel, get);
}
