/*
 * Point d'entrée du content script sur pro.doctolib.fr.
 *
 * Rôle :
 *   1. Créer un unique hôte Shadow DOM (isolation CSS totale).
 *   2. Afficher un bouton flottant "Ajouter à OsteoSoft" dès qu'une fiche
 *      rendez-vous exploitable est détectée dans le DOM (SPA React : le
 *      contenu change sans rechargement, d'où l'observateur de mutations).
 *   3. Au clic : extraire les données (scraper.js) puis ouvrir la modale de
 *      revue/confirmation (panel.js).
 */
(function () {
  'use strict';

  const scraper = window.OsteoDoctolibScraper;
  const panel = window.OsteoDoctolibPanel;
  if (!scraper || !panel) return;

  const HOST_ID = 'osteosoft-doctolib-root';
  let shadowRoot = null;
  let button = null;

  function ensureHost() {
    if (shadowRoot) return shadowRoot;

    const host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent =
      panel.styles() +
      `
      .os-fab {
        position: fixed; right: 22px; bottom: 22px; z-index: 2147483646;
        display: none; align-items: center; gap: 8px;
        padding: 12px 18px; border: 0; border-radius: 999px; cursor: pointer;
        background: #108a6a; color: #fff; font-size: 14px; font-weight: 600;
        font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        box-shadow: 0 8px 22px rgba(16,138,106,.4);
      }
      .os-fab:hover { background: #0d7458; }
      .os-fab.visible { display: inline-flex; }
      .os-fab .os-fab-plus { font-size: 17px; line-height: 1; }
    `;
    shadowRoot.appendChild(style);

    button = document.createElement('button');
    button.className = 'os-fab';
    button.innerHTML = '<span class="os-fab-plus">+</span><span>Ajouter à OsteoSoft</span>';
    button.title = 'Importer ce rendez-vous dans OsteoSoft';
    button.addEventListener('click', onImportClick);
    shadowRoot.appendChild(button);

    return shadowRoot;
  }

  function onImportClick() {
    try {
      const data = scraper.scrapeAppointment();
      if (!data.patient.lastName && !data.appointment.startsAtIso) {
        alert('OsteoSoft : impossible de lire les informations du rendez-vous sur cette page.');
        return;
      }
      panel.openModal(shadowRoot, data);
    } catch (err) {
      console.error('[OsteoSoft] Extraction échouée', err);
      alert('OsteoSoft : erreur lors de la lecture du rendez-vous.');
    }
  }

  function refreshButton() {
    ensureHost();
    const present = scraper.hasAppointmentPanel();
    button.classList.toggle('visible', present);
  }

  // La fiche apparaît/disparaît sans rechargement : on observe le DOM.
  const observer = new MutationObserver(() => {
    // Throttle léger via requestAnimationFrame pour éviter les rafales.
    if (refreshButton._scheduled) return;
    refreshButton._scheduled = true;
    requestAnimationFrame(() => {
      refreshButton._scheduled = false;
      refreshButton();
    });
  });

  function start() {
    ensureHost();
    refreshButton();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
