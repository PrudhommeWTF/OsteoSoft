/*
 * Extraction des données d'un rendez-vous depuis la fiche de détail
 * de Doctolib Pro (pro.doctolib.fr).
 *
 * Le DOM de Doctolib Pro est une SPA React utilisant un design system
 * "deprecated"/"oxygen". Les sélecteurs ci-dessous s'appuient en priorité
 * sur des attributs stables (`data-test-id`, `id` de champ de formulaire,
 * libellés visibles) et retombent sur des heuristiques textuelles lorsque
 * aucun attribut fiable n'est disponible.
 *
 * Ce fichier ne fait qu'extraire des données : aucun appel réseau ici.
 */
(function () {
  'use strict';

  const MONTHS_FR = {
    janvier: 1, 'janv.': 1, janv: 1,
    'février': 2, fevrier: 2, 'févr.': 2, 'fevr.': 2, 'févr': 2, fevr: 2,
    mars: 3,
    avril: 4, 'avr.': 4, avr: 4,
    mai: 5,
    juin: 6,
    juillet: 7, 'juil.': 7, juil: 7,
    'août': 8, aout: 8, 'aoû.': 8,
    septembre: 9, 'sept.': 9, sept: 9,
    octobre: 10, 'oct.': 10, oct: 10,
    novembre: 11, 'nov.': 11, nov: 11,
    'décembre': 12, decembre: 12, 'déc.': 12, 'dec.': 12, 'déc': 12, dec: 12
  };

  /** Texte nettoyé d'un noeud (espaces insécables inclus). */
  function cleanText(node) {
    if (!node) return '';
    return (node.textContent || '')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Doctolib affiche "Ajouter" comme lien pour les champs facultatifs vides. */
  function cleanPlaceholder(value) {
    const v = (value || '').trim();
    return /^(ajouter|non renseign)/i.test(v) ? '' : v;
  }

  /**
   * Retrouve la valeur associée à un libellé du bloc "Infos administratives"
   * (ex. "Lieu de naissance", "Tél (fixe)"). La structure est
   * <span>Libellé&nbsp;:&nbsp;</span><div>Valeur</div>.
   */
  function valueForLabel(labelPrefix) {
    const spans = document.querySelectorAll('span');
    const target = labelPrefix.toLowerCase();
    for (const span of spans) {
      const txt = cleanText(span).toLowerCase();
      if (txt.startsWith(target)) {
        const value = span.nextElementSibling;
        if (value) {
          const link = value.querySelector('a');
          return cleanText(link || value);
        }
      }
    }
    return '';
  }

  /** Numéro de téléphone : privilégie le href tel: (format normalisé). */
  function phoneFrom(testId, fallbackLabel) {
    const link = document.querySelector(`a[data-test-id="${testId}"]`);
    if (link) {
      const href = link.getAttribute('href') || '';
      const tel = href.replace(/^tel:/i, '').trim();
      if (tel) return tel;
      const txt = cleanText(link).replace(/\s+/g, '');
      if (txt) return txt;
    }
    return valueForLabel(fallbackLabel).replace(/\s+/g, '');
  }

  /** Identité : deux <h1> (NOM puis Prénom) précédant la ligne "H/F, jj/mm/aaaa". */
  function extractIdentity() {
    const result = { lastName: '', firstName: '', sex: '', birthDate: '' };

    // Ligne "H, 12/02/1966 (60 ans)" : sexe + date de naissance.
    const birthLine = Array.from(document.querySelectorAll('div,span'))
      .map((el) => ({ el, txt: cleanText(el) }))
      .find(({ txt }) => /^[HFX],?\s*\d{2}\/\d{2}\/\d{4}/.test(txt));

    if (birthLine) {
      const m = birthLine.txt.match(/^([HFX]),?\s*(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) {
        result.sex = m[1] === 'H' ? 'Homme' : m[1] === 'F' ? 'Femme' : 'Non renseigne';
        result.birthDate = `${m[4]}-${m[3]}-${m[2]}`; // ISO yyyy-mm-dd
      }
    }

    // Les deux <h1> de titre du panneau patient portent NOM et Prénom.
    const heads = Array.from(
      document.querySelectorAll('h1.dl-text-title, h1[data-design-system-component="Text"]')
    )
      .map((el) => cleanText(el))
      .filter((t) => t && t.length <= 80);

    if (heads.length >= 2) {
      result.lastName = heads[0];
      result.firstName = heads[1];
    } else if (heads.length === 1) {
      result.lastName = heads[0];
    }

    return result;
  }

  function extractCivility() {
    const chips = Array.from(document.querySelectorAll('span, div'));
    for (const el of chips) {
      const t = cleanText(el);
      if (t === 'Monsieur') return 'Monsieur';
      if (t === 'Madame') return 'Madame';
      if (t === 'Mademoiselle') return 'Mademoiselle';
    }
    return '';
  }

  /**
   * Créneau du rendez-vous en cours d'édition.
   * Champ "Horaire" : #appointment_start_date ("mardi 07 juillet 2026")
   * et #appointment_start_date_timepicker ("13:00").
   * Repli : premier élément de l'historique "à venir".
   */
  function extractSchedule() {
    const dateInput = document.querySelector('#appointment_start_date');
    const timeInput = document.querySelector('#appointment_start_date_timepicker');
    const dateVal = dateInput ? (dateInput.value || '').trim() : '';
    const timeVal = timeInput ? (timeInput.value || '').trim() : '';

    let iso = frLongDateToIso(dateVal, timeVal);
    let display = dateVal && timeVal ? `${dateVal} ${timeVal}` : dateVal;

    if (!iso) {
      // Repli sur l'historique "à venir" : "mar. 7 juil. 2026 13:00".
      const item = document.querySelector('[data-test-id="patient-history-list-item"]');
      if (item) {
        const line = cleanText(item.querySelector('.dl-text-bold') || item);
        const parsed = frShortDateTimeToIso(line);
        if (parsed) {
          iso = parsed;
          display = line;
        }
      }
    }

    return { startsAtIso: iso, startsAtDisplay: display };
  }

  /** "mardi 07 juillet 2026" + "13:00" -> "2026-07-07T13:00". */
  function frLongDateToIso(dateStr, timeStr) {
    if (!dateStr) return '';
    const cleaned = dateStr.replace(/ /g, ' ').toLowerCase();
    const m = cleaned.match(/(\d{1,2})\s+([a-zàâäéèêëîïôöûüç.]+)\s+(\d{4})/i);
    if (!m) return '';
    const day = parseInt(m[1], 10);
    const month = MONTHS_FR[m[2]];
    const year = parseInt(m[3], 10);
    if (!month) return '';
    const tm = (timeStr || '').match(/(\d{1,2})[:hH](\d{2})/);
    const hh = tm ? parseInt(tm[1], 10) : 0;
    const mm = tm ? parseInt(tm[2], 10) : 0;
    return toLocalIso(year, month, day, hh, mm);
  }

  /** "mar. 7 juil. 2026 13:00" -> "2026-07-07T13:00". */
  function frShortDateTimeToIso(str) {
    if (!str) return '';
    const cleaned = str.replace(/ /g, ' ').toLowerCase();
    const m = cleaned.match(/(\d{1,2})\s+([a-zàâäéèêëîïôöûüç.]+)\s+(\d{4})\s+(\d{1,2})[:hH](\d{2})/);
    if (!m) return '';
    const day = parseInt(m[1], 10);
    const month = MONTHS_FR[m[2]];
    const year = parseInt(m[3], 10);
    if (!month) return '';
    return toLocalIso(year, month, day, parseInt(m[4], 10), parseInt(m[5], 10));
  }

  function toLocalIso(y, mo, d, h, mi) {
    const p = (n) => String(n).padStart(2, '0');
    return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}`;
  }

  function extractMotive() {
    const input = document.querySelector('#appointment_visit_motive_id');
    if (input && input.value) return input.value.trim();
    // Repli : motif de l'historique "à venir".
    const item = document.querySelector('[data-test-id="patient-history-list-item"]');
    if (item) {
      const spans = item.querySelectorAll('span');
      if (spans.length) return cleanText(spans[spans.length - 1]);
    }
    return '';
  }

  /**
   * Indique si une fiche rendez-vous exploitable est présente à l'écran.
   * On se base sur le formulaire d'édition du rendez-vous.
   */
  function hasAppointmentPanel() {
    return Boolean(
      document.querySelector('#appointment_start_date') ||
        document.querySelector('[data-test-id="patient-history-list-item"]')
    );
  }

  /** Assemble l'objet rendez-vous complet à partir du DOM courant. */
  function scrapeAppointment() {
    const identity = extractIdentity();
    const schedule = extractSchedule();

    return {
      source: 'doctolib-pro',
      scrapedAt: new Date().toISOString(),
      pageUrl: location.href,
      patient: {
        civility: extractCivility(),
        lastName: identity.lastName,
        firstName: identity.firstName,
        sex: identity.sex,
        birthDate: identity.birthDate, // yyyy-mm-dd
        birthPlace: cleanPlaceholder(valueForLabel('lieu de naissance')),
        mobilePhone: phoneFrom('phone_number', 'tél (portable)'),
        landlinePhone: cleanPlaceholder(valueForLabel('tél (fixe)')).replace(/\s+/g, ''),
        email: (function () {
          const link = document.querySelector('a[data-test-id="email"]');
          if (link) {
            const href = link.getAttribute('href') || '';
            const mail = href.replace(/^mailto:/i, '').trim();
            if (mail) return mail;
          }
          return valueForLabel('e-mail');
        })()
      },
      appointment: {
        reason: extractMotive(),
        startsAtIso: schedule.startsAtIso,
        startsAtDisplay: schedule.startsAtDisplay
      }
    };
  }

  window.OsteoDoctolibScraper = {
    scrapeAppointment,
    hasAppointmentPanel
  };
})();
