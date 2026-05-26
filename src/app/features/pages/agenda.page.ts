import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { AgendaSettings, Appointment, DashboardEvent, LocalAgendaCalendar, OfficeOpeningHours, OfficeOption, Patient, Practitioner } from '../../core/api.types';
import { WeekCalendar } from './week-calendar';
import { BsTooltipDirective } from '../../core/bs-tooltip.directive';
import { sanitizeCellValue } from '../../core/xlsx-export.utils';

@Component({
  selector: 'app-agenda-page',
  standalone: true,
  imports: [ReactiveFormsModule, WeekCalendar, BsTooltipDirective],
  templateUrl: './agenda.page.html',
  styleUrl: './agenda.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AgendaPage implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);
  private readonly fb = inject(FormBuilder);

  readonly stats = signal([
    { label: 'Consultations du jour', value: '0' },
    { label: 'Nouveaux patients dans le mois', value: '0' },
    { label: 'Taux de remplissage (30 jours glissants)', value: '0%' }
  ]);

  readonly appointments = signal<Appointment[]>([]);
  readonly officeOptions = signal<OfficeOption[]>([]);
  readonly selectedOfficeId = signal<number | null>(this.authService.activeOfficeId());
  readonly isAllOfficesOverride = signal(false);
  readonly defaultAgendaView = signal<string>('Semaine');
  readonly events = signal<DashboardEvent[]>([]);
  readonly officeOpeningHoursById = signal<Record<number, OfficeOpeningHours>>({});
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
  readonly canCreateAppointment = computed(() => this.authService.hasPermission('create-appointment'));

  readonly isCreateModalOpen = signal(false);
  readonly isExportModalOpen = signal(false);
  readonly isExportingAgenda = signal(false);
  readonly exportAgendaError = signal('');
  readonly practitioners = signal<Practitioner[]>([]);
  readonly createPatientSearch = signal('');
  readonly createPatientResults = signal<Patient[]>([]);
  readonly isSearchingCreatePatient = signal(false);
  readonly selectedCreatePatient = signal<Patient | null>(null);
  readonly isCreatingAppointment = signal(false);
  readonly createAppointmentError = signal('');
  readonly createAppointmentSuccess = signal('');

  private createPatientSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private createPatientSearchRequestId = 0;
  private readonly activeOfficeSyncEffect = effect(() => {
    const activeOfficeId = this.authService.activeOfficeId();
    if (this.isAllOfficesOverride()) {
      return;
    }

    if (this.selectedOfficeId() === activeOfficeId) {
      return;
    }

    this.selectedOfficeId.set(activeOfficeId);
    this.selectedCalendarIds.set([]);
    void this.load();
  });

  readonly createAppointmentForm = this.fb.nonNullable.group({
    patientId: [0],
    patientFirstName: ['', [Validators.maxLength(120)]],
    patientLastName: ['', [Validators.maxLength(120)]],
    isPrivate: [false],
    privateReason: ['', [Validators.maxLength(180)]],
    practitioner: ['', [Validators.maxLength(120)]],
    startsAt: ['', [Validators.required]],
    reason: ['', [Validators.required]],
    status: ['A confirmer' as const, [Validators.required]]
  });

  private defaultsLoaded = false;

  constructor() {
    this.load();
  }

  async onSelectedOfficeChange(value: string): Promise<void> {
    const parsed = Number(value);
    const nextOfficeId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    if (nextOfficeId === null) {
      if (this.isAllOfficesOverride() && this.selectedOfficeId() === null) {
        return;
      }

      this.isAllOfficesOverride.set(true);
      this.selectedOfficeId.set(null);
      this.selectedCalendarIds.set([]);
      await this.load();
      return;
    }

    this.isAllOfficesOverride.set(false);
    if (nextOfficeId === this.selectedOfficeId() && this.authService.activeOfficeId() === nextOfficeId) {
      return;
    }

    if (this.authService.activeOfficeId() === nextOfficeId) {
      this.selectedOfficeId.set(nextOfficeId);
      this.selectedCalendarIds.set([]);
      await this.load();
      return;
    }

    this.authService.setActiveOfficeId(nextOfficeId);
  }

  private async load(): Promise<void> {
    if (!this.defaultsLoaded) {
      this.defaultsLoaded = true;
      const profile = await this.api.getMyUserProfile();
      this.defaultAgendaView.set(profile.defaultAgendaView || 'Semaine');
    }

    const me = await this.api.me();
    const offices = Array.isArray(me.offices) ? me.offices : [];
    this.officeOptions.set(offices);

    const hasCurrentOffice = this.selectedOfficeId() === null || offices.some((office) => office.id === this.selectedOfficeId());
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
      { label: 'Nouveaux patients dans le mois', value: String(appointmentsPayload.stats.newPatients) },
      { label: 'Taux de remplissage (30 jours glissants)', value: appointmentsPayload.stats.occupancyRate }
    ]);

    // Update calendar state
    this.events.set(dashboardPayload.events);
    this.officeOpeningHoursById.set(dashboardPayload.officeOpeningHoursById ?? {});
    this.visibleEvents.set(dashboardPayload.events);
    this.agendaSettings.set(dashboardPayload.agendaSettings);

    const calendars = Array.isArray(dashboardPayload.localCalendars) ? dashboardPayload.localCalendars : [];
    this.localCalendars.set(calendars);
    const availableCalendarIds = new Set(
      calendars
        .map((c) => c.id)
        .filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
    );

    const preservedSelection = this.selectedCalendarIds().filter((id) => availableCalendarIds.has(id));
    if (preservedSelection.length > 0) {
      this.selectedCalendarIds.set(preservedSelection);
    } else {
      this.selectedCalendarIds.set(Array.from(availableCalendarIds));
    }
  }

  onVisibleEventsChange(events: DashboardEvent[]): void {
    this.visibleEvents.set(events);
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
    if (!this.canCreateAppointment()) {
      return;
    }

    this.createAppointmentError.set('');
    this.createAppointmentSuccess.set('');
    this.createPatientSearch.set('');
    this.createPatientResults.set([]);
    this.selectedCreatePatient.set(null);
    this.createAppointmentForm.reset({
      patientId: 0,
      patientFirstName: '',
      patientLastName: '',
      isPrivate: false,
      privateReason: '',
      practitioner: '',
      startsAt: '',
      reason: '',
      status: 'A confirmer'
    });
    this.isCreateModalOpen.set(true);
    void this.ensurePractitionersLoaded();
  }

  closeCreateModal(): void {
    this.isCreateModalOpen.set(false);
    this.createAppointmentError.set('');
    this.createAppointmentSuccess.set('');
    this.createPatientSearch.set('');
    this.createPatientResults.set([]);
    this.selectedCreatePatient.set(null);

    if (this.createPatientSearchDebounceId !== null) {
      clearTimeout(this.createPatientSearchDebounceId);
      this.createPatientSearchDebounceId = null;
    }
  }

  onCreatePatientSearchChange(value: string): void {
    const term = value.trim();
    this.createPatientSearch.set(value);
    this.selectedCreatePatient.set(null);
    this.createAppointmentForm.controls.patientId.setValue(0);

    if (this.createPatientSearchDebounceId !== null) {
      clearTimeout(this.createPatientSearchDebounceId);
      this.createPatientSearchDebounceId = null;
    }

    if (term.length < 2) {
      this.createPatientResults.set([]);
      this.isSearchingCreatePatient.set(false);
      return;
    }

    this.isSearchingCreatePatient.set(true);
    this.createPatientSearchDebounceId = setTimeout(() => {
      void this.searchCreatePatient(term);
    }, 220);
  }

  selectCreatePatient(patient: Patient): void {
    this.selectedCreatePatient.set(patient);
    this.createPatientResults.set([]);
    this.createPatientSearch.set(patient.fullName);
    this.createAppointmentForm.controls.patientId.setValue(patient.id);

    const parts = patient.fullName.trim().split(/\s+/);
    const lastName = parts.length > 0 ? parts[0] : '';
    const firstName = parts.length > 1 ? parts.slice(1).join(' ') : '';
    this.createAppointmentForm.controls.patientLastName.setValue(lastName);
    this.createAppointmentForm.controls.patientFirstName.setValue(firstName);
  }

  clearSelectedCreatePatient(): void {
    this.selectedCreatePatient.set(null);
    this.createPatientSearch.set('');
    this.createPatientResults.set([]);
    this.createAppointmentForm.controls.patientId.setValue(0);
  }

  onCreatePrivateToggle(value: boolean): void {
    this.createAppointmentForm.controls.isPrivate.setValue(value);
    if (value) {
      this.clearSelectedCreatePatient();
      this.createAppointmentForm.controls.patientFirstName.setValue('');
      this.createAppointmentForm.controls.patientLastName.setValue('');
    } else {
      this.createAppointmentForm.controls.privateReason.setValue('');
    }
  }

  async onCreateOfficeChange(value: string): Promise<void> {
    await this.onSelectedOfficeChange(value);
  }

  private async ensurePractitionersLoaded(): Promise<void> {
    if (this.practitioners().length > 0) {
      return;
    }

    try {
      const practitioners = await this.api.getPractitioners();
      this.practitioners.set(practitioners);
    } catch {
      this.practitioners.set([]);
    } finally {
      // no-op
    }
  }

  private async searchCreatePatient(term: string): Promise<void> {
    const requestId = ++this.createPatientSearchRequestId;

    try {
      const patients = await this.api.getPatients(term);
      if (requestId !== this.createPatientSearchRequestId) {
        return;
      }

      this.createPatientResults.set(patients.slice(0, 8));
    } catch {
      if (requestId === this.createPatientSearchRequestId) {
        this.createPatientResults.set([]);
      }
    } finally {
      if (requestId === this.createPatientSearchRequestId) {
        this.isSearchingCreatePatient.set(false);
      }
    }
  }

  async createAppointment(): Promise<void> {
    if (!this.canCreateAppointment()) {
      this.createAppointmentError.set('Vous ne disposez pas du droit de creer un rendez-vous.');
      return;
    }

    if (!this.createAppointmentForm.valid) {
      this.createAppointmentError.set('Veuillez remplir tous les champs.');
      return;
    }

    const raw = this.createAppointmentForm.getRawValue();
    const isPrivate = Boolean(raw.isPrivate);

    if (isPrivate) {
      if (!raw.privateReason.trim()) {
        this.createAppointmentError.set('Veuillez saisir une raison pour le rendez-vous prive.');
        return;
      }
    } else {
      const hasSelectedPatient = Number.isInteger(Number(raw.patientId)) && Number(raw.patientId) > 0;
      if (!hasSelectedPatient) {
        if (!raw.patientLastName.trim() || !raw.patientFirstName.trim()) {
          this.createAppointmentError.set('Veuillez sélectionner un patient existant ou saisir son nom et son prénom.');
          return;
        }
      }
    }

    this.isCreatingAppointment.set(true);
    this.createAppointmentError.set('');
    this.createAppointmentSuccess.set('');

    try {
      const activeOfficeId = this.selectedOfficeId();
      const calendarForOffice = this.localCalendars().find(
        (c) => c.officeId !== null && c.officeId === activeOfficeId
      ) ?? null;
      await this.api.createAppointment({
        patientId: Number(raw.patientId) > 0 ? Number(raw.patientId) : null,
        patientFirstName: raw.patientFirstName.trim(),
        patientLastName: raw.patientLastName.trim(),
        isPrivate,
        privateReason: raw.privateReason.trim(),
        practitioner: raw.practitioner.trim(),
        startsAt: raw.startsAt ? new Date(raw.startsAt).toISOString() : raw.startsAt,
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
        const ExcelJS = await import('exceljs');
        const sheetRows = rows.map((event) => ({
          date: new Intl.DateTimeFormat('fr-FR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }).format(new Date(event.start)),
          patient: sanitizeCellValue(event.patient),
          motif: sanitizeCellValue(event.reason),
          statut: sanitizeCellValue(event.status),
          typeConsultation: sanitizeCellValue(event.consultationType),
          titreConsultation: sanitizeCellValue(event.consultationTitle),
          praticien: sanitizeCellValue(event.consultationPractitioner),
          sexe: sanitizeCellValue(event.patientSex),
          telPortable: sanitizeCellValue(event.patientMobilePhone),
          telFixe: sanitizeCellValue(event.patientLandlinePhone),
          remarques: sanitizeCellValue(event.patientRemarks)
        }));

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Agenda');
        if (sheetRows.length > 0) {
          worksheet.addRow(Object.keys(sheetRows[0]));
          sheetRows.forEach((row) => worksheet.addRow(Object.values(row)));
        }

        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = `agenda-export-${fileDate}.xlsx`;
        this.downloadBlob(
          new Blob([buffer], {
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

  ngOnDestroy(): void {
    if (this.createPatientSearchDebounceId !== null) {
      clearTimeout(this.createPatientSearchDebounceId);
      this.createPatientSearchDebounceId = null;
    }
    this.activeOfficeSyncEffect.destroy();
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
