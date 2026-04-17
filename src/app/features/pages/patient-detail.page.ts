import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import {
  ConsultationRecord,
  LocationPair,
  Patient,
  PatientAuditLog,
  PatientDetail,
  PatientDocumentSummary,
  UserAgendaPreferences
} from '../../core/api.types';
import { TopbarService } from '../../core/topbar.service';

declare const $: any;
declare const bootstrap: any;

type AccordionSection = 'identity' | 'patient-info' | 'antecedents' | 'documents' | 'consultations';
type AntecedentPrecision = 'date' | 'month' | 'year';
type ConsultationEditorSection = 'motifMainHtml' | 'testsHtml' | 'schemaHtml' | 'treatmentsHtml' | 'remarksHtml';

type ConsultationTimelineGroup = {
  key: string;
  label: string;
  consultations: ConsultationRecord[];
  collapseId: string;
  initiallyOpen: boolean;
};

type AntecedentTimelineItem = {
  id: string;
  category: string;
  description: string;
  dateDisplay: string;
  precision: AntecedentPrecision;
  sortKey: number;
  important: boolean;
};

@Component({
  selector: 'app-patient-detail-page',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './patient-detail.page.html',
  styleUrl: './patient-detail.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientDetailPage implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly topbar = inject(TopbarService);
  private readonly cdr = inject(ChangeDetectorRef);

  private readonly birthDateInputRef = viewChild<ElementRef<HTMLInputElement>>('birthDateInput');
  private readonly consultationModalRef = viewChild<ElementRef<HTMLDivElement>>('consultationModal');
  private readonly consultationMotifMainEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationMotifMainEditor');
  private readonly consultationTestsEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationTestsEditor');
  private readonly consultationSchemaEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationSchemaEditor');
  private readonly consultationTreatmentsEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationTreatmentsEditor');
  private readonly consultationRemarksEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationRemarksEditor');

  private isViewReady = false;
  private isDatepickerInitialized = false;
  private pendingBirthDateIso = '';
  private pendingFocusedConsultationId: number | null = null;
  private relatedSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private relatedSearchRequestId = 0;

  readonly isLoading = signal(true);
  readonly patient = signal<PatientDetail | null>(null);
  readonly consultations = signal<ConsultationRecord[]>([]);
  readonly patientDocuments = signal<PatientDocumentSummary[]>([]);
  readonly preferences = signal<UserAgendaPreferences | null>(null);

  readonly isSaving = signal(false);
  readonly saveError = signal('');
  readonly isLoadingDocuments = signal(false);
  readonly documentActionError = signal('');
  readonly showAuditModal = signal(false);
  readonly isLoadingAuditLogs = signal(false);
  readonly auditLoadError = signal('');
  readonly auditLogs = signal<PatientAuditLog[]>([]);
  readonly activeConsultation = signal<ConsultationRecord | null>(null);
  readonly isSavingConsultation = signal(false);
  readonly consultationSaveError = signal('');

  readonly showRelatedPicker = signal(false);
  readonly relatedSearch = signal('');
  readonly relatedSearchResults = signal<Patient[]>([]);
  readonly selectedRelatedPatients = signal<Patient[]>([]);
  readonly isSearchingRelated = signal(false);
  readonly locationPairs = signal<LocationPair[]>([]);
  readonly postalCodeSuggestions = signal<string[]>([]);
  readonly citySuggestions = signal<string[]>([]);
  readonly showPostalCodeSuggestions = signal(false);
  readonly showCitySuggestions = signal(false);

  private readonly birthDateIso = signal('');
  private readonly editSex = signal<PatientDetail['sex']>('Non renseigne');
  private isSynchronizingLocationFields = false;

  readonly editForm = this.fb.nonNullable.group({
    lastName: ['', [Validators.required, Validators.maxLength(100)]],
    firstName: ['', [Validators.required, Validators.maxLength(100)]],
    sex: ['Non renseigne' as PatientDetail['sex']],
    birthDate: ['', Validators.maxLength(20)],
    mobilePhone: ['', Validators.maxLength(50)],
    landlinePhone: ['', Validators.maxLength(50)],
    email: ['', Validators.maxLength(150)],
    address1: ['', Validators.maxLength(150)],
    address2: ['', Validators.maxLength(150)],
    postalCode: ['', Validators.maxLength(20)],
    city: ['', Validators.maxLength(100)],
    country: ['', Validators.maxLength(80)],
    maritalStatus: ['Non renseigne' as PatientDetail['maritalStatus']],
    childrenCount: [0, [Validators.min(0), Validators.max(50)]],
    occupationOrSchool: ['', Validators.maxLength(200)],
    hobbies: ['', Validators.maxLength(500)],
    primaryDoctor: ['', Validators.maxLength(160)],
    socialSecurityNumber: ['', Validators.maxLength(32)],
    referredBy: ['', Validators.maxLength(160)],
    manualPreference: ['Non renseigne' as PatientDetail['manualPreference']],
    generalRemarks: ['', Validators.maxLength(5000)],
    relatedPeople: ['', Validators.maxLength(500)],
    medicalHistory: ['', Validators.maxLength(5000)],
    isDeceased: [false]
  });

  readonly consultationEditForm = this.fb.nonNullable.group({
    startedAtLocal: ['', [Validators.required]],
    practitioner: ['', [Validators.maxLength(160)]],
    title: ['', [Validators.maxLength(200)]],
    important: [false],
    heightCm: [''],
    weightKg: [''],
    evaBefore: [0, [Validators.min(0), Validators.max(10)]],
    evaAfter: [0, [Validators.min(0), Validators.max(10)]],
    profile: ['Adulte', [Validators.maxLength(120)]]
  });

  readonly sexIcon = computed(() => {
    const sex = this.patient()?.sex;
    if (sex === 'Femme') return 'fa-solid fa-venus';
    if (sex === 'Homme') return 'fa-solid fa-mars';
    return 'fa-solid fa-genderless';
  });

  readonly sexColorClass = computed(() => {
    const sex = this.patient()?.sex;
    if (sex === 'Femme') return 'text-danger';
    if (sex === 'Homme') return 'text-primary';
    return 'text-secondary';
  });

  readonly editSexValue = this.editSex.asReadonly();

  readonly birthDateLabel = computed(() => {
    const birthDate = this.patient()?.birthDate;
    return birthDate ? this.formatLongDate(birthDate) : '';
  });

  readonly editAgeText = computed(() => {
    const birthDate = this.birthDateIso();
    if (!birthDate) {
      return '';
    }

    const date = new Date(birthDate);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    const now = new Date();
    let age = now.getFullYear() - date.getFullYear();
    const beforeBirthday =
      now.getMonth() < date.getMonth() ||
      (now.getMonth() === date.getMonth() && now.getDate() < date.getDate());
    if (beforeBirthday) {
      age -= 1;
    }

    return age >= 0 ? `${age} ans` : '';
  });

  readonly antecedents = computed(() => this.parseAntecedents(this.patient()?.medicalHistory ?? ''));

  readonly consultationRecords = computed(() =>
    this.consultations().filter((item) => {
      const recordType = (item as Partial<ConsultationRecord>).type;
      return recordType !== 'appointment';
    })
  );

  readonly consultationTimelineGroups = computed((): ConsultationTimelineGroup[] => {
    const preferences = this.preferences();
    const order = preferences?.consultationOrder ?? 'Antichronologique';
    const threshold = Math.max(0, preferences?.groupConsultationsByYearFrom ?? 10);
    const currentYear = new Date().getFullYear();

    const sorted = [...this.consultationRecords()].sort((left, right) => {
      const leftValue = new Date(left.startedAt).getTime();
      const rightValue = new Date(right.startedAt).getTime();
      return order === 'Chronologique' ? leftValue - rightValue : rightValue - leftValue;
    });

    const ungrouped: ConsultationRecord[] = [];
    const groupedByYear = new Map<number, ConsultationRecord[]>();

    for (const consultation of sorted) {
      const startedAt = new Date(consultation.startedAt);
      const year = startedAt.getFullYear();
      const ageInYears = Number.isNaN(startedAt.getTime()) ? 0 : currentYear - year;
      const shouldGroup = threshold === 0 || ageInYears >= threshold;

      if (shouldGroup && Number.isInteger(year)) {
        const items = groupedByYear.get(year) ?? [];
        items.push(consultation);
        groupedByYear.set(year, items);
      } else {
        ungrouped.push(consultation);
      }
    }

    const groups: ConsultationTimelineGroup[] = [];
    if (order === 'Antichronologique' && ungrouped.length > 0) {
      groups.push({
        key: 'recent',
        label: threshold === 0 ? 'Séances récentes' : `${threshold} dernières années`,
        consultations: ungrouped,
        collapseId: 'consultation-recent-group',
        initiallyOpen: true
      });
    }

    const yearGroups = [...groupedByYear.entries()]
      .sort((left, right) => (order === 'Chronologique' ? left[0] - right[0] : right[0] - left[0]))
      .map(([year, consultations]) => ({
        key: `year-${year}`,
        label: String(year),
        consultations,
        collapseId: `consultation-year-${year}`,
        initiallyOpen: false
      }));

    groups.push(...yearGroups);

    if (order === 'Chronologique' && ungrouped.length > 0) {
      groups.push({
        key: 'recent',
        label: threshold === 0 ? 'Séances récentes' : `${threshold} dernières années`,
        consultations: ungrouped,
        collapseId: 'consultation-recent-group',
        initiallyOpen: groups.length === 0
      });
    }

    if (groups.length === 0 && ungrouped.length > 0) {
      groups.push({
        key: 'all',
        label: 'Consultations',
        consultations: ungrouped,
        collapseId: 'consultation-all-group',
        initiallyOpen: true
      });
    }

    if (groups.length > 0 && !groups.some((group) => group.initiallyOpen)) {
      groups[0] = { ...groups[0], initiallyOpen: true };
    }

    return groups;
  });

  readonly totalConsultationCount = computed(() => this.consultationRecords().length);

  readonly auditRows = computed(() => {
    return this.auditLogs().flatMap((log) =>
      log.changes.map((change) => ({
        id: `${log.id}-${change.field}`,
        createdAt: log.createdAt,
        username: log.username,
        field: change.field,
        before: change.before,
        after: change.after
      }))
    );
  });

  readonly consultationModalTitle = computed(() => {
    const consultation = this.activeConsultation();
    if (!consultation) {
      return 'Consultation';
    }

    return consultation.title.trim() || this.formatConsultationDate(consultation.startedAt);
  });

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    const consultationIdRaw = this.route.snapshot.queryParamMap.get('consultationId');
    const consultationId = Number(consultationIdRaw);
    this.pendingFocusedConsultationId = Number.isInteger(consultationId) && consultationId > 0 ? consultationId : null;

    this.topbar.set([
      {
        id: 'back',
        label: 'Retour',
        icon: 'fa-arrow-left',
        btnClass: 'btn-outline-secondary',
        onClick: () => void this.router.navigate(['/patients'])
      },
      {
        id: 'save',
        label: 'Enregistrer',
        icon: 'fa-floppy-disk',
        btnClass: 'btn-primary',
        loadingLabel: 'Enregistrement...',
        disabled: () => this.isSaving() || this.editForm.invalid,
        loading: () => this.isSaving(),
        onClick: () => void this.saveEdit()
      }
    ]);

    void this.loadLocationPairs();
    void this.load(id);
  }

  ngAfterViewInit(): void {
    this.isViewReady = true;
    queueMicrotask(() => this.initDatepicker());
  }

  ngOnDestroy(): void {
    this.topbar.clear();

    const input = this.birthDateInputRef()?.nativeElement;
    if (input) {
      try {
        $(input).datepicker('destroy');
      } catch {
        // ignore
      }
    }

    if (this.relatedSearchDebounceId !== null) {
      clearTimeout(this.relatedSearchDebounceId);
    }
  }

  onPostalCodeInput(value: string): void {
    this.updateLocationSuggestions(value, this.editForm.controls.city.value);
    this.syncCityFromPostalCode(value);
    this.showPostalCodeSuggestions.set(Boolean(value.trim()) && this.postalCodeSuggestions().length > 0);
  }

  onCityInput(value: string): void {
    this.updateLocationSuggestions(this.editForm.controls.postalCode.value, value);
    this.syncPostalCodeFromCity(value);
    this.showCitySuggestions.set(Boolean(value.trim()) && this.citySuggestions().length > 0);
  }

  onPostalCodeFocus(): void {
    const value = this.editForm.controls.postalCode.value;
    this.updateLocationSuggestions(value, this.editForm.controls.city.value);
    this.showPostalCodeSuggestions.set(Boolean(value.trim()) && this.postalCodeSuggestions().length > 0);
  }

  onCityFocus(): void {
    const value = this.editForm.controls.city.value;
    this.updateLocationSuggestions(this.editForm.controls.postalCode.value, value);
    this.showCitySuggestions.set(Boolean(value.trim()) && this.citySuggestions().length > 0);
  }

  onPostalCodeBlur(): void {
    this.syncCityFromPostalCode(this.editForm.controls.postalCode.value);
    setTimeout(() => this.showPostalCodeSuggestions.set(false), 120);
  }

  onCityBlur(): void {
    this.syncPostalCodeFromCity(this.editForm.controls.city.value);
    setTimeout(() => this.showCitySuggestions.set(false), 120);
  }

  applyPostalCodeSuggestion(postalCode: string): void {
    this.editForm.controls.postalCode.setValue(postalCode);
    this.syncCityFromPostalCode(postalCode);
    this.showPostalCodeSuggestions.set(false);
  }

  applyCitySuggestion(city: string): void {
    this.editForm.controls.city.setValue(city);
    this.syncPostalCodeFromCity(city);
    this.showCitySuggestions.set(false);
  }

  setEditSex(value: PatientDetail['sex']): void {
    this.editForm.controls.sex.setValue(value);
    this.editSex.set(value);
    this.cdr.markForCheck();
  }

  toggleRelatedPicker(): void {
    this.showRelatedPicker.update((value) => !value);
    if (!this.showRelatedPicker()) {
      this.relatedSearch.set('');
      this.relatedSearchResults.set([]);
    }
  }

  onRelatedSearchChange(value: string): void {
    this.relatedSearch.set(value);
    if (this.relatedSearchDebounceId !== null) {
      clearTimeout(this.relatedSearchDebounceId);
      this.relatedSearchDebounceId = null;
    }

    const term = value.trim();
    if (term.length < 2) {
      this.relatedSearchResults.set([]);
      this.isSearchingRelated.set(false);
      return;
    }

    this.isSearchingRelated.set(true);
    this.relatedSearchDebounceId = setTimeout(() => {
      void this.searchRelatedPatients(term);
    }, 250);
  }

  addRelatedPatient(patient: Patient): void {
    this.selectedRelatedPatients.update((items) => {
      if (items.some((item) => item.id === patient.id)) {
        return items;
      }

      return [...items, patient];
    });

    this.relatedSearch.set('');
    this.relatedSearchResults.set([]);
    this.syncRelatedPeopleField();
  }

  removeRelatedPatient(patientId: number): void {
    this.selectedRelatedPatients.update((items) => items.filter((item) => item.id !== patientId));
    this.syncRelatedPeopleField();
  }

  openRelatedPatient(patientId: number): void {
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return;
    }

    void this.router.navigate(['/patients', patientId]);
  }

  async saveEdit(): Promise<void> {
    if (this.editForm.invalid || this.isSaving()) {
      return;
    }

    const patient = this.patient();
    if (!patient) {
      return;
    }

    this.isSaving.set(true);
    this.saveError.set('');

    try {
      const { relatedPeople, ...rest } = this.editForm.getRawValue();
      await this.api.updatePatient(patient.id, {
        ...rest,
        relatedPeople: this.editForm.controls.relatedPeople.value
      });
      await this.load(patient.id);
    } catch {
      this.saveError.set('Une erreur est survenue lors de la sauvegarde.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async openAuditModal(): Promise<void> {
    const patient = this.patient();
    if (!patient) {
      return;
    }

    this.showAuditModal.set(true);
    this.isLoadingAuditLogs.set(true);
    this.auditLoadError.set('');

    try {
      const logs = await this.api.getPatientAuditLogs(patient.id);
      this.auditLogs.set(logs);
    } catch {
      this.auditLoadError.set('Impossible de charger l\'historique des changements.');
      this.auditLogs.set([]);
    } finally {
      this.isLoadingAuditLogs.set(false);
    }
  }

  closeAuditModal(): void {
    this.showAuditModal.set(false);
  }

  async openPatientDocument(patientDocument: PatientDocumentSummary, forceDownload = false): Promise<void> {
    this.documentActionError.set('');

    try {
      const detail = await this.api.getPatientDocument(patientDocument.documentRef);
      const blob = this.base64ToBlob(detail.contentBase64, detail.mimeType || 'application/octet-stream');
      const url = URL.createObjectURL(blob);
      const preferDownload = forceDownload || this.preferences()?.pdfDisplayMode === 'download';
      const shouldOpenInBrowser = !preferDownload && this.canOpenInBrowser(detail.mimeType);

      if (shouldOpenInBrowser) {
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }

      const anchor = globalThis.document.createElement('a');
      anchor.href = url;
      anchor.download = detail.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      this.documentActionError.set('Impossible d’ouvrir ce document pour le moment.');
    }
  }

  openConsultationModal(consultation: ConsultationRecord): void {
    if (consultation.type === 'appointment') {
      return;
    }

    this.activeConsultation.set(consultation);
    this.consultationSaveError.set('');
    this.consultationEditForm.reset({
      startedAtLocal: this.toDateTimeLocalValue(consultation.startedAt),
      practitioner: consultation.practitioner,
      title: consultation.title,
      important: consultation.important,
      heightCm: consultation.heightCm != null ? String(consultation.heightCm) : '',
      weightKg: consultation.weightKg != null ? String(consultation.weightKg) : '',
      evaBefore: consultation.evaBefore,
      evaAfter: consultation.evaAfter,
      profile: consultation.profile || 'Adulte'
    });

    queueMicrotask(() => {
      this.setConsultationEditorContent('motifMainHtml', consultation.motifMainHtml);
      this.setConsultationEditorContent('testsHtml', consultation.testsHtml);
      this.setConsultationEditorContent('schemaHtml', consultation.schemaHtml);
      this.setConsultationEditorContent('treatmentsHtml', consultation.treatmentsHtml);
      this.setConsultationEditorContent('remarksHtml', consultation.remarksHtml);

      const modalElement = this.consultationModalRef()?.nativeElement;
      if (modalElement) {
        bootstrap.Modal.getOrCreateInstance(modalElement).show();
      }
    });
  }

  closeConsultationModal(): void {
    const modalElement = this.consultationModalRef()?.nativeElement;
    if (modalElement) {
      bootstrap.Modal.getOrCreateInstance(modalElement).hide();
    }
  }

  async saveConsultation(): Promise<void> {
    const active = this.activeConsultation();
    if (!active || this.consultationEditForm.invalid || this.isSavingConsultation()) {
      return;
    }

    this.isSavingConsultation.set(true);
    this.consultationSaveError.set('');

    try {
      const raw = this.consultationEditForm.getRawValue();
      const updated = await this.api.updateConsultation(active.id, {
        startedAt: this.fromDateTimeLocalValue(raw.startedAtLocal) ?? active.startedAt,
        practitioner: raw.practitioner,
        title: raw.title,
        important: raw.important,
        heightCm: this.parseNullableNumber(raw.heightCm),
        weightKg: this.parseNullableNumber(raw.weightKg),
        evaBefore: Number(raw.evaBefore) || 0,
        evaAfter: Number(raw.evaAfter) || 0,
        profile: raw.profile,
        motifMainHtml: this.getConsultationEditorContent('motifMainHtml'),
        testsHtml: this.getConsultationEditorContent('testsHtml'),
        schemaHtml: this.getConsultationEditorContent('schemaHtml'),
        treatmentsHtml: this.getConsultationEditorContent('treatmentsHtml'),
        remarksHtml: this.getConsultationEditorContent('remarksHtml')
      });

      this.consultations.update((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      this.activeConsultation.set(updated);
      this.closeConsultationModal();
    } catch {
      this.consultationSaveError.set('Impossible d’enregistrer la consultation.');
    } finally {
      this.isSavingConsultation.set(false);
    }
  }

  consultationBmi(consultation: ConsultationRecord): string | null {
    if (!consultation.heightCm || !consultation.weightKg) {
      return null;
    }

    return (consultation.weightKg / ((consultation.heightCm / 100) ** 2)).toFixed(1);
  }

  formatConsultationDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  formatLongDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat('fr-FR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(date);
  }

  formatShortDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(date);
  }

  formatFileSize(sizeBytes: number): string {
    if (sizeBytes < 1024) {
      return `${sizeBytes} o`;
    }
    if (sizeBytes < 1024 * 1024) {
      return `${(sizeBytes / 1024).toFixed(1)} Ko`;
    }
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  getRelatedPatientIcon(sex: Patient['sex']): string {
    if (sex === 'Femme') return 'fa-solid fa-venus';
    if (sex === 'Homme') return 'fa-solid fa-mars';
    return 'fa-solid fa-circle-question';
  }

  getRelatedPatientMeta(patient: Patient): string {
    const ageText = patient.age === null ? 'Âge inconnu' : `${patient.age} ans`;
    const consultationText = `${patient.consultationCount} consultation${patient.consultationCount > 1 ? 's' : ''}`;
    return `${ageText} - ${consultationText}`;
  }

  formatRelatedPatientLabel(patient: Patient): string {
    const normalizedFullName = String(patient.fullName ?? '').trim().replace(/\s+/g, ' ');
    const tokens = normalizedFullName ? normalizedFullName.split(' ') : [];

    let lastName = '';
    let firstName = '';

    if (tokens.length === 1) {
      lastName = tokens[0].toUpperCase();
    } else if (tokens.length > 1) {
      firstName = tokens.slice(0, -1).join(' ');
      lastName = tokens[tokens.length - 1].toUpperCase();
    }

    const namePart = [lastName, firstName].filter(Boolean).join(' ').trim() || normalizedFullName || 'INCONNU';
    const agePart = patient.age === null ? 'Age inconnu' : `${patient.age} ans`;
    return `${namePart} - ${agePart}`;
  }

  private async load(id: number): Promise<void> {
    this.isLoading.set(true);
    this.isLoadingDocuments.set(true);

    try {
      const [patient, consultations, documents, preferences] = await Promise.all([
        this.api.getPatientDetail(id),
        this.api.getPatientConsultations(id),
        this.api.getPatientDocuments(id),
        this.api.getMyAgendaPreferences()
      ]);

      this.patient.set(patient);
      this.consultations.set(consultations);
      this.patientDocuments.set(documents);
      this.preferences.set(preferences);
      this.startEdit();

      queueMicrotask(() => {
        this.openAccordion('identity');
        if (this.pendingFocusedConsultationId != null) {
          this.focusConsultationById(this.pendingFocusedConsultationId);
        }
      });
    } catch {
      this.patient.set(null);
      this.consultations.set([]);
      this.patientDocuments.set([]);
    } finally {
      this.isLoading.set(false);
      this.isLoadingDocuments.set(false);
    }
  }

  private startEdit(): void {
    const patient = this.patient();
    if (!patient) {
      return;
    }

    this.editForm.reset({
      lastName: patient.lastName,
      firstName: patient.firstName,
      sex: patient.sex,
      birthDate: patient.birthDate,
      mobilePhone: patient.mobilePhone,
      landlinePhone: patient.landlinePhone,
      email: patient.email,
      address1: patient.address1,
      address2: patient.address2,
      postalCode: patient.postalCode,
      city: patient.city,
      country: patient.country,
      maritalStatus: patient.maritalStatus,
      childrenCount: patient.childrenCount,
      occupationOrSchool: patient.occupationOrSchool,
      hobbies: patient.hobbies,
      primaryDoctor: patient.primaryDoctor,
      socialSecurityNumber: patient.socialSecurityNumber,
      referredBy: patient.referredBy,
      manualPreference: patient.manualPreference,
      generalRemarks: patient.generalRemarks,
      relatedPeople: patient.relatedPeople,
      medicalHistory: patient.medicalHistory,
      isDeceased: patient.isDeceased
    });

    this.editSex.set(patient.sex);
    this.birthDateIso.set(patient.birthDate ?? '');
    this.saveError.set('');
    this.hydrateSelectedRelatedPatients(patient.relatedPeople);
    this.updateLocationSuggestions(patient.postalCode, patient.city);

    if (this.isViewReady) {
      queueMicrotask(() => {
        this.initDatepicker();
        if (patient.birthDate) {
          this.applyBirthDateToPicker(patient.birthDate);
        }
      });
    } else if (patient.birthDate) {
      this.pendingBirthDateIso = patient.birthDate;
    }
  }

  private hydrateSelectedRelatedPatients(relatedPeople: string): void {
    const names = String(relatedPeople ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    this.selectedRelatedPatients.set(
      names.map((fullName, index) => ({
        id: -(index + 1),
        fullName,
        phone: '',
        lastVisit: '',
        sex: 'Non renseigne',
        age: null,
        consultationCount: 0
      }))
    );
  }

  private openAccordion(section: AccordionSection): void {
    const element = document.getElementById(`patient-accordion-${section}`);
    if (!element) {
      return;
    }

    bootstrap.Collapse.getOrCreateInstance(element, { toggle: false }).show();
  }

  private async loadLocationPairs(): Promise<void> {
    try {
      const pairs = await this.api.getPatientLocations();
      this.locationPairs.set(pairs);
      this.updateLocationSuggestions(this.editForm.controls.postalCode.value, this.editForm.controls.city.value);
    } catch {
      this.locationPairs.set([]);
      this.postalCodeSuggestions.set([]);
      this.citySuggestions.set([]);
    }
  }

  private updateLocationSuggestions(postalCode: string, city: string): void {
    const postalQuery = String(postalCode ?? '').trim().toLowerCase();
    const cityQuery = String(city ?? '').trim().toLowerCase();

    const matches = this.locationPairs().filter((pair) => {
      const pairPostalCode = pair.postalCode.toLowerCase();
      const pairCity = pair.city.toLowerCase();
      return (!postalQuery || pairPostalCode.includes(postalQuery)) && (!cityQuery || pairCity.includes(cityQuery));
    });

    this.postalCodeSuggestions.set([...new Set(matches.map((pair) => pair.postalCode))].slice(0, 12));
    this.citySuggestions.set([...new Set(matches.map((pair) => pair.city))].slice(0, 12));
  }

  private syncCityFromPostalCode(postalCode: string): void {
    if (this.isSynchronizingLocationFields) {
      return;
    }

    const target = String(postalCode ?? '').trim().toLowerCase();
    if (!target) {
      return;
    }

    const exactMatches = this.locationPairs().filter((pair) => pair.postalCode.toLowerCase() === target);
    if (!exactMatches.length) {
      return;
    }

    const currentCity = this.editForm.controls.city.value.trim().toLowerCase();
    if (exactMatches.some((pair) => pair.city.toLowerCase() === currentCity)) {
      return;
    }

    this.isSynchronizingLocationFields = true;
    this.editForm.controls.city.setValue(exactMatches[0].city);
    this.isSynchronizingLocationFields = false;
    this.updateLocationSuggestions(this.editForm.controls.postalCode.value, this.editForm.controls.city.value);
  }

  private syncPostalCodeFromCity(city: string): void {
    if (this.isSynchronizingLocationFields) {
      return;
    }

    const target = String(city ?? '').trim().toLowerCase();
    if (!target) {
      return;
    }

    const exactMatches = this.locationPairs().filter((pair) => pair.city.toLowerCase() === target);
    if (!exactMatches.length) {
      return;
    }

    const currentPostalCode = this.editForm.controls.postalCode.value.trim().toLowerCase();
    if (exactMatches.some((pair) => pair.postalCode.toLowerCase() === currentPostalCode)) {
      return;
    }

    this.isSynchronizingLocationFields = true;
    this.editForm.controls.postalCode.setValue(exactMatches[0].postalCode);
    this.isSynchronizingLocationFields = false;
    this.updateLocationSuggestions(this.editForm.controls.postalCode.value, this.editForm.controls.city.value);
  }

  private async searchRelatedPatients(term: string): Promise<void> {
    const requestId = ++this.relatedSearchRequestId;

    try {
      const results = await this.api.getPatients(term);
      if (requestId !== this.relatedSearchRequestId) {
        return;
      }

      const existingIds = new Set(this.selectedRelatedPatients().map((patient) => patient.id));
      const currentId = this.patient()?.id;
      this.relatedSearchResults.set(
        results.filter((patient) => !existingIds.has(patient.id) && patient.id !== currentId)
      );
    } catch {
      if (requestId === this.relatedSearchRequestId) {
        this.relatedSearchResults.set([]);
      }
    } finally {
      if (requestId === this.relatedSearchRequestId) {
        this.isSearchingRelated.set(false);
      }
    }

    this.cdr.markForCheck();
  }

  private syncRelatedPeopleField(): void {
    const value = this.selectedRelatedPatients().map((patient) => patient.fullName).join(', ');
    this.editForm.controls.relatedPeople.setValue(value);
  }

  private initDatepicker(): void {
    const input = this.birthDateInputRef()?.nativeElement;
    if (!input || this.isDatepickerInitialized) {
      return;
    }

    $(input).datepicker({
      language: 'fr',
      format: 'dd/mm/yyyy',
      container: 'body',
      autoclose: true,
      todayHighlight: true,
      weekStart: 1,
      startView: 2,
      endDate: new Date()
    }).on('changeDate', (event: { date: Date }) => {
      const date = event.date;
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      this.editForm.controls.birthDate.setValue(iso);
      this.birthDateIso.set(iso);
      this.cdr.markForCheck();
    });

    this.isDatepickerInitialized = true;
    if (this.pendingBirthDateIso) {
      this.applyBirthDateToPicker(this.pendingBirthDateIso);
      this.pendingBirthDateIso = '';
    }
  }

  private applyBirthDateToPicker(iso: string): void {
    const input = this.birthDateInputRef()?.nativeElement;
    if (!input || !iso) {
      return;
    }

    const [year, month, day] = iso.split('-').map(Number);
    if (!year || !month || !day) {
      return;
    }

    try {
      $(input).datepicker('setDate', new Date(year, month - 1, day));
    } catch {
      // ignore
    }
  }

  private parseAntecedents(raw: string): AntecedentTimelineItem[] {
    const source = String(raw ?? '').trim();
    if (!source) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return [
        {
          id: 'legacy-text',
          category: 'Antécédent',
          description: source,
          dateDisplay: '',
          precision: 'date',
          sortKey: 0,
          important: false
        }
      ];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry, index) => {
        const record = entry as Record<string, unknown>;
        const description = String(record['description'] ?? record['label'] ?? '').trim();

        const precisionValue = record['datePrecision'];
        const precision = precisionValue === 'year' || precisionValue === 'month' || precisionValue === 'date'
          ? (precisionValue as AntecedentPrecision)
          : 'date';
        const sortKeyValue = Number(record['sortKey']);

        return {
          id: String(record['id'] ?? `${index}`),
          category: String(record['category'] ?? 'Antécédent').trim() || 'Antécédent',
          description: description || 'Détail non renseigné',
          dateDisplay: String(record['dateDisplay'] ?? record['date'] ?? '').trim(),
          precision,
          sortKey: Number.isFinite(sortKeyValue) ? sortKeyValue : 0,
          important: Boolean(record['important'])
        } satisfies AntecedentTimelineItem;
      })
      .sort((left, right) => right.sortKey - left.sortKey);
  }

  private focusConsultationById(consultationId: number): void {
    const consultation = this.consultationRecords().find((entry) => entry.id === consultationId);
    if (!consultation) {
      return;
    }

    this.openAccordion('consultations');
    queueMicrotask(() => this.openConsultationModal(consultation));
  }

  private parseNullableNumber(value: string): number | null {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number(normalized.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toDateTimeLocalValue(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private fromDateTimeLocalValue(value: string): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
      return null;
    }

    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private getConsultationEditorElement(section: ConsultationEditorSection): HTMLDivElement | null {
    if (section === 'motifMainHtml') return this.consultationMotifMainEditorRef()?.nativeElement ?? null;
    if (section === 'testsHtml') return this.consultationTestsEditorRef()?.nativeElement ?? null;
    if (section === 'schemaHtml') return this.consultationSchemaEditorRef()?.nativeElement ?? null;
    if (section === 'treatmentsHtml') return this.consultationTreatmentsEditorRef()?.nativeElement ?? null;
    return this.consultationRemarksEditorRef()?.nativeElement ?? null;
  }

  private setConsultationEditorContent(section: ConsultationEditorSection, html: string): void {
    const element = this.getConsultationEditorElement(section);
    if (element) {
      element.innerHTML = html || '';
    }
  }

  private getConsultationEditorContent(section: ConsultationEditorSection): string {
    return this.getConsultationEditorElement(section)?.innerHTML.trim() ?? '';
  }

  private canOpenInBrowser(mimeType: string): boolean {
    const normalized = String(mimeType ?? '').toLowerCase();
    return normalized.startsWith('image/') || normalized === 'application/pdf' || normalized.startsWith('text/');
  }

  private base64ToBlob(contentBase64: string, mimeType: string): Blob {
    const binary = atob(contentBase64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new Blob([bytes], { type: mimeType });
  }
}