/*
 * Interface de revue et de confirmation de l'import.
 *
 * Toute l'UI est rendue dans un Shadow DOM (isolation CSS totale vis-à-vis de
 * Doctolib). Les données extraites par scraper.js sont pré-remplies dans un
 * formulaire éditable ; l'ostéopathe peut :
 *   - vérifier / corriger les champs patient et rendez-vous,
 *   - lier le rendez-vous à un patient OsteoSoft existant (recherche),
 *   - créer un nouveau patient, ou créer un "patient rapide" (nom seul),
 *   - choisir le statut du rendez-vous, puis confirmer.
 *
 * Les échanges avec l'API OsteoSoft passent exclusivement par le service
 * worker (background.js) via chrome.runtime.sendMessage.
 */
(function () {
  'use strict';

  const APPOINTMENT_STATUSES = ['A confirmer', 'En attente', 'Termine'];

  function styles() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }

      .os-overlay {
        position: fixed; inset: 0; background: rgba(15, 23, 42, .45);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647;
      }
      .os-modal {
        width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px);
        overflow-y: auto; background: #fff; color: #1f2937; border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,.3); padding: 0;
      }
      .os-header {
        display: flex; align-items: center; gap: 10px;
        padding: 16px 20px; border-bottom: 1px solid #e5e7eb;
        position: sticky; top: 0; background: #fff; border-radius: 12px 12px 0 0;
      }
      .os-header .os-dot { width: 26px; height: 26px; border-radius: 7px; background: #108a6a; flex: 0 0 auto;
        display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; }
      .os-header h2 { font-size: 15px; margin: 0; font-weight: 600; flex: 1; }
      .os-close { border: 0; background: transparent; font-size: 22px; line-height: 1; cursor: pointer; color: #6b7280; }
      .os-body { padding: 16px 20px; }
      .os-status { font-size: 12px; padding: 8px 10px; border-radius: 8px; margin-bottom: 14px; }
      .os-status.ok { background: #ecfdf5; color: #065f46; }
      .os-status.warn { background: #fffbeb; color: #92400e; }
      .os-status.err { background: #fef2f2; color: #991b1b; }
      .os-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
        color: #6b7280; font-weight: 700; margin: 18px 0 8px; }
      .os-field { margin-bottom: 10px; }
      .os-row { display: flex; gap: 10px; }
      .os-row .os-field { flex: 1; }
      label.os-label { display: block; font-size: 12px; color: #374151; margin-bottom: 4px; font-weight: 500; }
      .os-input, .os-select {
        width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px;
        font-size: 13px; color: #111827; background: #fff;
      }
      .os-input:focus, .os-select:focus { outline: 2px solid #10a06a55; border-color: #108a6a; }
      .os-radio-group { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
      .os-radio { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; padding: 8px 10px;
        border: 1px solid #e5e7eb; border-radius: 8px; cursor: pointer; }
      .os-radio.selected { border-color: #108a6a; background: #f0fdf9; }
      .os-radio input { margin-top: 2px; }
      .os-radio .os-radio-sub { font-size: 12px; color: #6b7280; display: block; }
      .os-matches { margin: 8px 0 4px; }
      .os-match { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 8px;
        border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
      .os-match.selected { border-color: #108a6a; background: #f0fdf9; }
      .os-match .os-match-meta { font-size: 12px; color: #6b7280; }
      .os-hint { font-size: 12px; color: #6b7280; margin: 4px 0; }
      .os-footer { display: flex; gap: 10px; justify-content: flex-end;
        padding: 14px 20px; border-top: 1px solid #e5e7eb; position: sticky; bottom: 0; background: #fff; }
      .os-btn { padding: 9px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
      .os-btn-secondary { background: #fff; border-color: #d1d5db; color: #374151; }
      .os-btn-primary { background: #108a6a; color: #fff; }
      .os-btn-primary:disabled { background: #9ca3af; cursor: not-allowed; }
      .os-result { font-size: 13px; padding: 10px 12px; border-radius: 8px; margin-top: 12px; }
      .os-result.ok { background: #ecfdf5; color: #065f46; }
      .os-result.err { background: #fef2f2; color: #991b1b; }
      .os-spin { display: inline-block; width: 13px; height: 13px; border: 2px solid #ffffff80;
        border-top-color: #fff; border-radius: 50%; animation: os-rotate .7s linear infinite; vertical-align: -2px; margin-right: 6px; }
      @keyframes os-rotate { to { transform: rotate(360deg); } }
    `;
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'Réponse vide du service worker.' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v != null) node.setAttribute(k, v);
      }
    }
    for (const c of children || []) if (c) node.appendChild(c);
    return node;
  }

  function field(labelText, inputEl) {
    return el('div', { class: 'os-field' }, [
      el('label', { class: 'os-label', text: labelText }),
      inputEl
    ]);
  }

  function debounce(fn, delay) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }

  async function openModal(shadowRoot, data) {
    // Nettoie une éventuelle modale déjà ouverte.
    const existing = shadowRoot.querySelector('.os-overlay');
    if (existing) existing.remove();

    const patient = data.patient || {};
    const appt = data.appointment || {};

    // --- Champs patient éditables --------------------------------------
    const lastNameInput = el('input', { class: 'os-input', value: patient.lastName || '' });
    const firstNameInput = el('input', { class: 'os-input', value: patient.firstName || '' });
    const sexSelect = el('select', { class: 'os-select' }, ['Non renseigne', 'Femme', 'Homme'].map((s) =>
      el('option', { value: s, text: s, ...(patient.sex === s ? { selected: 'selected' } : {}) })
    ));
    const birthInput = el('input', { class: 'os-input', type: 'date', value: patient.birthDate || '' });
    const mobileInput = el('input', { class: 'os-input', value: patient.mobilePhone || '' });
    const emailInput = el('input', { class: 'os-input', value: patient.email || '' });

    // --- Champs rendez-vous --------------------------------------------
    const reasonInput = el('input', { class: 'os-input', value: appt.reason || '' });
    let dateVal = '';
    let timeVal = '';
    if (appt.startsAtIso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(appt.startsAtIso)) {
      dateVal = appt.startsAtIso.slice(0, 10);
      timeVal = appt.startsAtIso.slice(11, 16);
    }
    const dateInput = el('input', { class: 'os-input', type: 'date', value: dateVal });
    const timeInput = el('input', { class: 'os-input', type: 'time', value: timeVal });
    const statusSelect = el('select', { class: 'os-select' }, APPOINTMENT_STATUSES.map((s) =>
      el('option', { value: s, text: s, ...(s === 'A confirmer' ? { selected: 'selected' } : {}) })
    ));

    // --- Choix de liaison patient --------------------------------------
    const state = { mode: 'link', selectedPatientId: null, importing: false };

    const matchesBox = el('div', { class: 'os-matches' });
    const modeLink = buildRadio('link', 'Lier à un patient existant', 'Recherche dans OsteoSoft par nom.');
    const modeCreate = buildRadio('create', 'Créer un nouveau patient', 'Crée la fiche patient avec les infos ci-dessus.');
    const modeQuick = buildRadio('quick', 'Patient rapide (nom seulement)', 'Rendez-vous sans créer de fiche complète.');
    const radioGroup = el('div', { class: 'os-radio-group' }, [modeLink.wrap, matchesBox, modeCreate.wrap, modeQuick.wrap]);

    function buildRadio(value, title, sub) {
      const input = el('input', { type: 'radio', name: 'os-mode', value });
      const wrap = el('label', { class: 'os-radio' }, [
        input,
        el('span', {}, [
          el('span', { text: title }),
          el('span', { class: 'os-radio-sub', text: sub })
        ])
      ]);
      input.addEventListener('change', () => setMode(value));
      return { wrap, input };
    }

    function setMode(mode) {
      state.mode = mode;
      for (const r of [modeLink, modeCreate, modeQuick]) {
        const on = r.input.value === mode;
        r.input.checked = on;
        r.wrap.classList.toggle('selected', on);
      }
      matchesBox.style.display = mode === 'link' ? 'block' : 'none';
      updateImportButton();
    }

    function renderMatches(patients) {
      matchesBox.innerHTML = '';
      if (!patients || patients.length === 0) {
        matchesBox.appendChild(el('div', { class: 'os-hint', text: 'Aucun patient correspondant trouvé. Modifiez le nom, ou créez le patient.' }));
        state.selectedPatientId = null;
        updateImportButton();
        return;
      }
      for (const p of patients) {
        const row = el('div', { class: 'os-match' }, [
          el('input', { type: 'radio', name: 'os-match' }),
          el('span', {}, [
            el('span', { text: p.fullName }),
            el('span', { class: 'os-match-meta', text: ` — ${[p.sex, p.age ? p.age + ' ans' : '', p.city].filter(Boolean).join(', ')}` })
          ])
        ]);
        const radio = row.querySelector('input');
        row.addEventListener('click', () => {
          radio.checked = true;
          state.selectedPatientId = p.id;
          matchesBox.querySelectorAll('.os-match').forEach((m) => m.classList.remove('selected'));
          row.classList.add('selected');
          updateImportButton();
        });
        matchesBox.appendChild(row);
      }
    }

    const runSearch = debounce(async () => {
      const q = `${lastNameInput.value} ${firstNameInput.value}`.trim();
      if (q.length < 2) { renderMatches([]); return; }
      matchesBox.innerHTML = '';
      matchesBox.appendChild(el('div', { class: 'os-hint', text: 'Recherche…' }));
      const res = await send({ type: 'OSTEO_SEARCH_PATIENTS', query: q });
      if (!res.ok) {
        matchesBox.innerHTML = '';
        matchesBox.appendChild(el('div', { class: 'os-hint', text: 'Recherche impossible : ' + (res.error || 'erreur') }));
        return;
      }
      state.selectedPatientId = null;
      renderMatches(res.patients);
    }, 350);

    lastNameInput.addEventListener('input', () => { if (state.mode === 'link') runSearch(); });
    firstNameInput.addEventListener('input', () => { if (state.mode === 'link') runSearch(); });

    // --- Statut de connexion + boutons ---------------------------------
    const statusBar = el('div', { class: 'os-status warn', text: 'Vérification de la connexion à OsteoSoft…' });
    const resultBox = el('div', {});
    const importBtn = el('button', { class: 'os-btn os-btn-primary', text: 'Importer dans OsteoSoft' });
    const cancelBtn = el('button', { class: 'os-btn os-btn-secondary', text: 'Annuler' });

    function updateImportButton() {
      let ok = !state.importing && statusBar.classList.contains('ok');
      if (state.mode === 'link' && !state.selectedPatientId) ok = false;
      if (!lastNameInput.value.trim() || !firstNameInput.value.trim()) {
        if (state.mode !== 'quick' || !lastNameInput.value.trim()) ok = false;
      }
      if (!reasonInput.value.trim() || !dateInput.value || !timeInput.value) ok = false;
      importBtn.disabled = !ok;
    }

    [reasonInput, dateInput, timeInput, lastNameInput, firstNameInput].forEach((i) =>
      i.addEventListener('input', updateImportButton)
    );

    cancelBtn.addEventListener('click', () => overlay.remove());

    importBtn.addEventListener('click', async () => {
      state.importing = true;
      importBtn.disabled = true;
      importBtn.innerHTML = '<span class="os-spin"></span>Import en cours…';
      resultBox.innerHTML = '';

      const startsAtIso = dateInput.value && timeInput.value ? `${dateInput.value}T${timeInput.value}` : '';
      const payload = {
        mode: state.mode,
        patientId: state.mode === 'link' ? state.selectedPatientId : null,
        patient: {
          sex: sexSelect.value,
          lastName: lastNameInput.value.trim(),
          firstName: firstNameInput.value.trim(),
          birthDate: birthInput.value || '',
          mobilePhone: mobileInput.value.trim(),
          email: emailInput.value.trim()
        },
        appointment: {
          reason: reasonInput.value.trim(),
          startsAt: startsAtIso,
          status: statusSelect.value
        }
      };

      const res = await send({ type: 'OSTEO_IMPORT', payload });
      state.importing = false;
      importBtn.textContent = 'Importer dans OsteoSoft';

      if (res.ok) {
        resultBox.className = 'os-result ok';
        const who = res.patient && res.patient.fullName ? res.patient.fullName : payload.patient.lastName;
        resultBox.textContent = `✓ Rendez-vous importé pour ${who}${res.appointment && res.appointment.time ? ' à ' + res.appointment.time : ''}.`;
        cancelBtn.textContent = 'Fermer';
      } else {
        resultBox.className = 'os-result err';
        resultBox.textContent = '✗ ' + (res.error || 'Échec de l\'import.');
        updateImportButton();
      }
    });

    // --- Assemblage de la modale ---------------------------------------
    const modal = el('div', { class: 'os-modal' }, [
      el('div', { class: 'os-header' }, [
        el('div', { class: 'os-dot', text: '+' }),
        el('h2', { text: 'Importer le rendez-vous dans OsteoSoft' }),
        el('button', { class: 'os-close', text: '×', onclick: () => overlay.remove() })
      ]),
      el('div', { class: 'os-body' }, [
        statusBar,
        el('div', { class: 'os-section-title', text: 'Patient' }),
        el('div', { class: 'os-row' }, [field('Nom', lastNameInput), field('Prénom', firstNameInput)]),
        el('div', { class: 'os-row' }, [field('Sexe', sexSelect), field('Date de naissance', birthInput)]),
        el('div', { class: 'os-row' }, [field('Téléphone', mobileInput), field('E-mail', emailInput)]),
        el('div', { class: 'os-section-title', text: 'Liaison patient' }),
        radioGroup,
        el('div', { class: 'os-section-title', text: 'Rendez-vous' }),
        field('Motif de consultation', reasonInput),
        el('div', { class: 'os-row' }, [field('Date', dateInput), field('Heure', timeInput)]),
        field('Statut', statusSelect),
        resultBox
      ]),
      el('div', { class: 'os-footer' }, [cancelBtn, importBtn])
    ]);

    const overlay = el('div', { class: 'os-overlay' }, [modal]);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    shadowRoot.appendChild(overlay);

    setMode('link');
    updateImportButton();

    // Vérifie la connexion et lance la première recherche.
    const status = await send({ type: 'OSTEO_STATUS' });
    if (status.ok && status.connected) {
      statusBar.className = 'os-status ok';
      const uname = status.user && status.user.username ? status.user.username : '';
      statusBar.textContent = `Connecté à OsteoSoft (${status.baseUrl})${uname ? ' — ' + uname : ''}.`;
      runSearch();
    } else if (status.ok && !status.connected) {
      statusBar.className = 'os-status err';
      statusBar.textContent = `Non connecté à OsteoSoft (${status.baseUrl}). Ouvrez OsteoSoft et connectez-vous, puis réessayez.`;
    } else {
      statusBar.className = 'os-status err';
      statusBar.textContent = 'OsteoSoft injoignable : ' + (status.error || 'vérifiez l\'URL dans les options de l\'extension.');
    }
    updateImportButton();
  }

  window.OsteoDoctolibPanel = { openModal, styles };
})();
