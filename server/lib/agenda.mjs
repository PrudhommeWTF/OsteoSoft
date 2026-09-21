// Agenda : préférences d'affichage, calendriers accessibles et planification des
// rendez-vous (créneaux, chevauchements).
//
// Deux couches :
//  1. Fonctions PURES : normalisation des préférences d'agenda, couleur de
//     calendrier, minute d'ouverture et alignement d'une date sur un créneau.
//  2. Une fabrique createAgendaService(db, deps) qui ferme sur la base : lecture
//     et enregistrement des préférences, calendriers accessibles et par défaut,
//     et détection des chevauchements de rendez-vous (patient et cabinet).
//
// Extraction pure depuis server/index.mjs, comportement inchangé. Les routes HTTP
// restent dans index.mjs. Les fonctions transverses (cabinets de l'utilisateur,
// calendriers visibles, configuration) sont injectées.
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

/** @typedef {any} Db */

// Clés de jours d'ouverture, du lundi au dimanche (index ISO).
export const OFFICE_OPENING_DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function normalizeUserAgendaPreferences(/** @type {any} */ rawValue) {
  const source = rawValue && typeof rawValue === 'object' ? rawValue : {};

  const slotDurationMinutes = Number.isInteger(source.slotDurationMinutes)
    ? Math.min(Math.max(source.slotDurationMinutes, 5), 50)
    : 15;

  const displayHeight = Number.isInteger(source.displayHeight)
    ? Math.min(Math.max(source.displayHeight, 14), 35)
    : 14;

  const themeMode = ['system', 'light', 'dark'].includes(source.themeMode)
    ? source.themeMode
    : 'system';

  const pdfDisplayMode = ['browser', 'download'].includes(source.pdfDisplayMode)
    ? source.pdfDisplayMode
    : 'browser';

  const consultationOrder = ['Chronologique', 'Antichronologique'].includes(source.consultationOrder)
    ? source.consultationOrder
    : 'Antichronologique';

  const groupConsultationsByYearFrom = Number.isInteger(source.groupConsultationsByYearFrom)
    ? Math.min(Math.max(source.groupConsultationsByYearFrom, 0), 200)
    : 10;

  const patientAutoSaveFrequency = ['Jamais', 'Toutes les 2 minutes', 'Toutes les 5 minutes', 'Toutes les 10 minutes'].includes(source.patientAutoSaveFrequency)
    ? source.patientAutoSaveFrequency
    : 'Toutes les 2 minutes';

  const patientRemarksDisplay = ['hidden', 'edit', 'readonly'].includes(source.patientRemarksDisplay)
    ? source.patientRemarksDisplay
    : 'hidden';

  const appointmentColorMode = ['calendar', 'user'].includes(source.appointmentColorMode)
    ? source.appointmentColorMode
    : 'calendar';

  return {
    slotDurationMinutes,
    displayHeight,
    themeMode,
    pdfDisplayMode,
    consultationOrder,
    groupConsultationsByYearFrom,
    patientAutoSaveFrequency,
    showWeekend: Boolean(source.showWeekend),
    showPatientSex: Boolean(source.showPatientSex),
    showPatientMobilePhone: Boolean(source.showPatientMobilePhone),
    showPatientLandlinePhone: Boolean(source.showPatientLandlinePhone),
    showAppointmentComment: Boolean(source.showAppointmentComment),
    patientRemarksDisplay,
    appointmentColorMode
  };
}

export function getCalendarColorByIndex(/** @type {any} */ index) {
  const palette = ['#4d92d1', '#2d9d78', '#e67e22', '#8e44ad', '#c0392b', '#16a085', '#34495e', '#f39c12'];
  return palette[index % palette.length];
}

export function getFirstOpeningMinute(/** @type {any} */ openingHours, /** @type {any} */ date) {
  const dayKey = OFFICE_OPENING_DAY_KEYS[(date.getDay() + 6) % 7];
  const ranges = Array.isArray(openingHours?.[dayKey]) ? openingHours[dayKey] : [];
  if (!ranges.length) {
    return 9 * 60;
  }

  const start = String(ranges[0]?.start ?? '').trim();
  const [hoursRaw, minutesRaw] = start.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return 9 * 60;
  }
  return Math.min(Math.max((hours * 60) + minutes, 0), 23 * 60 + 59);
}

export function alignDateToOfficeSlot(/** @type {any} */ date, /** @type {any} */ firstOpeningMinute, /** @type {any} */ slotDurationMinutes) {
  const aligned = new Date(date);
  const targetMinutes = (aligned.getHours() * 60) + aligned.getMinutes();
  const boundedTarget = Math.max(targetMinutes, firstOpeningMinute);
  const offset = boundedTarget - firstOpeningMinute;
  const slotIndex = Math.floor(offset / slotDurationMinutes);
  const alignedMinutes = firstOpeningMinute + (slotIndex * slotDurationMinutes);

  aligned.setHours(Math.floor(alignedMinutes / 60), alignedMinutes % 60, 0, 0);
  return aligned;
}

/**
 * Crée les opérations d'agenda liées à la base.
 * @param {Db} db
 * @param {{
 *   getUserOfficeIds: (userId: any) => any[],
 *   parseVisibleUserIds: (raw: any) => any[],
 *   getConfigValue: (key: any, fallback?: any) => any,
 *   getConfigBoolean: (key: any, fallback?: any) => any,
 *   getConfigInteger: (key: any, fallback?: any) => any
 * }} deps
 */
export function createAgendaService(db, {
  getUserOfficeIds,
  parseVisibleUserIds,
  getConfigValue,
  getConfigBoolean,
  getConfigInteger
}) {
  function readUserAgendaPreferences(/** @type {any} */ userId) {
    const row = db
      .prepare(
            `SELECT slot_duration_minutes, display_height, theme_mode, pdf_display_mode,
              consultation_order, group_consultations_by_year_from, patient_auto_save_frequency,
                show_weekend, show_patient_sex, show_patient_mobile_phone,
                show_patient_landline_phone, show_appointment_comment,
                patient_remarks_display, appointment_color_mode
         FROM user_preference
         WHERE user_id = ?`
      )
      .get(userId);

    if (!row) {
      return {
        slotDurationMinutes: getConfigInteger('agenda_slot_duration_minutes', 15),
        displayHeight: getConfigInteger('agenda_display_height', 14),
        themeMode: getConfigValue('settings_theme_mode', 'system'),
        pdfDisplayMode: getConfigValue('settings_pdf_display_mode', 'browser'),
        consultationOrder: getConfigValue('settings_consultation_order', 'Antichronologique'),
        groupConsultationsByYearFrom: getConfigInteger('settings_group_consultations_by_year_from', 10),
        patientAutoSaveFrequency: getConfigValue('settings_patient_auto_save_frequency', 'Toutes les 2 minutes'),
        showWeekend: getConfigBoolean('agenda_show_weekend', false),
        showPatientSex: getConfigBoolean('agenda_show_patient_sex', true),
        showPatientMobilePhone: getConfigBoolean('agenda_show_patient_mobile_phone', true),
        showPatientLandlinePhone: getConfigBoolean('agenda_show_patient_landline_phone', false),
        showAppointmentComment: getConfigBoolean('agenda_show_appointment_comment', true),
        patientRemarksDisplay: getConfigValue('agenda_patient_remarks_display', 'hidden'),
        appointmentColorMode: getConfigValue('agenda_appointment_color_mode', 'calendar')
      };
    }

    return normalizeUserAgendaPreferences({
      slotDurationMinutes: Number(row.slot_duration_minutes),
      displayHeight: Number(row.display_height),
      themeMode: row.theme_mode,
      pdfDisplayMode: row.pdf_display_mode,
      consultationOrder: row.consultation_order,
      groupConsultationsByYearFrom: Number(row.group_consultations_by_year_from),
      patientAutoSaveFrequency: row.patient_auto_save_frequency,
      showWeekend: Number(row.show_weekend) === 1,
      showPatientSex: Number(row.show_patient_sex) === 1,
      showPatientMobilePhone: Number(row.show_patient_mobile_phone) === 1,
      showPatientLandlinePhone: Number(row.show_patient_landline_phone) === 1,
      showAppointmentComment: Number(row.show_appointment_comment) === 1,
      patientRemarksDisplay: row.patient_remarks_display,
      appointmentColorMode: row.appointment_color_mode
    });
  }

  function saveUserAgendaPreferences(/** @type {any} */ userId, /** @type {any} */ payload) {
    const preferences = normalizeUserAgendaPreferences(payload);

    db.prepare(
      `INSERT INTO user_preference (
        user_id,
        slot_duration_minutes,
        display_height,
        theme_mode,
        pdf_display_mode,
        consultation_order,
        group_consultations_by_year_from,
        patient_auto_save_frequency,
        show_weekend,
        show_patient_sex,
        show_patient_mobile_phone,
        show_patient_landline_phone,
        show_appointment_comment,
        patient_remarks_display,
        appointment_color_mode,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id)
      DO UPDATE SET
        slot_duration_minutes = excluded.slot_duration_minutes,
        display_height = excluded.display_height,
        theme_mode = excluded.theme_mode,
        pdf_display_mode = excluded.pdf_display_mode,
        consultation_order = excluded.consultation_order,
        group_consultations_by_year_from = excluded.group_consultations_by_year_from,
        patient_auto_save_frequency = excluded.patient_auto_save_frequency,
        show_weekend = excluded.show_weekend,
        show_patient_sex = excluded.show_patient_sex,
        show_patient_mobile_phone = excluded.show_patient_mobile_phone,
        show_patient_landline_phone = excluded.show_patient_landline_phone,
        show_appointment_comment = excluded.show_appointment_comment,
        patient_remarks_display = excluded.patient_remarks_display,
        appointment_color_mode = excluded.appointment_color_mode,
        updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      preferences.slotDurationMinutes,
      preferences.displayHeight,
      preferences.themeMode,
      preferences.pdfDisplayMode,
      preferences.consultationOrder,
      preferences.groupConsultationsByYearFrom,
      preferences.patientAutoSaveFrequency,
      preferences.showWeekend ? 1 : 0,
      preferences.showPatientSex ? 1 : 0,
      preferences.showPatientMobilePhone ? 1 : 0,
      preferences.showPatientLandlinePhone ? 1 : 0,
      preferences.showAppointmentComment ? 1 : 0,
      preferences.patientRemarksDisplay,
      preferences.appointmentColorMode
    );

    return readUserAgendaPreferences(userId);
  }

  function getAccessibleCalendarIdsForUser(/** @type {any} */ userId, officeIdFilter = null) {
    const userOfficeIds = new Set(getUserOfficeIds(userId));
    const filterOfficeId = Number(officeIdFilter);
    const hasOfficeFilter = Number.isInteger(filterOfficeId) && filterOfficeId > 0;

    const rows = db
      .prepare(
        `SELECT id, office_id, is_visible_to_all, visible_user_ids
         FROM local_calendars`
      )
      .all();

    const ids = [];
    for (const row of rows) {
      const calendarId = Number(row.id);
      if (!Number.isInteger(calendarId) || calendarId <= 0) {
        continue;
      }

      const calendarOfficeId = row.office_id != null ? Number(row.office_id) : null;
      if (!Number.isInteger(calendarOfficeId) || Number(calendarOfficeId) <= 0) {
        continue;
      }

      if (hasOfficeFilter && calendarOfficeId !== filterOfficeId) {
        continue;
      }

      if (calendarOfficeId != null && userOfficeIds.size > 0 && !userOfficeIds.has(calendarOfficeId)) {
        continue;
      }

      const isVisibleToAll = Number(row.is_visible_to_all) === 1;
      const visibleUserIds = parseVisibleUserIds(row.visible_user_ids);
      const visibleToUser = isVisibleToAll || visibleUserIds.includes(userId);
      if (!visibleToUser) {
        continue;
      }

      ids.push(calendarId);
    }

    return ids;
  }

  function getDefaultCalendarIdForUser(/** @type {any} */ userId) {
    const ids = getAccessibleCalendarIdsForUser(userId, null);
    return ids.length > 0 ? ids[0] : null;
  }

  function getDefaultCalendarForUser(/** @type {any} */ userId, officeIdFilter = null) {
    const accessibleCalendarIds = getAccessibleCalendarIdsForUser(userId, officeIdFilter);
    if (!accessibleCalendarIds.length) {
      return null;
    }

    const placeholders = accessibleCalendarIds.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT id, office_id
         FROM local_calendars
         WHERE id IN (${placeholders})
         ORDER BY display_order ASC, id ASC
         LIMIT 1`
      )
      .get(...accessibleCalendarIds);

    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      officeId: row.office_id != null ? Number(row.office_id) : null
    };
  }

  function findOverlappingAppointmentForPatient(/** @type {any} */ patientId, /** @type {any} */ localCalendarId, /** @type {any} */ startsAtIso, /** @type {any} */ durationMinutes) {
    const startDate = new Date(startsAtIso);
    if (Number.isNaN(startDate.getTime())) {
      return null;
    }
    const endDate = new Date(startDate.getTime() + (durationMinutes * 60 * 1000));

    const rows = db
      .prepare(
        `SELECT id, starts_at
         FROM appointments
         WHERE patient_id = ?
           AND ((local_calendar_id IS NULL AND ? IS NULL) OR local_calendar_id = ?)
         ORDER BY datetime(starts_at) ASC, id ASC`
      )
      .all(patientId, localCalendarId, localCalendarId);

    for (const row of rows) {
      const currentStart = new Date(row.starts_at);
      if (Number.isNaN(currentStart.getTime())) {
        continue;
      }
      const currentEnd = new Date(currentStart.getTime() + (durationMinutes * 60 * 1000));
      if (currentStart < endDate && currentEnd > startDate) {
        return Number(row.id);
      }
    }

    return null;
  }

  function findOverlappingAppointmentForOffice(/** @type {any} */ officeId, /** @type {any} */ localCalendarId, /** @type {any} */ startsAtIso, /** @type {any} */ durationMinutes) {
    const startDate = new Date(startsAtIso);
    if (Number.isNaN(startDate.getTime())) {
      return null;
    }
    const endDate = new Date(startDate.getTime() + (durationMinutes * 60 * 1000));

    let rows = [];
    if (Number.isInteger(officeId) && Number(officeId) > 0) {
      rows = db
        .prepare(
          `SELECT id, starts_at
           FROM appointments
           WHERE office_id = ?
           ORDER BY datetime(starts_at) ASC, id ASC`
        )
        .all(Number(officeId));
    } else if (Number.isInteger(localCalendarId) && Number(localCalendarId) > 0) {
      rows = db
        .prepare(
          `SELECT id, starts_at
           FROM appointments
           WHERE local_calendar_id = ?
           ORDER BY datetime(starts_at) ASC, id ASC`
        )
        .all(Number(localCalendarId));
    } else {
      return null;
    }

    for (const row of rows) {
      const currentStart = new Date(row.starts_at);
      if (Number.isNaN(currentStart.getTime())) {
        continue;
      }

      const currentEnd = new Date(currentStart.getTime() + (durationMinutes * 60 * 1000));
      if (currentStart < endDate && currentEnd > startDate) {
        return {
          id: Number(row.id),
          startsAt: String(row.starts_at)
        };
      }
    }

    return null;
  }

  return {
    readUserAgendaPreferences,
    saveUserAgendaPreferences,
    getAccessibleCalendarIdsForUser,
    getDefaultCalendarIdForUser,
    getDefaultCalendarForUser,
    findOverlappingAppointmentForPatient,
    findOverlappingAppointmentForOffice
  };
}
