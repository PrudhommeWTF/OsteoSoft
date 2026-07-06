'use strict';

const DEFAULT_BASE_URL = 'http://localhost:4199';

const baseUrlInput = document.getElementById('baseUrl');
const grantBtn = document.getElementById('grantBtn');
const testBtn = document.getElementById('testBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

function normalize(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function showStatus(kind, text) {
  statusEl.className = 'status show ' + kind;
  statusEl.textContent = text;
}

function originPattern(url) {
  return normalize(url) + '/*';
}

async function load() {
  const stored = await chrome.storage.sync.get('osteosoftBaseUrl');
  baseUrlInput.value = (stored && stored.osteosoftBaseUrl) || DEFAULT_BASE_URL;
}

async function save() {
  const url = normalize(baseUrlInput.value);
  if (!/^https?:\/\/.+/i.test(url)) {
    showStatus('err', 'URL invalide. Elle doit commencer par http:// ou https://');
    return;
  }
  await chrome.storage.sync.set({ osteosoftBaseUrl: url });
  const granted = await chrome.permissions.contains({ origins: [originPattern(url)] });
  if (granted) {
    showStatus('ok', 'Enregistré. L\'extension est autorisée à accéder à ' + url + '.');
  } else {
    showStatus('warn', 'Enregistré. Cliquez sur « Autoriser l\'accès à OsteoSoft » pour finaliser.');
  }
}

async function grant() {
  const url = normalize(baseUrlInput.value);
  if (!/^https?:\/\/.+/i.test(url)) {
    showStatus('err', 'Saisissez d\'abord une URL valide.');
    return;
  }
  try {
    const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
    if (granted) {
      await chrome.storage.sync.set({ osteosoftBaseUrl: url });
      showStatus('ok', 'Accès autorisé pour ' + url + '.');
    } else {
      showStatus('warn', 'Autorisation refusée. L\'import ne pourra pas contacter OsteoSoft.');
    }
  } catch (err) {
    showStatus('err', 'Erreur : ' + (err && err.message ? err.message : err));
  }
}

async function test() {
  const url = normalize(baseUrlInput.value);
  const granted = await chrome.permissions.contains({ origins: [originPattern(url)] });
  if (!granted) {
    showStatus('warn', 'Autorisez d\'abord l\'accès à OsteoSoft.');
    return;
  }
  showStatus('warn', 'Test en cours…');
  try {
    const res = await fetch(url + '/api/auth/me', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const uname = data && data.user && data.user.username ? ' — ' + data.user.username : '';
      showStatus('ok', 'Connexion OK' + uname + '.');
    } else if (res.status === 401) {
      showStatus('warn', 'OsteoSoft répond mais vous n\'êtes pas connecté. Ouvrez OsteoSoft et connectez-vous.');
    } else {
      showStatus('err', 'OsteoSoft a répondu avec le statut HTTP ' + res.status + '.');
    }
  } catch (err) {
    showStatus('err', 'OsteoSoft injoignable : ' + (err && err.message ? err.message : err));
  }
}

grantBtn.addEventListener('click', grant);
testBtn.addEventListener('click', test);
saveBtn.addEventListener('click', save);
load();
