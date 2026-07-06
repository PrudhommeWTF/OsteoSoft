/*
 * Service worker (MV3) — client de l'API OsteoSoft.
 *
 * Les appels réseau vers OsteoSoft sont centralisés ici plutôt que dans le
 * content script pour deux raisons :
 *   - les requêtes émises depuis le service worker d'une extension disposant
 *     d'une host permission sur l'origine cible ne sont pas soumises au CORS
 *     de la page Doctolib ;
 *   - le jeton CSRF (cookie `os_csrf`, non httpOnly) est lu via chrome.cookies
 *     et renvoyé dans l'en-tête `x-csrf-token`, comme l'exige l'API.
 *
 * L'authentification réutilise la session existante : l'ostéopathe doit être
 * connecté à OsteoSoft dans le même navigateur (cookie de session `os_session`
 * envoyé automatiquement grâce à credentials: 'include').
 */

const SESSION_COOKIE = 'os_session';
const CSRF_COOKIE = 'os_csrf';
const DEFAULT_BASE_URL = 'http://localhost:4199';

async function getBaseUrl() {
  const stored = await chrome.storage.sync.get('osteosoftBaseUrl');
  const raw = (stored && stored.osteosoftBaseUrl) || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, '');
}

async function hasHostPermission(baseUrl) {
  try {
    return await chrome.permissions.contains({ origins: [baseUrl + '/*'] });
  } catch {
    return false;
  }
}

async function getCsrfToken(baseUrl) {
  try {
    const cookie = await chrome.cookies.get({ url: baseUrl + '/', name: CSRF_COOKIE });
    return cookie ? cookie.value : '';
  } catch {
    return '';
  }
}

/** Requête générique vers l'API OsteoSoft. Retourne { status, ok, data }. */
async function apiRequest(baseUrl, path, { method = 'GET', body = null } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    const csrf = await getCsrfToken(baseUrl);
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const response = await fetch(baseUrl + path, {
    method,
    credentials: 'include',
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { status: response.status, ok: response.ok, data };
}

function apiErrorMessage(result, fallback) {
  const d = result && result.data;
  if (d) {
    if (typeof d.message === 'string') return d.message;
    if (typeof d.error === 'string') return d.error;
  }
  if (result && result.status) return `${fallback} (HTTP ${result.status})`;
  return fallback;
}

async function ensureReady() {
  const baseUrl = await getBaseUrl();
  if (!(await hasHostPermission(baseUrl))) {
    return {
      baseUrl,
      error:
        `Autorisation manquante pour ${baseUrl}. Ouvrez les options de l'extension ` +
        `et cliquez sur « Autoriser l'accès à OsteoSoft ».`
    };
  }
  return { baseUrl, error: null };
}

// --- Handlers -------------------------------------------------------------

async function handleStatus() {
  const { baseUrl, error } = await ensureReady();
  if (error) return { ok: false, baseUrl, error };
  try {
    const me = await apiRequest(baseUrl, '/api/auth/me');
    if (me.ok && me.data && me.data.user) {
      return { ok: true, baseUrl, connected: true, user: me.data.user };
    }
    return { ok: true, baseUrl, connected: false };
  } catch (err) {
    return { ok: false, baseUrl, error: describeNetworkError(err, baseUrl) };
  }
}

async function handleSearchPatients(query) {
  const { baseUrl, error } = await ensureReady();
  if (error) return { ok: false, error };
  try {
    const res = await apiRequest(baseUrl, '/api/patients?search=' + encodeURIComponent(query));
    if (!res.ok) return { ok: false, error: apiErrorMessage(res, 'Recherche impossible') };
    return { ok: true, patients: (res.data && res.data.patients) || [] };
  } catch (err) {
    return { ok: false, error: describeNetworkError(err, baseUrl) };
  }
}

async function handleImport(payload) {
  const { baseUrl, error } = await ensureReady();
  if (error) return { ok: false, error };

  const mode = payload.mode;
  const p = payload.patient || {};
  const a = payload.appointment || {};

  if (!a.reason || !a.startsAt) {
    return { ok: false, error: 'Motif ou horaire du rendez-vous manquant.' };
  }

  try {
    let patientId = null;
    let patientFullName = `${p.lastName || ''} ${p.firstName || ''}`.trim();

    if (mode === 'link') {
      if (!payload.patientId) return { ok: false, error: 'Aucun patient sélectionné.' };
      patientId = payload.patientId;
    } else if (mode === 'create') {
      if (!p.lastName || !p.firstName) {
        return { ok: false, error: 'Nom et prénom requis pour créer un patient.' };
      }
      const created = await apiRequest(baseUrl, '/api/patients', {
        method: 'POST',
        body: {
          sex: p.sex || 'Non renseigne',
          lastName: p.lastName,
          firstName: p.firstName,
          birthDate: p.birthDate || '',
          mobilePhone: p.mobilePhone || '',
          email: p.email || ''
        }
      });
      if (!created.ok || !created.data || !created.data.patient) {
        return { ok: false, error: apiErrorMessage(created, 'Création du patient impossible') };
      }
      patientId = created.data.patient.id;
      patientFullName = created.data.patient.fullName || patientFullName;
    } else if (mode === 'quick') {
      if (!p.lastName) return { ok: false, error: 'Nom du patient requis.' };
    } else {
      return { ok: false, error: 'Mode d\'import inconnu.' };
    }

    const apptBody = {
      reason: a.reason,
      startsAt: a.startsAt,
      status: a.status || 'A confirmer'
    };
    if (patientId) {
      apptBody.patientId = patientId;
    } else {
      apptBody.patientLastName = p.lastName || '';
      apptBody.patientFirstName = p.firstName || '';
    }

    const appt = await apiRequest(baseUrl, '/api/appointments', { method: 'POST', body: apptBody });
    if (!appt.ok || !appt.data || !appt.data.appointment) {
      return { ok: false, error: apiErrorMessage(appt, 'Création du rendez-vous impossible') };
    }

    return {
      ok: true,
      patient: { id: patientId, fullName: patientFullName },
      appointment: appt.data.appointment
    };
  } catch (err) {
    return { ok: false, error: describeNetworkError(err, baseUrl) };
  }
}

function describeNetworkError(err, baseUrl) {
  const msg = String(err && err.message ? err.message : err);
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(msg)) {
    return `OsteoSoft injoignable à ${baseUrl}. Vérifiez que l'application est démarrée et l'URL configurée.`;
  }
  return msg;
}

// --- Routage des messages -------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message && message.type) {
        case 'OSTEO_STATUS':
          sendResponse(await handleStatus());
          break;
        case 'OSTEO_SEARCH_PATIENTS':
          sendResponse(await handleSearchPatients(message.query || ''));
          break;
        case 'OSTEO_IMPORT':
          sendResponse(await handleImport(message.payload || {}));
          break;
        default:
          sendResponse({ ok: false, error: 'Message inconnu.' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // réponse asynchrone
});
