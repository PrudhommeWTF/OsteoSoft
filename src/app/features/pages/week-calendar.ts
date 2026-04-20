import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { AgendaSettings, DashboardEvent, LocalAgendaCalendar, Practitioner } from '../../core/api.types';

type ConsultationConflictCandidate = {
  id: number;
  title: string;
  practitioner: string;
  startedAt: string;
};

interface CalendarDay {
  date: Date;
  dateStr: string;
  shortLabel: string;
  longLabel: string;
  dayNum: number;
  isToday: boolean;
}

interface PositionedEvent {
  event: DashboardEvent;
  top: number;
  height: number;
  borderColor: string;
  bgColor: string;
  title: string;
  timeLabel: string;
  patientLabel: string;
  patientColorClass: string | null;
  sexIconClass: string | null;
  sexColorClass: string | null;
  leftStyle: string;
  widthStyle: string;
}

interface CalendarDayData extends CalendarDay {
  positionedEvents: PositionedEvent[];
}

interface MonthEventChip {
  event: DashboardEvent;
  title: string;
  timeLabel: string;
  borderColor: string;
  bgColor: string;
  patientLabel: string;
  patientColorClass: string | null;
  sexIconClass: string | null;
  sexColorClass: string | null;
}

interface MonthDayCell extends CalendarDay {
  inCurrentMonth: boolean;
  events: MonthEventChip[];
}

@Component({
  selector: 'app-week-calendar',
  standalone: true,
  templateUrl: './week-calendar.html',
  styleUrl: './week-calendar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class WeekCalendar {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly events = input<DashboardEvent[]>([]);
  readonly settings = input.required<AgendaSettings>();
  readonly selectedCalendars = input<LocalAgendaCalendar[]>([]);
  readonly visibleEventsChange = output<DashboardEvent[]>();

  readonly viewMode = signal<'month' | 'week' | 'three-days' | 'day'>('week');
  readonly referenceDate = signal<Date>(new Date());
  readonly selectedEvent = signal<DashboardEvent | null>(null);
  readonly selectedEventColor = signal<string>('#4d92d1');
  readonly practitioners = signal<Practitioner[]>([]);
  readonly isPractitionersLoading = signal(false);
  readonly isSavingConsultationMeta = signal(false);
  readonly consultationMetaError = signal('');
  readonly consultationMetaSuccess = signal('');
  readonly consultationTitleDraft = signal('');
  readonly consultationPractitionerDraft = signal('');
  readonly isConsultationConflictModalOpen = signal(false);
  readonly consultationConflictCandidate = signal<ConsultationConflictCandidate | null>(null);

  readonly isMonthView = computed((): boolean => this.viewMode() === 'month');

  readonly weekdayLabels = computed((): string[] => {
    const base = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    return this.settings().showWeekend ? base : base.slice(0, 5);
  });

  readonly timeSlots = computed((): string[] => {
    const s = this.settings();
    const result: string[] = [];
    const startMin = (s.dayStartHour ?? 8) * 60;
    const endMin = (s.dayEndHour ?? 20) * 60;
    for (let m = startMin; m < endMin; m += s.slotDurationMinutes) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      result.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
    }
    return result;
  });

  readonly timeSlotsWithLunch = computed(
    (): Array<{ time: string; isLunch: boolean; isFullHour: boolean; hourLabel: string }> => {
      const s = this.settings();
      const lunchStartMin = s.lunchStartHour * 60;
      const lunchEndMin = s.lunchEndHour * 60;
      return this.timeSlots().map((time) => {
        const [h, m] = time.split(':').map(Number);
        const timeMin = h * 60 + m;
        const isFullHour = m === 0;
        return {
          time,
          isLunch: timeMin >= lunchStartMin && timeMin < lunchEndMin,
          isFullHour,
          hourLabel: isFullHour ? `${h}h` : ''
        };
      });
    }
  );

  readonly totalHeight = computed((): number => {
    return this.timeSlots().length * this.settings().displayHeight;
  });

  readonly calendarData = computed((): CalendarDayData[] => {
    const s = this.settings();
    const ref = this.referenceDate();
    const mode = this.viewMode();
    const todayStr = this.toDateStr(new Date());
    const events = this.events();
    const slots = this.timeSlots();
    const totalH = this.totalHeight();

    const selectedCals = this.selectedCalendars();
    const days = this.buildVisibleDays(ref, mode, s, todayStr);
    return days.map((day) => ({
      ...day,
      positionedEvents: this.buildTimedEvents(day, events, s, totalH, selectedCals)
    }));
  });

  readonly monthGrid = computed((): MonthDayCell[][] => {
    if (!this.isMonthView()) {
      return [];
    }

    const ref = this.referenceDate();
    const s = this.settings();
    const todayStr = this.toDateStr(new Date());
    const events = this.events();

    const firstDay = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const firstDow = firstDay.getDay();
    const diffToMonday = firstDow === 0 ? -6 : 1 - firstDow;
    const gridStart = new Date(firstDay);
    gridStart.setDate(firstDay.getDate() + diffToMonday);

    const rows: MonthDayCell[][] = [];
    for (let week = 0; week < 6; week += 1) {
      const row: MonthDayCell[] = [];
      const dayCount = s.showWeekend ? 7 : 5;
      for (let col = 0; col < dayCount; col += 1) {
        const offset = week * 7 + col;
        const d = new Date(gridStart);
        d.setDate(gridStart.getDate() + offset);

        const baseDay = this.buildDay(d, todayStr);
        row.push({
          ...baseDay,
          inCurrentMonth: d.getMonth() === ref.getMonth(),
          events: this.buildMonthEvents(baseDay, events, s)
        });
      }
      rows.push(row);
    }

    return rows;
  });

  readonly calendarTitle = computed((): string => {
    if (this.isMonthView()) {
      const title = new Intl.DateTimeFormat('fr-FR', {
        month: 'long',
        year: 'numeric'
      }).format(this.referenceDate());
      return title.charAt(0).toUpperCase() + title.slice(1);
    }

    const data = this.calendarData();
    if (data.length === 0) return '';

    if (data.length === 1) {
      const title = new Intl.DateTimeFormat('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }).format(data[0].date);
      return title.charAt(0).toUpperCase() + title.slice(1);
    }

    const first = data[0].date;
    const last = data[data.length - 1].date;
    const fmtDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
    const fmtDayYear = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

    if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) {
      return `${first.getDate()} – ${fmtDayYear.format(last)}`;
    }
    return `${fmtDay.format(first)} – ${fmtDayYear.format(last)}`;
  });

  readonly visibleEvents = computed((): DashboardEvent[] => {
    if (this.isMonthView()) {
      return this.monthGrid()
        .flatMap((row) => row)
        .flatMap((day) => day.events.map((chip) => chip.event))
        .sort((a, b) => a.start.localeCompare(b.start));
    }

    return this.calendarData()
      .flatMap((day) => day.positionedEvents.map((positioned) => positioned.event))
      .sort((a, b) => a.start.localeCompare(b.start));
  });

  constructor() {
    effect(() => {
      this.visibleEventsChange.emit(this.visibleEvents());
    });
  }

  goToPrev(): void {
    const d = new Date(this.referenceDate());
    if (this.viewMode() === 'month') {
      d.setMonth(d.getMonth() - 1);
    } else {
      d.setDate(d.getDate() - (this.viewMode() === 'day' ? 1 : this.viewMode() === 'three-days' ? 3 : 7));
    }
    this.referenceDate.set(d);
  }

  goToNext(): void {
    const d = new Date(this.referenceDate());
    if (this.viewMode() === 'month') {
      d.setMonth(d.getMonth() + 1);
    } else {
      d.setDate(d.getDate() + (this.viewMode() === 'day' ? 1 : this.viewMode() === 'three-days' ? 3 : 7));
    }
    this.referenceDate.set(d);
  }

  goToToday(): void {
    this.referenceDate.set(new Date());
  }

  openAppointmentModal(event: DashboardEvent): void {
    const s = this.settings();
    const { borderColor } = this.resolveEventColors(event, s, this.selectedCalendars());
    this.selectedEventColor.set(borderColor);
    this.consultationMetaError.set('');
    this.consultationMetaSuccess.set('');
    this.consultationTitleDraft.set(String(event.consultationTitle ?? '').trim());
    this.consultationPractitionerDraft.set(String(event.consultationPractitioner ?? '').trim());
    this.selectedEvent.set(event);
    void this.ensurePractitionersLoaded();
  }

  closeAppointmentModal(): void {
    this.selectedEvent.set(null);
    this.consultationMetaError.set('');
    this.consultationMetaSuccess.set('');
    this.closeConsultationConflictModal();
  }

  closeConsultationConflictModal(): void {
    this.isConsultationConflictModalOpen.set(false);
    this.consultationConflictCandidate.set(null);
  }

  async openPatientRecord(): Promise<void> {
    const event = this.selectedEvent();
    if (!event) {
      return;
    }

    let patientId = Number(event.patientId);
    if (!Number.isInteger(patientId) || patientId <= 0) {
      try {
        patientId = await this.api.getPatientIdByAppointment(event.id);
      } catch {
        this.consultationMetaError.set('Impossible d\'ouvrir la fiche patient pour ce rendez-vous.');
        return;
      }
    }

    this.closeAppointmentModal();
    await this.router.navigate(['/patients', patientId]);
  }

  async openConsultationRecord(): Promise<void> {
    const event = this.selectedEvent();
    if (!event) {
      return;
    }

    if (!Number.isInteger(event.consultationId) || Number(event.consultationId) <= 0) {
      this.consultationMetaError.set('Aucune consultation liée à ce rendez-vous.');
      return;
    }

    let patientId = Number(event.patientId);
    if (!Number.isInteger(patientId) || patientId <= 0) {
      try {
        patientId = await this.api.getPatientIdByAppointment(event.id);
      } catch {
        this.consultationMetaError.set('Impossible d\'ouvrir la consultation liée.');
        return;
      }
    }

    const consultationId = Number(event.consultationId);
    this.closeAppointmentModal();
    await this.router.navigate(['/patients', patientId], {
      queryParams: { consultationId }
    });
  }

  saveButtonLabel(): string {
    return this.isSavingConsultationMeta() ? 'Enregistrement...' : 'Enregistrer';
  }

  setConsultationTitleDraft(value: string): void {
    this.consultationMetaError.set('');
    this.consultationMetaSuccess.set('');
    this.consultationTitleDraft.set(value);
  }

  setConsultationPractitionerDraft(value: string): void {
    this.consultationMetaError.set('');
    this.consultationMetaSuccess.set('');
    this.consultationPractitionerDraft.set(value.trim());
  }

  async saveConsultationMeta(linkStrategy?: 'attach-existing' | 'create-new'): Promise<void> {
    const event = this.selectedEvent();
    if (!event || this.isSavingConsultationMeta()) {
      return;
    }

    this.consultationMetaError.set('');
    this.consultationMetaSuccess.set('');
    this.isSavingConsultationMeta.set(true);

    try {
      const consultation = await this.api.updateAppointmentConsultationMeta(event.id, {
        title: this.consultationTitleDraft().trim(),
        practitioner: this.consultationPractitionerDraft().trim(),
        linkStrategy
      });

      this.selectedEvent.set({
        ...event,
        consultationId: consultation.id,
        consultationTitle: consultation.title,
        consultationPractitioner: consultation.practitioner
      });
      this.closeConsultationConflictModal();
      this.consultationMetaSuccess.set('Consultation mise à jour.');
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 403) {
          this.consultationMetaError.set('Droit insuffisant pour enregistrer la consultation.');
        } else if (error.status === 404) {
          this.consultationMetaError.set('Rendez-vous introuvable.');
        } else if (error.status === 409) {
          const existing = error.error?.conflict?.existingConsultation;
          if (existing && Number.isInteger(Number(existing.id)) && Number(existing.id) > 0) {
            this.consultationConflictCandidate.set({
              id: Number(existing.id),
              title: String(existing.title ?? '').trim(),
              practitioner: String(existing.practitioner ?? '').trim(),
              startedAt: String(existing.startedAt ?? '')
            });
            this.isConsultationConflictModalOpen.set(true);
            this.consultationMetaError.set('Un rendez-vous similaire existe deja. Choisissez une action.');
          } else {
            this.consultationMetaError.set('Conflit detecte sur la liaison consultation/rendez-vous.');
          }
        } else {
          this.consultationMetaError.set('Impossible d\'enregistrer la consultation.');
        }
      } else {
        this.consultationMetaError.set('Impossible d\'enregistrer la consultation.');
      }
    } finally {
      this.isSavingConsultationMeta.set(false);
    }
  }

  formatConflictConsultationDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  resolveConsultationConflict(attachExisting: boolean): void {
    if (!this.isConsultationConflictModalOpen()) {
      return;
    }

    void this.saveConsultationMeta(attachExisting ? 'attach-existing' : 'create-new');
  }

  getSexIcon(sex: DashboardEvent['patientSex']): string | null {
    if (sex === 'Femme') return 'fa-solid fa-venus';
    if (sex === 'Homme') return 'fa-solid fa-mars';
    return null;
  }

  getSexColorClass(sex: DashboardEvent['patientSex']): string | null {
    if (sex === 'Femme') return 'text-danger';
    if (sex === 'Homme') return 'text-primary';
    return null;
  }

  getEventDetailItems(event: DashboardEvent): Array<{ label: string; value: string }> {
    const s = this.settings();
    const items: Array<{ label: string; value: string }> = [];

    if (event.consultationTitle.trim()) {
      items.push({ label: 'Titre de la consultation', value: event.consultationTitle.trim() });
    }

    if (event.consultationPractitioner.trim()) {
      items.push({ label: 'Praticien', value: event.consultationPractitioner.trim() });
    }

    if (s.autoConsultationType && event.consultationType) {
      items.push({ label: 'Type de consultation', value: event.consultationType });
    }

    if (s.showPatientMobilePhone && event.patientMobilePhone) {
      items.push({ label: 'Téléphone portable', value: event.patientMobilePhone });
    }

    if (s.showPatientLandlinePhone && event.patientLandlinePhone) {
      items.push({ label: 'Téléphone fixe', value: event.patientLandlinePhone });
    }

    if (s.showAppointmentComment && event.appointmentComment) {
      items.push({ label: 'Commentaire RDV', value: event.appointmentComment });
    }

    if (s.patientRemarksDisplay !== 'hidden' && event.patientRemarks) {
      const label = s.patientRemarksDisplay === 'readonly' ? 'Remarque patient' : 'Remarque patient (éditable)';
      items.push({ label, value: event.patientRemarks });
    }

    return items;
  }

  formatEventDateTime(start: string): string {
    const d = new Date(start);
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  }

  private buildVisibleDays(ref: Date, mode: 'month' | 'week' | 'three-days' | 'day', s: AgendaSettings, todayStr: string): CalendarDay[] {
    if (mode === 'month') {
      return [];
    }

    if (mode === 'day') {
      return [this.buildDay(ref, todayStr)];
    }

    if (mode === 'three-days') {
      return Array.from({ length: 3 }, (_, i) => {
        const d = new Date(ref);
        d.setDate(ref.getDate() + i);
        return this.buildDay(d, todayStr);
      }).filter((day) => s.showWeekend || ![0, 6].includes(day.date.getDay()));
    }

    const dow = ref.getDay();
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(ref);
    monday.setDate(ref.getDate() + diffToMonday);

    const count = s.showWeekend ? 7 : 5;
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return this.buildDay(d, todayStr);
    });
  }

  private buildDay(date: Date, todayStr: string): CalendarDay {
    const dateStr = this.toDateStr(date);
    const shortLabel = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' }).format(date);
    const longLabel = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' }).format(date);
    return { date, dateStr, shortLabel, longLabel, dayNum: date.getDate(), isToday: dateStr === todayStr };
  }

  private buildTimedEvents(
    day: CalendarDay,
    events: DashboardEvent[],
    s: AgendaSettings,
    totalHeight: number,
    selectedCals: LocalAgendaCalendar[]
  ): PositionedEvent[] {
    const startMin = (s.dayStartHour ?? 8) * 60;
    const totalMin = ((s.dayEndHour ?? 20) - (s.dayStartHour ?? 8)) * 60;
    const slotH = s.displayHeight;

    const dayEvents = events
      .filter((e) => e.start.startsWith(day.dateStr))
      .map((event) => {
        const startDate = new Date(event.start);
        const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
        const endMinutes = startMinutes + Math.max(5, s.defaultSessionDurationMinutes);
        return { event, startDate, startMinutes, endMinutes };
      })
      .sort((a, b) => (a.startMinutes - b.startMinutes) || (a.endMinutes - b.endMinutes));

    const layout = new Map<number, { column: number; columnsCount: number }>();
    let cluster: Array<{ id: number; startMinutes: number; endMinutes: number }> = [];
    let clusterEnd = -1;

    const flushCluster = (): void => {
      if (cluster.length === 0) {
        return;
      }

      const sorted = [...cluster].sort((a, b) => (a.startMinutes - b.startMinutes) || (a.endMinutes - b.endMinutes));
      const columnEndMinutes: number[] = [];
      const assigned: Array<{ id: number; column: number }> = [];
      let maxColumns = 1;

      for (const item of sorted) {
        let column = columnEndMinutes.findIndex((endValue) => item.startMinutes >= endValue);
        if (column < 0) {
          column = columnEndMinutes.length;
          columnEndMinutes.push(item.endMinutes);
        } else {
          columnEndMinutes[column] = item.endMinutes;
        }

        maxColumns = Math.max(maxColumns, column + 1);
        assigned.push({ id: item.id, column });
      }

      for (const item of assigned) {
        layout.set(item.id, { column: item.column, columnsCount: maxColumns });
      }

      cluster = [];
      clusterEnd = -1;
    };

    for (const item of dayEvents) {
      if (cluster.length === 0) {
        cluster.push({ id: item.event.id, startMinutes: item.startMinutes, endMinutes: item.endMinutes });
        clusterEnd = item.endMinutes;
        continue;
      }

      if (item.startMinutes < clusterEnd) {
        cluster.push({ id: item.event.id, startMinutes: item.startMinutes, endMinutes: item.endMinutes });
        clusterEnd = Math.max(clusterEnd, item.endMinutes);
      } else {
        flushCluster();
        cluster.push({ id: item.event.id, startMinutes: item.startMinutes, endMinutes: item.endMinutes });
        clusterEnd = item.endMinutes;
      }
    }

    flushCluster();

    return dayEvents.map(({ event, startDate, startMinutes, endMinutes }) => {
      const clampedStart = Math.max(startMinutes, startMin);
      const clampedEnd = Math.min(endMinutes, startMin + totalMin);
      const top = ((clampedStart - startMin) / totalMin) * totalHeight;
      const eventDurationMinutes = Math.max(5, clampedEnd - clampedStart);
      const height = Math.max((eventDurationMinutes / totalMin) * totalHeight, slotH);

      const { borderColor, bgColor } = this.resolveEventColors(event, s, selectedCals);
      const sexIconClass = s.showPatientSex ? this.getSexIcon(event.patientSex) : null;
      const sexColorClass = s.showPatientSex ? this.getSexColorClass(event.patientSex) : null;
      const patientColorClass = this.getSexColorClass(event.patientSex);

      const timeLabel = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;
      const position = layout.get(event.id) ?? { column: 0, columnsCount: 1 };
      const leftPct = (position.column * 100) / position.columnsCount;
      const widthPct = 100 / position.columnsCount;

      return {
        event,
        top,
        height,
        borderColor,
        bgColor,
        title: this.buildTitle(event),
        timeLabel,
        patientLabel: event.patient,
        patientColorClass,
        sexIconClass,
        sexColorClass,
        leftStyle: `calc(${leftPct}% + 2px)`,
        widthStyle: `calc(${widthPct}% - 4px)`
      };
    });
  }

  private buildMonthEvents(day: CalendarDay, events: DashboardEvent[], s: AgendaSettings): MonthEventChip[] {
    const selectedCals = this.selectedCalendars();
    return events
      .filter((e) => e.start.startsWith(day.dateStr))
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((e) => {
        const d = new Date(e.start);
        const timeLabel = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const { borderColor, bgColor } = this.resolveEventColors(e, s, selectedCals);
        const sexIconClass = s.showPatientSex ? this.getSexIcon(e.patientSex) : null;
        const sexColorClass = s.showPatientSex ? this.getSexColorClass(e.patientSex) : null;
        const patientColorClass = this.getSexColorClass(e.patientSex);
        return {
          event: e,
          title: this.buildTitle(e),
          timeLabel,
          borderColor,
          bgColor,
          patientLabel: e.patient,
          patientColorClass,
          sexIconClass,
          sexColorClass
        };
      });
  }

  private resolveEventColors(
    e: DashboardEvent,
    s: AgendaSettings,
    selectedCals: LocalAgendaCalendar[]
  ): { borderColor: string; bgColor: string } {
    let raw: string;
    if (selectedCals.length > 0) {
      const cal = selectedCals.find((c) => c.id === e.calendarId);
      raw = cal?.colorHex ?? '#4d92d1';
    } else {
      raw = s.appointmentColorMode === 'user' ? (e.practitionerColor ?? '#4d92d1') : (e.calendarColor ?? '#4d92d1');
    }
    const borderColor = /^#[0-9a-f]{6}$/i.test(raw) ? raw : '#4d92d1';
    return { borderColor, bgColor: `${borderColor}26` };
  }

  private buildTitle(e: DashboardEvent): string {
    return e.patient;
  }

  private async ensurePractitionersLoaded(): Promise<void> {
    if (this.practitioners().length > 0 || this.isPractitionersLoading()) {
      return;
    }

    this.isPractitionersLoading.set(true);
    try {
      const practitioners = await this.api.getPractitioners();
      this.practitioners.set(practitioners);

      if (!this.consultationPractitionerDraft().trim()) {
        const first = practitioners[0]?.username ?? '';
        this.consultationPractitionerDraft.set(first);
      }
    } catch {
      this.practitioners.set([]);
    } finally {
      this.isPractitionersLoading.set(false);
    }
  }

  private toDateStr(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}
