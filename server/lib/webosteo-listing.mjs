// Import WebOsteo : exploitation de l'export « liste patients » (.xlsx).
//
// La base WebOsteo (.bck/.data) stocke les champs identifiants (nom, telephones,
// email, adresse, code postal, ville, n. securite sociale) sous une forme
// CHIFFREE, avec un nonce aleatoire par enregistrement : on ne peut pas les
// dechiffrer depuis la sauvegarde seule. En revanche, l'export « liste patients »
// de WebOsteo contient ces memes champs EN CLAIR (c'est WebOsteo qui les a
// dechiffres avec sa propre cle au moment de l'export).
//
// Ce module lit cet export et le rapproche des patients de la base, pour poser
// l'identite en clair sur chaque fiche. Le rapprochement se fait sur des champs
// presents en clair des deux cotes (prenom + date de naissance + sexe), puis se
// departage par la longueur des champs chiffres (le chiffrement produit 2 octets
// par octet UTF-8 du texte d'origine, donc longueur_chiffree / 2 = longueur du
// texte clair) et enfin par la date de creation.
//
// L'historique clinique (consultations, factures, rendez-vous, antecedents,
// documents) reste rattache par patient.id, independamment de ce rapprochement :
// ce module ne fait que fournir l'identite en clair.

/** Normalise un libelle d'en-tete (minuscules, sans accents, compacte). */
function normHeader(/** @type {any} */ v) {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cle de rapprochement, insensible a la casse et aux espaces. */
function norm(/** @type {any} */ v) {
  return String(v ?? '').trim().toLowerCase();
}

/** Convertit une date export (JJ/MM/AAAA) en AAAAMMJJ. '' si absente/invalide. */
export function listingDateToKey(/** @type {any} */ raw) {
  const m = String(raw ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}${m[2]}${m[1]}` : '';
}

/** Longueur en octets UTF-8 (unite du chiffrement WebOsteo). */
export function utf8Len(/** @type {any} */ v) {
  return Buffer.byteLength(String(v ?? ''), 'utf8');
}

// En-tetes export WebOsteo -> champ normalise. Cle = en-tete normalise.
const HEADER_TO_FIELD = new Map([
  ['nom', 'nom'],
  ['prenom', 'prenom'],
  ['sexe', 'sexe'],
  ['date de naissance', 'dob'],
  ['telephone portable', 'telephone1'],
  ['telephone fixe', 'telephone2'],
  ['adresse email', 'email'],
  ['adresse 1', 'adresse1'],
  ['adresse 2', 'adresse2'],
  ['code postal', 'code_postal'],
  ['ville', 'ville'],
  ['numero securite sociale', 'secu'],
  ['cree le', 'cree']
]);

/**
 * @typedef {object} ListingRecord
 * @property {string} nom
 * @property {string} prenom
 * @property {string} sexe
 * @property {string} dob AAAAMMJJ
 * @property {string} telephone1
 * @property {string} telephone2
 * @property {string} email
 * @property {string} adresse1
 * @property {string} adresse2
 * @property {string} code_postal
 * @property {string} ville
 * @property {string} secu
 * @property {string} cree AAAAMMJJ
 */

/**
 * Convertit des lignes brutes de feuille (tableaux de cellules) en enregistrements
 * normalises. Fonction PURE (pas de dependance a un lecteur xlsx), pour les tests.
 * @param {any[][]} rows Lignes de la feuille (row[0] = 1re cellule, etc.)
 * @returns {ListingRecord[]}
 */
export function normalizeListingRows(rows) {
  if (!Array.isArray(rows)) return [];
  // Trouver la ligne d'en-tete : celle qui contient a la fois « nom » et « prenom ».
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map(normHeader);
    if (cells.includes('nom') && cells.includes('prenom')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return [];

  // Colonne (index) -> champ.
  /** @type {Map<number, string>} */
  const colToField = new Map();
  (rows[headerIdx] || []).forEach((h, idx) => {
    const field = HEADER_TO_FIELD.get(normHeader(h));
    if (field) colToField.set(idx, field);
  });
  if (![...colToField.values()].includes('nom')) return [];

  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    /** @type {any} */
    const rec = { nom: '', prenom: '', sexe: '', dob: '', telephone1: '', telephone2: '', email: '', adresse1: '', adresse2: '', code_postal: '', ville: '', secu: '', cree: '' };
    for (const [idx, field] of colToField) {
      const cell = row[idx];
      rec[field] = cell == null ? '' : String(typeof cell === 'object' ? (cell.text ?? cell.result ?? '') : cell).trim();
    }
    if (!rec.nom) continue; // une ligne sans nom n'est pas exploitable
    rec.sexe = norm(rec.sexe);
    rec.dob = listingDateToKey(rec.dob);
    rec.cree = listingDateToKey(rec.cree);
    out.push(rec);
  }
  return out;
}

/**
 * @typedef {object} PatientDescriptor Champs EN CLAIR du patient WebOsteo + longueurs chiffrees.
 * @property {any} prenom
 * @property {any} sexe
 * @property {any} dob AAAAMMJJ (date_naissance WebOsteo)
 * @property {any} cree AAAAMMJJ (created WebOsteo)
 * @property {{ nom:number, tel:number, cp:number, ville:number, email:number }} encLen
 *   Longueurs des champs chiffres divisees par 2 (= longueur UTF-8 du clair).
 */

/**
 * Cree un rapprocheur a partir des enregistrements de l'export. Chaque ligne
 * n'est attribuee qu'a UN patient (1 pour 1). L'ordre d'appel est celui des
 * patients de la base.
 * @param {ListingRecord[]} records
 */
export function createListingMatcher(records) {
  /** @type {Map<string, ListingRecord[]>} */
  const byKey = new Map();
  for (const r of records) {
    const k = `${norm(r.prenom)}|${r.dob}|${norm(r.sexe)}`;
    const bucket = byKey.get(k);
    if (bucket) bucket.push(r); else byKey.set(k, [r]);
  }
  const used = new WeakSet();
  const stats = { total: records.length, matched: 0, unique: 0, byFingerprint: 0, byCreated: 0, ambiguous: 0, none: 0, lengthMismatch: 0 };

  /** Empreinte de longueurs d'un enregistrement export (octets UTF-8). */
  function fpOf(/** @type {ListingRecord} */ r) {
    return [utf8Len(r.nom), utf8Len(r.telephone1 || r.telephone2), utf8Len(r.code_postal), utf8Len(r.ville), utf8Len(r.email)].join(',');
  }
  /** Empreinte cote patient (longueurs chiffrees / 2). */
  function fpOfPatient(/** @type {PatientDescriptor} */ p) {
    return [p.encLen.nom, p.encLen.tel, p.encLen.cp, p.encLen.ville, p.encLen.email].join(',');
  }

  /**
   * @param {PatientDescriptor} p
   * @returns {(ListingRecord & { _confidence: 'high'|'medium'|'low' }) | null}
   */
  function match(p) {
    const k = `${norm(p.prenom)}|${String(p.dob ?? '').trim()}|${norm(p.sexe)}`;
    const all = byKey.get(k) || [];
    const cands = all.filter((r) => !used.has(r));
    if (all.length === 0) { stats.none++; return null; }
    if (cands.length === 0) { stats.ambiguous++; return null; }

    let pick = null;
    let confidence = 'high';
    if (cands.length === 1) {
      pick = cands[0];
      stats.unique++;
      if (utf8Len(pick.nom) !== p.encLen.nom) { stats.lengthMismatch++; confidence = 'low'; }
    } else {
      const wantFp = fpOfPatient(p);
      let m = cands.filter((r) => fpOf(r) === wantFp);
      if (m.length === 1) { pick = m[0]; stats.byFingerprint++; confidence = 'medium'; }
      else {
        const base = m.length ? m : cands;
        const m2 = base.filter((r) => r.cree && r.cree === String(p.cree ?? '').trim());
        if (m2.length === 1) { pick = m2[0]; stats.byCreated++; confidence = 'medium'; }
        else { stats.ambiguous++; return null; }
      }
    }
    used.add(pick);
    stats.matched++;
    return { ...pick, _confidence: /** @type {any} */ (confidence) };
  }

  return { match, stats };
}

/**
 * Lit un classeur .xlsx (export « liste patients » WebOsteo) et renvoie les
 * enregistrements normalises. Charge exceljs a la demande.
 * @param {Buffer} buffer
 * @returns {Promise<ListingRecord[]>}
 */
export async function parseListingWorkbook(buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(/** @type {any} */ (buffer));
  const ws = wb.worksheets[0];
  if (!ws) return [];
  /** @type {any[][]} */
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const arr = [];
    // row.values est 1-indexe (index 0 vide) : on retire la 1re case.
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const raw of vals) {
      const v = /** @type {any} */ (raw);
      arr.push(v == null ? '' : (typeof v === 'object' ? (v.text ?? v.result ?? '') : v));
    }
    rows.push(arr);
  });
  return normalizeListingRows(rows);
}
