import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { AgendaSettings, Appointment, DashboardEvent, LocalAgendaCalendar, OfficeOption, Patient } from '../../core/api.types';
import { WeekCalendar } from './week-calendar';

@Component({
  selector: 'app-agenda-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, WeekCalendar],
  templateUrl: './agenda.page.html',
  styleUrl: './pages.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AgendaPage {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);
  private readonly fb = inject(FormBuilder);

  readonly stats = signal([
    { label: 'Consultations du jour', value: '0' },
    { label: 'Nouveaux patients', value: '0' },
    { label: 'Taux de remplissage', value: '0%' }
  ]);

  readonly appointments = signal<Appointment[]>([]);
  readonly officeOptions = signal<OfficeOption[]>([]);
  readonly selectedOfficeId = signal<number | null>(null);
  readonly events = signal<DashboardEvent[]>([]);
  readonly agendaSettings = signal<AgendaSettings | null>(null);
  readonly visibleEvents = signal<DashboardEvent[]>([]);
  readonly localCalendars = signal<LocalAgendaCalendar[]>([]);
  readonly selectedCalendarIds = signal<number[]>([]);

  readonly selectedCalendars = computed((): LocalAgendaCalendar[] => {
    const ids = this.selectedCalendarIds();
    return this.localCalendars().filter((c) => c.id !== null && ids.includes(c.id as number));
  });

  readonly filteredEvents = computed((): DashboardEvent[] => {
    const ids = this.selectedCalendarIds();
    if (ids.length === 0) return this.events();
    return this.events().filter((e) => e.calendarId !== null && ids.includes(e.calendarId));
  });

  readonly canExportAgenda = computed(() => this.authService.hasPermission('export-agenda'));

  readonly isCreateModalOpen = signal(false);
  readonly isExportModalOpen = signal(false);
  readonly isExportingAgenda = signal(false);
  readonly exportAgendaError = signal('');
  readonly patients = signal<Patient[]>([]);
  readonly isLoadingPatients = signal(false);
  readonly isCreatingAppointment = signal(false);
  readonly createAppointmentError = signal('');
  readonly createAppointmentSuccess = signal('');

  readonly createAppointmentForm = this.fb.nonNullable.group({
    patientId: [0, [Validators.required, Validators.min(1)]],
    startsAt: ['', [Validators.required]],
    reason: ['', [Validators.required]],
    status: ['A confirmer' as const, [Validators.required]]
  });

  constructor() {
    this.load();
  }

  async onSelectedOfficeChange(value: string): Promise<void> {
    const parsed = Number(value);
    this.selectedOfficeId.set(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
    await this.load();
  }

  private async load(): Promise<void> {
    const me = await this.api.me();
    const offices = Array.isArray(me.offices) ? me.offices : [];
    this.officeOptions.set(offices);

    const hasCurrentOffice = offices.some((office) => office.id === this.selectedOfficeId());
    if (!hasCurrentOffice) {
      const activeOfficeId = this.authService.activeOfficeId();
      const hasActiveOffice = Number.isInteger(activeOfficeId) && offices.some((office) => office.id === activeOfficeId);
      this.selectedOfficeId.set(hasActiveOffice ? activeOfficeId : (offices[0]?.id ?? null));
    }

    const officeId = this.selectedOfficeId();
    const [appointmentsPayload, dashboardPayload] = await Promise.all([
      this.api.getAppointments(officeId),
      this.api.getDashboard(officeId)
    ]);

    this.appointments.set(appointmentsPayload.appointments);
    this.stats.set([
      { label: 'Consultations du jour', value: String(appointmentsPayload.stats.consultationsToday) },
      { label: 'Nouveaux patients', value: String(appointmentsPayload.stats.newPatients) },
      { label: 'Taux de remplissage', value: appointmentsPayload.stats.occupancyRate }
    ]);

    // Update calendar state
    this.events.set(dashboardPayload.events);
    this.visibleEvents.set(dashboardPayload.events);
    this.agendaSettings.set(dashboardPayload.agendaSettings);

    const calendars = Array.isArray(dashboardPayload.localCalendars) ? dashboardPayload.localCalendars : [];
    this.localCalendars.set(calendars);
    // Initialize selection with all calendars (only if not already set)
    if (this.selectedCalendarIds().length === 0) {
      this.selectedCalendarIds.set(calendars.map((c) => c.id as number).filter((id) => id !== null));
    }
  }

  onVisibleEventsChange(events: DashboardEvent[]): void {
    this.visibleEvents.set(events);
  }

  toggleCalendar(id: number): void {
    const current = this.selectedCalendarIds();
    if (current.includes(id)) {
      this.selectedCalendarIds.set(current.filter((cid) => cid !== id));
    } else {
      this.selectedCalendarIds.set([...current, id]);
    }
  }

  isCalendarSelected(id: number): boolean {
    return this.selectedCalendarIds().includes(id);
  }

  openExportModal(): void {
    this.exportAgendaError.set('');
    this.isExportModalOpen.set(true);
  }

  closeExportModal(): void {
    this.isExportModalOpen.set(false);
    this.isExportingAgenda.set(false);
    this.exportAgendaError.set('');
  }

  openCreateModal(): void {
    this.createAppointmentError.set('');
    this.createAppointmentSuccess.set('');
    this.createAppointmentForm.reset({ patientId: 0, startsAt: '', reason: '', status: 'A confirmer' });
    this.isCreateModalOpen.set(true);
    void this.ensurePatientsLoaded();
  }

  closeCreateModal(): void {
    this.isCreateModalOpen.set(false);
    this.createAppointmentError.set('');
    this.createAppointmentSuccess.set('');
  }

  private async ensurePatientsLoaded(): Promise<void> {
    if (this.patients().length > 0) {
      return;
    }

    this.isLoadingPatients.set(true);
    try {
      const patients = await this.api.getPatients('');
      this.patients.set(patients);
    } catch (error) {
      this.createAppointmentError.set('Impossible de charger la liste des patients.');
    } finally {
      this.isLoadingPatients.set(false);
    }
  }

  async createAppointment(): Promise<void> {
    if (!this.createAppointmentForm.valid) {
      this.createAppointmentError.set('Veuillez remplir tous les champs.');
      return;
    }

    this.isCreatingAppointment.set(true);
    this.createAppointmentError.set('');
    this.createAppointmentSuccess.set('');

    try {
      const raw = this.createAppointmentForm.getRawValue();
      const activeOfficeId = this.selectedOfficeId();
      const calendarForOffice = this.localCalendars().find(
        (c) => c.officeId !== null && c.officeId === activeOfficeId
      ) ?? null;
      await this.api.createAppointment({
        patientId: Number(raw.patientId),
        startsAt: raw.startsAt,
        reason: raw.reason,
        status: raw.status,
        localCalendarId: calendarForOffice?.id ?? null,
        officeId: activeOfficeId
      });

      this.createAppointmentSuccess.set('Rendez-vous créé avec succès.');
      setTimeout(() => {
        this.closeCreateModal();
        void this.load();
      }, 800);
    } catch (error) {
      this.createAppointmentError.set('Erreur lors de la création du rendez-vous.');
    } finally {
      this.isCreatingAppointment.set(false);
    }
  }

  async exportAgenda(format: 'json' | 'excel'): Promise<void> {
    if (this.isExportingAgenda()) {
      return;
    }

    this.isExportingAgenda.set(true);
    this.exportAgendaError.set('');

    try {
      const rows = [...this.visibleEvents()].sort((a, b) => a.start.localeCompare(b.start));
      const exportedAt = new Date().toISOString();
      const selectedOffice = this.officeOptions().find((office) => office.id === this.selectedOfficeId()) ?? null;
      const fileDate = exportedAt.slice(0, 10);

      if (format === 'json') {
        const payload = {
          meta: {
            kind: 'agenda-export',
            exportedAt,
            officeId: selectedOffice?.id ?? null,
            officeName: selectedOffice?.name ?? null,
            count: rows.length
          },
          appointments: rows.map((event) => ({
            id: event.id,
            start: event.start,
            patient: event.patient,
            reason: event.reason,
            status: event.status,
            consultationType: event.consultationType,
            consultationTitle: event.consultationTitle,
            consultationPractitioner: event.consultationPractitioner,
            patientSex: event.patientSex,
            patientMobilePhone: event.patientMobilePhone,
            patientLandlinePhone: event.patientLandlinePhone,
            patientRemarks: event.patientRemarks,
            calendarId: event.calendarId,
            calendarColor: event.calendarColor,
            practitionerColor: event.practitionerColor
          }))
        };

        const fileName = `agenda-export-${fileDate}.json`;
        this.downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), fileName);
      } else {
        const xlsx = await import('xlsx');
        const sheetRows = rows.map((event) => ({
          date: new Intl.DateTimeFormat('fr-FR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }).format(new Date(event.start)),
          patient: event.patient,
          motif: event.reason,
          statut: event.status,
          typeConsultation: event.consultationType,
          titreConsultation: event.consultationTitle,
          praticien: event.consultationPractitioner,
          sexe: event.patientSex,
          telPortable: event.patientMobilePhone,
          telFixe: event.patientLandlinePhone,
          remarques: event.patientRemarks
        }));

        const worksheet = xlsx.utils.json_to_sheet(sheetRows);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Agenda');

        const arrayBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'array' });
        const fileName = `agenda-export-${fileDate}.xlsx`;
        this.downloadBlob(
          new Blob([arrayBuffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }),
          fileName
        );
      }

      this.closeExportModal();
    } catch {
      this.exportAgendaError.set('Impossible d\'exporter les données de l\'agenda.');
    } finally {
      this.isExportingAgenda.set(false);
    }
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  }
}
