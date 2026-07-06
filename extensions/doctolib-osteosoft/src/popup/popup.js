'use strict';

const statusEl = document.getElementById('status');
const optionsBtn = document.getElementById('optionsBtn');

optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

function setStatus(kind, text) {
  statusEl.className = 'status ' + kind;
  statusEl.textContent = text;
}

chrome.runtime.sendMessage({ type: 'OSTEO_STATUS' }, (res) => {
  if (chrome.runtime.lastError || !res) {
    setStatus('err', 'Extension indisponible.');
    return;
  }
  if (res.ok && res.connected) {
    const uname = res.user && res.user.username ? ' (' + res.user.username + ')' : '';
    setStatus('ok', 'Connecté à OsteoSoft' + uname + '.');
  } else if (res.ok && !res.connected) {
    setStatus('warn', 'OsteoSoft joignable mais session non connectée. Connectez-vous dans OsteoSoft.');
  } else {
    setStatus('err', res.error || 'OsteoSoft injoignable. Vérifiez les paramètres.');
  }
});
