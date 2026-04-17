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
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { jsPDF } from 'jspdf';

import { ApiService } from '../../core/api.service';
import {
  ConsultationContextPayload,
  ConsultationDocumentUploadPayload,
  ConsultationRecord,
  ConsultationReasonItem,
  ConsultationUpdatePayload,
  LocationPair,
  OfficeConsultationProfile,
  Patient,
  PatientAuditLog,
  PatientDetail,
  PatientDocumentSummary,
  MyUserProfile,
  Office,
  Practitioner,
  UserAgendaPreferences
} from '../../core/api.types';
import { TopbarService } from '../../core/topbar.service';

declare const $: any;
declare const bootstrap: any;

type AccordionSection = 'identity' | 'patient-info' | 'antecedents' | 'documents' | 'consultations';
type AntecedentPrecision = 'date' | 'month' | 'year';
type ConsultationEditorSection = 'motifMainHtml' | 'testsHtml' | 'schemaHtml' | 'treatmentsHtml' | 'remarksHtml';
type ConsultationModalTab = 'consultation' | 'documents' | 'courriers' | 'paiement';
type ConsultationAutoSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'disabled';
type ConsultationModalMode = 'edit' | 'create';

type ConsultationReasonSelection = {
  checked: boolean;
  value: string;
  important: boolean;
};

type ConsultationUploadDocument = Omit<ConsultationDocumentUploadPayload, 'documentRef'> & {
  documentRef: string;
  tempKey: string;
};

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

const PAYMENT_PENDING_LABEL = 'Paiement en attente';

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
  private consultationAutosaveTimer: ReturnType<typeof setInterval> | null = null;
  private consultationAutosaveStatusTimer: ReturnType<typeof setInterval> | null = null;

  readonly isLoading = signal(true);
  readonly patient = signal<PatientDetail | null>(null);
  readonly consultations = signal<ConsultationRecord[]>([]);
  readonly patientDocuments = signal<PatientDocumentSummary[]>([]);
  readonly preferences = signal<UserAgendaPreferences | null>(null);

  readonly isSaving = signal(false);
  readonly saveError = signal('');
  readonly isLoadingDocuments = signal(false);
  readonly documentActionError = signal('');
  readonly isUploadingConsultationDocuments = signal(false);
  readonly documentSavingRefs = signal<Record<string, boolean>>({});
  readonly showAuditModal = signal(false);
  readonly isLoadingAuditLogs = signal(false);
  readonly auditLoadError = signal('');
  readonly auditLogs = signal<PatientAuditLog[]>([]);
  readonly activeConsultation = signal<ConsultationRecord | null>(null);
  readonly consultationModalMode = signal<ConsultationModalMode>('edit');
  readonly isSavingConsultation = signal(false);
  readonly isCreatingConsultation = signal(false);
  readonly isGeneratingConsultationPdf = signal(false);
  readonly consultationSaveError = signal('');
  readonly consultationPdfError = signal('');
  readonly consultationActiveTab = signal<ConsultationModalTab>('consultation');
  readonly consultationAutosaveState = signal<ConsultationAutoSaveState>('idle');
  readonly consultationLastSavedAt = signal<number | null>(null);
  readonly consultationAutosaveNowTick = signal(Date.now());
  readonly consultationOfficeId = signal<number | null>(null);
  readonly consultationOfficeName = signal<string | null>(null);
  readonly practitioners = signal<Practitioner[]>([]);
  readonly consultationOfficeProfiles = signal<OfficeConsultationProfile[]>([]);
  readonly consultationReasonSelections = signal<Record<string, ConsultationReasonSelection>>({});
  readonly consultationPendingDocuments = signal<ConsultationUploadDocument[]>([]);
  readonly isConsultationDocumentDragOver = signal(false);
  readonly isLoadingConsultationContext = signal(false);
  readonly consultationMotifMainHtml = signal('');
  readonly consultationTestsHtml = signal('');
  readonly consultationSchemaHtml = signal('');
  readonly consultationTreatmentsHtml = signal('');
  readonly consultationRemarksHtml = signal('');
  readonly consultationBillingChoice = signal<'bill' | 'free' | null>(null);
  readonly isConsultationBillingModalOpen = signal(false);
  readonly consultationBillingServiceOptions = signal<Array<{ label: string; amountHt: number; tvaRate: number }>>([]);
  readonly consultationBillingPaymentMethodOptions = signal<string[]>([]);

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

  readonly consultationBillingForm = this.fb.nonNullable.group({
    serviceLabel: ['Consultation d\'ostéopathie'],
    quantity: [1],
    amountHt: [55],
    tvaRate: [0],
    sex: ['Non renseigne'],
    lastName: [''],
    firstName: [''],
    mobilePhone: [''],
    email: [''],
    birthDate: [''],
    address1: [''],
    address2: [''],
    postalCode: [''],
    city: [''],
    country: ['France'],
    socialSecurityNumber: [''],
    insurance: [''],
    documentName: ['Facture acquittee'],
    additionalMentions: ['Non renseigne'],
    includeSignature: [true],
    internalComment: [''],
    paymentMethod: [PAYMENT_PENDING_LABEL]
  });

  private readonly consultationProfileValue = toSignal(
    this.consultationEditForm.controls.profile.valueChanges,
    { initialValue: this.consultationEditForm.controls.profile.value }
  );

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
    if (this.consultationModalMode() === 'create') {
      return 'Nouvelle consultation';
    }

    const consultation = this.activeConsultation();
    if (!consultation) {
      return 'Consultation';
    }

    return consultation.title.trim() || this.formatConsultationDate(consultation.startedAt);
  });

  readonly consultationStartedAtLabel = computed(() => {
    const raw = this.consultationEditForm.controls.startedAtLocal.value;
    const normalized = this.fromDateTimeLocalValue(raw) ?? new Date().toISOString();
    const parsed = new Date(normalized);
    const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  });

  readonly activeConsultationDocuments = computed(() => {
    const consultationId = this.activeConsultation()?.id;
    if (!consultationId) {
      return [];
    }

    return this.patientDocuments().filter((document) => document.consultationId === consultationId);
  });

  readonly practitionerPickerOptions = computed(() => {
    return this.practitioners().map((practitioner) => {
      const displayName = String(practitioner.displayName ?? '').trim() || practitioner.username;
      const label = `${displayName} - ${practitioner.role}`;
      return {
        username: practitioner.username,
        displayName,
        label
      };
    });
  });

  readonly consultationProfileOptions = computed(() => {
    return this.consultationOfficeProfiles().map((profile) => profile.name);
  });

  readonly consultationProfileReasons = computed(() => {
    const selectedProfile = String(this.consultationProfileValue() ?? '').trim();
    if (!selectedProfile) {
      return [];
    }

    const profile = this.consultationOfficeProfiles().find((item) => item.name === selectedProfile);
    if (!profile) {
      return [];
    }

    return profile.reasons
      .map((reason) => String(reason ?? '').trim())
      .filter((reason, index, all) => Boolean(reason) && all.indexOf(reason) === index);
  });

  readonly consultationReasonItems = computed(() => {
    return this.consultationProfileReasons().map((reason) => {
      const selection = this.consultationReasonSelections()[reason] ?? {
        checked: false,
        value: '',
        important: false
      };

      return {
        reason,
        checked: selection.checked,
        value: selection.value,
        important: selection.important
      };
    });
  });

  readonly consultationSelectedReasonItems = computed((): ConsultationReasonItem[] => {
    return this.consultationReasonItems()
      .filter((item) => item.checked)
      .map((item) => ({
        label: item.reason,
        value: item.value.trim(),
        important: item.important
      }));
  });

  readonly consultationFormBmi = computed(() => {
    const height = this.parseNullableNumber(this.consultationEditForm.controls.heightCm.value);
    const weight = this.parseNullableNumber(this.consultationEditForm.controls.weightKg.value);
    if (!height || !weight || height <= 0 || weight <= 0) {
      return null;
    }

    const value = weight / ((height / 100) ** 2);
    return Number.isFinite(value) ? value.toFixed(1) : null;
  });

  readonly consultationBillingTotalTtc = computed(() => {
    const quantity = Math.max(0, Number(this.consultationBillingForm.controls.quantity.value) || 0);
    const amountHt = Math.max(0, Number(this.consultationBillingForm.controls.amountHt.value) || 0);
    const tvaRate = Math.max(0, Number(this.consultationBillingForm.controls.tvaRate.value) || 0);
    const total = quantity * amountHt * (1 + (tvaRate / 100));
    return Number.isFinite(total) ? Number(total.toFixed(2)) : 0;
  });

  readonly isConsultationBillingPaymentPending = computed(() => {
    const value = String(this.consultationBillingForm.controls.paymentMethod.value ?? '').trim();
    return !value || value === PAYMENT_PENDING_LABEL;
  });

  readonly consultationAutosaveStatusText = computed(() => {
    if (this.consultationModalMode() === 'create') {
      return 'Nouvelle consultation non encore enregistrée';
    }

    this.consultationAutosaveNowTick();
    const frequency = this.preferences()?.patientAutoSaveFrequency ?? 'Jamais';
    const state = this.consultationAutosaveState();

    if (frequency === 'Jamais') {
      return 'Sauvegarde automatique désactivée dans votre profil';
    }

    if (state === 'saving') {
      return `Sauvegarde automatique en cours (${frequency})`;
    }

    if (state === 'error') {
      return `Échec de la sauvegarde automatique (${frequency})`;
    }

    const savedAt = this.consultationLastSavedAt();
    if (!savedAt) {
      return `Sauvegarde automatique active (${frequency})`;
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
    if (elapsedSeconds < 5) {
      return `Dernière sauvegarde à l'instant (${frequency})`;
    }
    if (elapsedSeconds < 60) {
      return `Dernière sauvegarde il y a ${elapsedSeconds}s (${frequency})`;
    }

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
      return `Dernière sauvegarde il y a ${elapsedMinutes} min (${frequency})`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    return `Dernière sauvegarde il y a ${elapsedHours} h (${frequency})`;
  });

  readonly consultationAutosaveBadgeClass = computed(() => {
    if (this.consultationModalMode() === 'create') {
      return 'text-bg-primary';
    }

    const state = this.consultationAutosaveState();
    if (state === 'saving') {
      return 'text-bg-info';
    }
    if (state === 'error') {
      return 'text-bg-danger';
    }
    if (state === 'disabled') {
      return 'text-bg-secondary';
    }
    return 'text-bg-success';
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
    this.stopConsultationAutosave();

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

  async onConsultationDocumentFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const files = input?.files;
    if (!files || files.length === 0) {
      return;
    }

    this.isConsultationDocumentDragOver.set(false);

    if (this.consultationModalMode() === 'create') {
      await this.addPendingConsultationDocuments(Array.from(files));
    } else {
      await this.uploadConsultationDocuments(Array.from(files));
    }

    input.value = '';
  }

  onConsultationDocumentDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isConsultationDocumentDragOver.set(true);
  }

  onConsultationDocumentDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isConsultationDocumentDragOver.set(false);
  }

  async onConsultationDocumentDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isConsultationDocumentDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    if (this.consultationModalMode() === 'create') {
      await this.addPendingConsultationDocuments(Array.from(files));
    } else {
      await this.uploadConsultationDocuments(Array.from(files));
    }
  }

  removePendingConsultationDocument(tempKey: string): void {
    this.consultationPendingDocuments.update((items) => items.filter((item) => item.tempKey !== tempKey));
  }

  updatePendingConsultationDocumentTitle(tempKey: string, title: string): void {
    this.consultationPendingDocuments.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, title } : item))
    );
  }

  updatePendingConsultationDocumentComment(tempKey: string, comment: string): void {
    this.consultationPendingDocuments.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, comment } : item))
    );
  }

  async saveConsultationDocumentMeta(documentRef: string, title: string, comment: string): Promise<void> {
    this.documentActionError.set('');
    this.documentSavingRefs.update((items) => ({ ...items, [documentRef]: true }));

    try {
      const updated = await this.api.updatePatientDocument(documentRef, { title, comment });
      this.patientDocuments.update((items) =>
        items.map((item) => (item.documentRef === documentRef ? { ...item, ...updated } : item))
      );
    } catch {
      this.documentActionError.set('Impossible de mettre à jour le document.');
    } finally {
      this.documentSavingRefs.update((items) => {
        const next = { ...items };
        delete next[documentRef];
        return next;
      });
    }
  }

  async deleteConsultationDocument(documentRef: string): Promise<void> {
    this.documentActionError.set('');
    this.documentSavingRefs.update((items) => ({ ...items, [documentRef]: true }));

    try {
      await this.api.deletePatientDocument(documentRef);
      this.patientDocuments.update((items) => items.filter((item) => item.documentRef !== documentRef));
    } catch {
      this.documentActionError.set('Impossible de supprimer le document.');
    } finally {
      this.documentSavingRefs.update((items) => {
        const next = { ...items };
        delete next[documentRef];
        return next;
      });
    }
  }

  isDocumentSaving(documentRef: string): boolean {
    return Boolean(this.documentSavingRefs()[documentRef]);
  }

  openConsultationModal(consultation: ConsultationRecord): void {
    if (consultation.type === 'appointment') {
      return;
    }

    this.activeConsultation.set(consultation);
    this.consultationModalMode.set('edit');
    this.consultationSaveError.set('');
    this.consultationActiveTab.set('consultation');
    this.consultationAutosaveState.set('idle');
    this.consultationLastSavedAt.set(null);
    this.consultationReasonSelections.set({});
    this.consultationPendingDocuments.set([]);
    this.consultationMotifMainHtml.set(consultation.motifMainHtml);
    this.consultationTestsHtml.set(consultation.testsHtml);
    this.consultationSchemaHtml.set(consultation.schemaHtml);
    this.consultationTreatmentsHtml.set(consultation.treatmentsHtml);
    this.consultationRemarksHtml.set(consultation.remarksHtml);
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

    this.hydrateConsultationReasonsFromRecord(consultation.reasonItems);

    this.cdr.detectChanges();

    queueMicrotask(() => {
      this.hydrateConsultationEditorsFromState();

      const modalElement = this.consultationModalRef()?.nativeElement;
      if (modalElement) {
        bootstrap.Modal.getOrCreateInstance(modalElement).show();
      }

      this.startConsultationAutosave();
    });
  }

  async openNewConsultationModal(): Promise<void> {
    const patientId = this.patient()?.id;
    if (!patientId) {
      return;
    }

    this.stopConsultationAutosave();
    this.consultationModalMode.set('create');
    this.activeConsultation.set(null);
    this.consultationSaveError.set('');
    this.consultationActiveTab.set('consultation');
    this.consultationAutosaveState.set('disabled');
    this.consultationLastSavedAt.set(null);
    this.consultationReasonSelections.set({});
    this.consultationPendingDocuments.set([]);
    this.isConsultationDocumentDragOver.set(false);
    this.consultationMotifMainHtml.set('');
    this.consultationTestsHtml.set('');
    this.consultationSchemaHtml.set('');
    this.consultationTreatmentsHtml.set('');
    this.consultationRemarksHtml.set('');

    await this.loadConsultationContext();

    const defaultProfile = this.consultationProfileOptions()[0] ?? '';
    const nowIso = new Date().toISOString();
    this.consultationEditForm.reset({
      startedAtLocal: this.toDateTimeLocalValue(nowIso),
      practitioner: this.practitionerPickerOptions()[0]?.displayName ?? '',
      title: '',
      important: false,
      heightCm: '',
      weightKg: '',
      evaBefore: 0,
      evaAfter: 0,
      profile: defaultProfile
    });

    this.setConsultationProfile(defaultProfile);
    this.cdr.detectChanges();

    queueMicrotask(() => {
      this.hydrateConsultationEditorsFromState();
      const modalElement = this.consultationModalRef()?.nativeElement;
      if (modalElement) {
        bootstrap.Modal.getOrCreateInstance(modalElement).show();
      }
    });
  }

  closeConsultationModal(): void {
    this.stopConsultationAutosave();
    const modalElement = this.consultationModalRef()?.nativeElement;
    if (modalElement) {
      bootstrap.Modal.getOrCreateInstance(modalElement).hide();
    }
  }

  setConsultationTab(tab: ConsultationModalTab): void {
    this.consultationActiveTab.set(tab);
    if (tab === 'consultation') {
      this.cdr.detectChanges();
      queueMicrotask(() => this.hydrateConsultationEditorsFromState());
    }
  }

  setConsultationProfile(value: string): void {
    const selected = value.trim();
    this.consultationEditForm.controls.profile.setValue(selected);
    const availableReasons = new Set(this.consultationProfileReasons());
    this.consultationReasonSelections.update((items) => {
      const next: Record<string, ConsultationReasonSelection> = {};
      for (const reason of availableReasons) {
        const current = items[reason];
        next[reason] = current
          ? { ...current }
          : { checked: false, value: '', important: false };
      }
      return next;
    });
  }

  setConsultationReasonChecked(reason: string, checked: boolean): void {
    const normalized = reason.trim();
    if (!normalized) {
      return;
    }

    this.consultationReasonSelections.update((items) => {
      const current = items[normalized] ?? { checked: false, value: '', important: false };
      return {
        ...items,
        [normalized]: {
          ...current,
          checked,
          value: checked ? current.value : ''
        }
      };
    });
  }

  setConsultationReasonValue(reason: string, value: string): void {
    const normalized = reason.trim();
    if (!normalized) {
      return;
    }

    const nextValue = value;
    this.consultationReasonSelections.update((items) => {
      const current = items[normalized] ?? { checked: false, value: '', important: false };
      return {
        ...items,
        [normalized]: {
          ...current,
          checked: nextValue.trim().length > 0 || current.checked,
          value: nextValue
        }
      };
    });
  }

  setConsultationReasonImportant(reason: string, important: boolean): void {
    const normalized = reason.trim();
    if (!normalized) {
      return;
    }

    this.consultationReasonSelections.update((items) => {
      const current = items[normalized] ?? { checked: false, value: '', important: false };
      return {
        ...items,
        [normalized]: {
          ...current,
          checked: current.checked || important,
          important
        }
      };
    });
  }

  applyConsultationEditorCommand(
    section: ConsultationEditorSection,
    command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList'
  ): void {
    const editor = this.getConsultationEditorElement(section);
    if (!editor) {
      return;
    }

    editor.focus();
    document.execCommand(command, false);
  }

  getEvaRangeBackground(value: number): string {
    const normalized = Math.max(0, Math.min(10, Number(value) || 0));
    const progress = normalized * 10;
    let color = '#28a745';

    if (normalized <= 5) {
      const ratio = normalized / 5;
      color = this.interpolateColor('#28a745', '#fd7e14', ratio);
    } else {
      const ratio = (normalized - 5) / 5;
      color = this.interpolateColor('#fd7e14', '#dc3545', ratio);
    }

    return `linear-gradient(90deg, ${color} 0%, ${color} ${progress}%, #d9e2ec ${progress}%, #d9e2ec 100%)`;
  }

  async saveConsultation(options: { closeOnSuccess?: boolean; isAutoSave?: boolean } = {}): Promise<void> {
    const closeOnSuccess = options.closeOnSuccess ?? true;
    const isAutoSave = options.isAutoSave ?? false;

    if (this.consultationModalMode() === 'create') {
      await this.createConsultationFromModal(closeOnSuccess);
      return;
    }

    const active = this.activeConsultation();
    if (!active || this.consultationEditForm.invalid || this.isSavingConsultation()) {
      return;
    }

    if (isAutoSave && !this.hasConsultationChanges(active)) {
      return;
    }

    this.isSavingConsultation.set(true);
    if (!isAutoSave) {
      this.consultationSaveError.set('');
    }
    this.consultationAutosaveState.set(isAutoSave ? 'saving' : 'idle');

    try {
      const payload = this.buildConsultationUpdatePayload(active);
      const updated = await this.api.updateConsultation(active.id, payload);

      this.consultations.update((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      this.activeConsultation.set(updated);
      this.consultationLastSavedAt.set(Date.now());
      this.consultationAutosaveState.set('saved');

      if (closeOnSuccess) {
        this.closeConsultationModal();
      }
    } catch {
      if (!isAutoSave) {
        this.consultationSaveError.set('Impossible d’enregistrer la consultation.');
      }
      this.consultationAutosaveState.set('error');
    } finally {
      this.isSavingConsultation.set(false);
    }
  }

  async generateConsultationSummaryPdf(): Promise<void> {
    const patient = this.patient();
    if (!patient || this.isGeneratingConsultationPdf()) {
      return;
    }

    const preferDownload = this.preferences()?.pdfDisplayMode === 'download';
    const previewWindow = !preferDownload
      ? window.open('', '_blank', 'noopener,noreferrer')
      : null;

    this.consultationPdfError.set('');
    this.isGeneratingConsultationPdf.set(true);

    try {
      const profile = await this.api.getMyUserProfile();
      const raw = this.consultationEditForm.getRawValue();
      const startedAtIso = this.fromDateTimeLocalValue(raw.startedAtLocal) ?? new Date().toISOString();
      const consultationDate = this.formatConsultationDate(startedAtIso);

      const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 14;
      const contentWidth = pageWidth - margin * 2;

      let y = margin;
      const ensureSpace = (requiredHeight: number): void => {
        if (y + requiredHeight <= pageHeight - margin) {
          return;
        }

        pdf.addPage();
        y = margin;
      };

      const writeParagraph = (text: string, fontSize = 11, spacingAfter = 4): void => {
        const normalized = this.normalizeMultilineText(text);
        if (!normalized) {
          return;
        }

        pdf.setFontSize(fontSize);
        const lines = pdf.splitTextToSize(normalized, contentWidth) as string[];
        ensureSpace(lines.length * 5 + spacingAfter);
        pdf.text(lines, margin, y);
        y += lines.length * 5 + spacingAfter;
      };

      const writeSection = (title: string, content: string): void => {
        const normalized = this.normalizeMultilineText(content);
        if (!normalized) {
          return;
        }

        ensureSpace(12);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(12);
        pdf.text(title, margin, y);
        y += 6;

        pdf.setFont('helvetica', 'normal');
        writeParagraph(normalized, 11, 6);
      };

      const letterHeader = this.normalizeMultilineText(profile.letterHeader);
      const cabinetName = this.normalizeMultilineText(profile.cabinetName || this.consultationOfficeName() || 'Cabinet');
      const headerText = letterHeader || cabinetName;

      pdf.setFont('helvetica', 'bold');
      writeParagraph(headerText, 11, 2);

      ensureSpace(8);
      pdf.setDrawColor(210, 219, 230);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 7;

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(16);
      pdf.text('Compte rendu de consultation', margin, y);
      y += 8;

      pdf.setFont('helvetica', 'normal');
      writeParagraph(`Patient : ${this.normalizeMultilineText(patient.fullName)}`, 11, 1);
      writeParagraph(`Date de consultation : ${consultationDate}`, 11, 1);
      writeParagraph(`Praticien : ${this.normalizeMultilineText(raw.practitioner || '-')}`, 11, 1);
      writeParagraph(`Titre : ${this.normalizeMultilineText(raw.title || '-')}`, 11, 4);

      const selectedReasons = this.consultationSelectedReasonItems()
        .map((item) => {
          const label = this.normalizeMultilineText(item.label);
          const value = this.normalizeMultilineText(item.value);
          const important = item.important ? ' (important)' : '';
          return value ? `- ${label} : ${value}${important}` : `- ${label}${important}`;
        })
        .join('\n');

      writeSection(
        'Informations cliniques',
        [
          `Profil : ${this.normalizeMultilineText(raw.profile || '-')}`,
          `Taille : ${this.normalizeMultilineText(raw.heightCm || '-')}`,
          `Poids : ${this.normalizeMultilineText(raw.weightKg || '-')}`,
          `EVA debut : ${Number(raw.evaBefore) || 0}/10`,
          `EVA fin : ${Number(raw.evaAfter) || 0}/10`
        ].join('\n')
      );

      writeSection('Motifs selectionnes', selectedReasons || '- Aucun motif selectionne');
      writeSection('Motif principal', this.htmlToPlainText(this.consultationMotifMainHtml()));
      writeSection('Tests', this.htmlToPlainText(this.consultationTestsHtml()));
      writeSection('Schema', this.htmlToPlainText(this.consultationSchemaHtml()));
      writeSection('Traitements proposes', this.htmlToPlainText(this.consultationTreatmentsHtml()));
      writeSection('Remarques', this.htmlToPlainText(this.consultationRemarksHtml()));

      const filename = `${this.toFileSlug(patient.fullName)}_consultation_${this.toFileSlug(consultationDate) || 'date'}.pdf`;

      if (preferDownload) {
        pdf.save(filename);
      } else {
        const blob = pdf.output('blob');
        const url = URL.createObjectURL(blob);
        if (previewWindow) {
          previewWindow.location.href = url;
        } else {
          pdf.save(filename);
        }

        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch {
      if (previewWindow && !previewWindow.closed) {
        previewWindow.close();
      }
      this.consultationPdfError.set('Impossible de générer le PDF du compte rendu.');
    } finally {
      this.isGeneratingConsultationPdf.set(false);
    }
  }

  onConsultationRichTextInput(section: ConsultationEditorSection, event: Event): void {
    const html = (event.target as HTMLDivElement).innerHTML;
    if (section === 'motifMainHtml') this.consultationMotifMainHtml.set(html);
    else if (section === 'testsHtml') this.consultationTestsHtml.set(html);
    else if (section === 'schemaHtml') this.consultationSchemaHtml.set(html);
    else if (section === 'treatmentsHtml') this.consultationTreatmentsHtml.set(html);
    else this.consultationRemarksHtml.set(html);
  }

  prepareConsultationInvoice(): void {
    this.consultationBillingChoice.set('bill');
    this.populateConsultationBillingForm();
    this.isConsultationBillingModalOpen.set(true);
  }

  markConsultationAsFreeAct(): void {
    this.consultationBillingChoice.set('free');
    this.isConsultationBillingModalOpen.set(false);
  }

  closeConsultationBillingModal(): void {
    this.isConsultationBillingModalOpen.set(false);
  }

  saveConsultationBillingDraft(): void {
    this.consultationBillingChoice.set('bill');
    this.isConsultationBillingModalOpen.set(false);
  }

  onConsultationBillingServiceChange(serviceLabel: string): void {
    const selectedLabel = String(serviceLabel ?? '').trim();
    this.consultationBillingForm.controls.serviceLabel.setValue(selectedLabel);

    const selected = this.consultationBillingServiceOptions().find((item) => item.label === selectedLabel);
    if (!selected) {
      return;
    }

    this.consultationBillingForm.patchValue({
      amountHt: selected.amountHt,
      tvaRate: selected.tvaRate
    });
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

  private async uploadConsultationDocuments(files: File[]): Promise<void> {
    const patientId = this.patient()?.id ?? null;
    const consultationId = this.activeConsultation()?.id ?? null;

    if (!patientId || !consultationId || this.isUploadingConsultationDocuments()) {
      return;
    }

    this.documentActionError.set('');
    this.isUploadingConsultationDocuments.set(true);

    try {
      for (const file of files) {
        const contentBase64 = await this.fileToBase64(file);
        const created = await this.api.createPatientDocument(patientId, {
          consultationId,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          title: file.name,
          comment: '',
          contentBase64
        });

        this.patientDocuments.update((items) => [created, ...items]);
      }
    } catch {
      this.documentActionError.set('Impossible d\'ajouter le document.');
    } finally {
      this.isUploadingConsultationDocuments.set(false);
    }
  }

  private async createConsultationFromModal(closeOnSuccess: boolean): Promise<void> {
    const patientId = this.patient()?.id ?? null;
    if (!patientId || this.consultationEditForm.invalid || this.isSavingConsultation()) {
      return;
    }

    this.isSavingConsultation.set(true);
    this.isCreatingConsultation.set(true);
    this.consultationSaveError.set('');

    try {
      const raw = this.consultationEditForm.getRawValue();
      const created = await this.api.createPatientConsultation(patientId, {
        startedAt: this.fromDateTimeLocalValue(raw.startedAtLocal) ?? new Date().toISOString(),
        practitioner: raw.practitioner,
        title: raw.title,
        important: raw.important,
        heightCm: this.parseNullableNumber(raw.heightCm),
        weightKg: this.parseNullableNumber(raw.weightKg),
        evaBefore: Number(raw.evaBefore) || 0,
        evaAfter: Number(raw.evaAfter) || 0,
        profile: raw.profile,
        reasonItems: this.consultationSelectedReasonItems(),
        motifMainHtml: this.consultationMotifMainHtml(),
        testsHtml: this.consultationTestsHtml(),
        schemaHtml: this.consultationSchemaHtml(),
        treatmentsHtml: this.consultationTreatmentsHtml(),
        remarksHtml: this.consultationRemarksHtml(),
        officeId: this.consultationOfficeId(),
        consultationDocuments: this.consultationPendingDocuments().map((doc) => ({
          documentRef: doc.documentRef,
          fileName: doc.fileName,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          title: doc.title,
          comment: doc.comment,
          contentBase64: doc.contentBase64
        }))
      });

      this.consultations.update((items) => [created, ...items]);
      this.activeConsultation.set(created);
      this.consultationModalMode.set('edit');
      this.consultationPendingDocuments.set([]);
      const docs = await this.api.getPatientDocuments(patientId);
      this.patientDocuments.set(docs);

      if (closeOnSuccess) {
        this.closeConsultationModal();
      }
    } catch {
      this.consultationSaveError.set('Impossible de créer la consultation.');
    } finally {
      this.isCreatingConsultation.set(false);
      this.isSavingConsultation.set(false);
    }
  }

  private async addPendingConsultationDocuments(files: File[]): Promise<void> {
    if (this.isUploadingConsultationDocuments()) {
      return;
    }

    this.documentActionError.set('');
    this.isUploadingConsultationDocuments.set(true);
    try {
      const created: ConsultationUploadDocument[] = [];
      for (const file of files) {
        const contentBase64 = await this.fileToBase64(file);
        created.push({
          tempKey: this.createTempKey('consultation-doc'),
          documentRef: this.createDocumentRef(),
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          title: file.name,
          comment: '',
          contentBase64
        });
      }

      this.consultationPendingDocuments.update((items) => [...items, ...created]);
    } catch {
      this.documentActionError.set('Impossible d\'ajouter le document.');
    } finally {
      this.isUploadingConsultationDocuments.set(false);
    }
  }

  private createDocumentRef(): string {
    const random = Math.random().toString(36).slice(2, 10);
    return `doc_${Date.now().toString(36)}_${random}`;
  }

  private createTempKey(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private async loadConsultationContext(): Promise<void> {
    if (this.isLoadingConsultationContext()) {
      return;
    }

    this.isLoadingConsultationContext.set(true);
    try {
      const context: ConsultationContextPayload = await this.api.getConsultationContext();
      this.consultationOfficeId.set(context.officeId ?? null);
      this.consultationOfficeName.set(context.officeName ?? null);
      this.practitioners.set(Array.isArray(context.practitioners) ? context.practitioners : []);
      this.consultationOfficeProfiles.set(Array.isArray(context.profiles) ? context.profiles : []);
      await this.loadConsultationBillingCatalog(context.officeId ?? null);
    } catch {
      this.consultationOfficeId.set(null);
      this.consultationOfficeName.set(null);
      this.practitioners.set([]);
      this.consultationOfficeProfiles.set([]);
      this.consultationBillingServiceOptions.set([]);
      this.consultationBillingPaymentMethodOptions.set([]);
    } finally {
      this.isLoadingConsultationContext.set(false);
    }
  }

  private async loadConsultationBillingCatalog(contextOfficeId: number | null): Promise<void> {
    try {
      const offices = await this.api.getOffices();
      const contextId = Number.isInteger(contextOfficeId) && Number(contextOfficeId) > 0
        ? Number(contextOfficeId)
        : null;

      const office = (contextId !== null
        ? offices.find((item) => item.id === contextId)
        : undefined) ?? null;

      this.applyBillingCatalogFromOffice(office);
    } catch {
      this.consultationBillingServiceOptions.set([]);
      this.consultationBillingPaymentMethodOptions.set([]);
      this.applyConsultationBillingDefaults();
    }
  }

  private applyBillingCatalogFromOffice(office: Office | null): void {
    const serviceOptions = (office?.serviceTypes ?? [])
      .map((item) => ({
        label: String(item.label ?? '').trim(),
        amountHt: Number(item.amountHt) || 0,
        tvaRate: Number(item.vatRate) || 0,
        displayOrder: Number(item.displayOrder) || 0
      }))
      .filter((item) => Boolean(item.label))
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(({ displayOrder: _displayOrder, ...rest }) => rest);

    const paymentMethods = (office?.paymentMethods ?? [])
      .filter((item) => item.isActive)
      .map((item) => ({
        label: String(item.label ?? '').trim(),
        displayOrder: Number(item.displayOrder) || 0
      }))
      .filter((item) => Boolean(item.label))
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((item) => item.label);

    this.consultationBillingServiceOptions.set(serviceOptions);
    this.consultationBillingPaymentMethodOptions.set(paymentMethods);
    this.applyConsultationBillingDefaults();
  }

  private applyConsultationBillingDefaults(): void {
    const services = this.consultationBillingServiceOptions();
    const paymentMethods = this.consultationBillingPaymentMethodOptions();
    const currentServiceLabel = String(this.consultationBillingForm.controls.serviceLabel.value ?? '').trim();
    const currentPaymentMethod = String(this.consultationBillingForm.controls.paymentMethod.value ?? '').trim();

    const selectedService = services.find((item) => item.label === currentServiceLabel) ?? services[0] ?? null;
    if (selectedService) {
      this.consultationBillingForm.patchValue({
        serviceLabel: selectedService.label,
        amountHt: selectedService.amountHt,
        tvaRate: selectedService.tvaRate
      });
    }

    const resolvedPayment = paymentMethods.includes(currentPaymentMethod)
      ? currentPaymentMethod
      : PAYMENT_PENDING_LABEL;
    this.consultationBillingForm.controls.paymentMethod.setValue(resolvedPayment);
  }

  private hydrateConsultationReasonsFromRecord(reasonItems: ConsultationReasonItem[]): void {
    const next: Record<string, ConsultationReasonSelection> = {};
    for (const item of reasonItems ?? []) {
      const label = String(item?.label ?? '').trim();
      if (!label) {
        continue;
      }

      next[label] = {
        checked: true,
        value: String(item?.value ?? ''),
        important: Boolean(item?.important)
      };
    }

    this.consultationReasonSelections.set(next);
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const marker = 'base64,';
        const markerIndex = result.indexOf(marker);
        resolve(markerIndex >= 0 ? result.slice(markerIndex + marker.length) : result);
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  private hasConsultationChanges(active: ConsultationRecord): boolean {
    const current = this.buildConsultationUpdatePayload(active);
    const baseline: ConsultationUpdatePayload = {
      startedAt: active.startedAt,
      practitioner: active.practitioner,
      title: active.title,
      important: active.important,
      heightCm: active.heightCm,
      weightKg: active.weightKg,
      evaBefore: active.evaBefore,
      evaAfter: active.evaAfter,
      profile: active.profile,
      reasonItems: active.reasonItems,
      motifMainHtml: active.motifMainHtml,
      testsHtml: active.testsHtml,
      schemaHtml: active.schemaHtml,
      treatmentsHtml: active.treatmentsHtml,
      remarksHtml: active.remarksHtml
    };

    return JSON.stringify(current) !== JSON.stringify(baseline);
  }

  private buildConsultationUpdatePayload(active: ConsultationRecord): ConsultationUpdatePayload {
    const raw = this.consultationEditForm.getRawValue();
    return {
      startedAt: this.fromDateTimeLocalValue(raw.startedAtLocal) ?? active.startedAt,
      practitioner: raw.practitioner,
      title: raw.title,
      important: raw.important,
      heightCm: this.parseNullableNumber(raw.heightCm),
      weightKg: this.parseNullableNumber(raw.weightKg),
      evaBefore: Number(raw.evaBefore) || 0,
      evaAfter: Number(raw.evaAfter) || 0,
      profile: raw.profile,
      reasonItems: this.consultationSelectedReasonItems(),
      motifMainHtml: this.consultationMotifMainHtml(),
      testsHtml: this.consultationTestsHtml(),
      schemaHtml: this.consultationSchemaHtml(),
      treatmentsHtml: this.consultationTreatmentsHtml(),
      remarksHtml: this.consultationRemarksHtml()
    };
  }

  private startConsultationAutosave(): void {
    this.stopConsultationAutosave();
    this.consultationAutosaveNowTick.set(Date.now());

    const intervalMs = this.getConsultationAutosaveIntervalMs();
    if (intervalMs === null) {
      this.consultationAutosaveState.set('disabled');
      return;
    }

    this.consultationAutosaveState.set('idle');
    this.consultationAutosaveStatusTimer = setInterval(() => {
      this.consultationAutosaveNowTick.set(Date.now());
    }, 1000);

    this.consultationAutosaveTimer = setInterval(() => {
      if (!this.activeConsultation()) {
        return;
      }
      void this.saveConsultation({ closeOnSuccess: false, isAutoSave: true });
    }, intervalMs);
  }

  private stopConsultationAutosave(): void {
    if (this.consultationAutosaveTimer !== null) {
      clearInterval(this.consultationAutosaveTimer);
      this.consultationAutosaveTimer = null;
    }

    if (this.consultationAutosaveStatusTimer !== null) {
      clearInterval(this.consultationAutosaveStatusTimer);
      this.consultationAutosaveStatusTimer = null;
    }
  }

  private getConsultationAutosaveIntervalMs(): number | null {
    const frequency = this.preferences()?.patientAutoSaveFrequency ?? 'Jamais';
    if (frequency === 'Toutes les 2 minutes') {
      return 2 * 60 * 1000;
    }
    if (frequency === 'Toutes les 5 minutes') {
      return 5 * 60 * 1000;
    }
    if (frequency === 'Toutes les 10 minutes') {
      return 10 * 60 * 1000;
    }
    return null;
  }

  private interpolateColor(startHex: string, endHex: string, ratio: number): string {
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const start = this.hexToRgb(startHex);
    const end = this.hexToRgb(endHex);

    const red = Math.round(start.red + (end.red - start.red) * clampedRatio);
    const green = Math.round(start.green + (end.green - start.green) * clampedRatio);
    const blue = Math.round(start.blue + (end.blue - start.blue) * clampedRatio);

    return `rgb(${red}, ${green}, ${blue})`;
  }

  private hexToRgb(hex: string): { red: number; green: number; blue: number } {
    const normalized = hex.replace('#', '');
    const chunkSize = normalized.length === 3 ? 1 : 2;
    const parts = normalized.length === 3
      ? normalized.split('').map((part) => part + part)
      : normalized.match(/.{1,2}/g) ?? ['00', '00', '00'];

    const [redHex, greenHex, blueHex] = parts;
    return {
      red: parseInt(redHex.slice(0, chunkSize === 1 ? 2 : redHex.length), 16) || 0,
      green: parseInt(greenHex.slice(0, chunkSize === 1 ? 2 : greenHex.length), 16) || 0,
      blue: parseInt(blueHex.slice(0, chunkSize === 1 ? 2 : blueHex.length), 16) || 0
    };
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

  private hydrateConsultationEditorsFromState(): void {
    this.setConsultationEditorContent('motifMainHtml', this.consultationMotifMainHtml());
    this.setConsultationEditorContent('testsHtml', this.consultationTestsHtml());
    this.setConsultationEditorContent('schemaHtml', this.consultationSchemaHtml());
    this.setConsultationEditorContent('treatmentsHtml', this.consultationTreatmentsHtml());
    this.setConsultationEditorContent('remarksHtml', this.consultationRemarksHtml());
  }

  private setConsultationEditorContent(section: ConsultationEditorSection, html: string): void {
    const element = this.getConsultationEditorElement(section);
    if (element) {
      element.innerHTML = html || '';
    }
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

  private populateConsultationBillingForm(): void {
    const patient = this.patient();
    const activeSex = this.editSexValue();
    this.consultationBillingForm.patchValue({
      sex: activeSex,
      lastName: this.editForm.controls.lastName.value,
      firstName: this.editForm.controls.firstName.value,
      mobilePhone: this.editForm.controls.mobilePhone.value,
      email: this.editForm.controls.email.value,
      birthDate: this.editForm.controls.birthDate.value,
      address1: this.editForm.controls.address1.value,
      address2: this.editForm.controls.address2.value,
      postalCode: this.editForm.controls.postalCode.value,
      city: this.editForm.controls.city.value,
      country: this.editForm.controls.country.value || 'France',
      socialSecurityNumber: this.editForm.controls.socialSecurityNumber.value,
      insurance: '',
      documentName: 'Facture acquittee',
      internalComment: '',
      paymentMethod: PAYMENT_PENDING_LABEL,
      amountHt: this.consultationBillingForm.controls.amountHt.value || 55,
      quantity: this.consultationBillingForm.controls.quantity.value || 1,
      tvaRate: this.consultationBillingForm.controls.tvaRate.value || 0
    });

    if (patient?.firstName || patient?.lastName) {
      this.consultationBillingForm.controls.lastName.setValue(patient?.lastName ?? this.consultationBillingForm.controls.lastName.value);
      this.consultationBillingForm.controls.firstName.setValue(patient?.firstName ?? this.consultationBillingForm.controls.firstName.value);
    }

    this.applyConsultationBillingDefaults();
  }

  private htmlToPlainText(html: string): string {
    const withBreaks = String(html ?? '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/p\s*>/gi, '\n\n')
      .replace(/<\s*li\s*>/gi, '- ')
      .replace(/<\s*\/li\s*>/gi, '\n');

    const container = globalThis.document.createElement('div');
    container.innerHTML = withBreaks;
    return this.normalizeMultilineText(container.textContent ?? '');
  }

  private normalizeMultilineText(value: string): string {
    return String(value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private toFileSlug(value: string): string {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
}