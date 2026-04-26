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
  CreatePatientConsultationPayload,
  ConsultationDocumentUploadPayload,
  ConsultationRecord,
  ConsultationReasonItem,
  ConsultationUpdatePayload,
  LocationPair,
  OfficeConsultationProfile,
  Patient,
  PatientAntecedentRecord,
  PatientAuditLog,
  PatientDetail,
  PatientDocumentSummary,
  MyUserProfile,
  Office,
  PeoplePickerContact,
  Practitioner,
  UserAgendaPreferences
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { TopbarService } from '../../core/topbar.service';

declare const $: any;
declare const bootstrap: any;

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
  isRecent: boolean;
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

type ConsultationPaymentStatus = 'paid' | 'partial' | 'pending';

type ConsultationPaymentEntry = {
  id: string;
  amount: number;
  currency: string;
  method: string;
  bankName: string;
  chequeNumber: string;
  comment: string;
  paidAt: string;
};

type ConsultationBillingState = {
  consultationId: number;
  billingInvoiceId: number | null;
  invoiceNumber: string;
  totalAmount: number;
  currency: string;
  issuedAt: string;
  internalComment: string;
  practitionerName: string;
  invoiceDocumentRef: string;
  paymentStatus: ConsultationPaymentStatus;
  payments: ConsultationPaymentEntry[];
};

const PAYMENT_PENDING_LABEL = 'Paiement en attente';
const CONSULTATION_BILLING_STORAGE_KEY = 'osteosoft:consultation-billing:v1';

@Component({
  selector: 'app-patient-detail-page',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './patient-detail.page.html',
  styleUrl: './patient-detail.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientDetailPage implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly topbar = inject(TopbarService);
  private readonly cdr = inject(ChangeDetectorRef);

  private readonly birthDateInputRef = viewChild<ElementRef<HTMLInputElement>>('birthDateInput');
  private readonly antecedentDateInputRef = viewChild<ElementRef<HTMLInputElement>>('antecedentDateInputRef');
  private readonly consultationModalRef = viewChild<ElementRef<HTMLDivElement>>('consultationModal');
  private readonly consultationMotifMainEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationMotifMainEditor');
  private readonly consultationTestsEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationTestsEditor');
  private readonly consultationSchemaEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationSchemaEditor');
  private readonly consultationTreatmentsEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationTreatmentsEditor');
  private readonly consultationRemarksEditorRef = viewChild<ElementRef<HTMLDivElement>>('consultationRemarksEditor');

  private isViewReady = false;
  private isDatepickerInitialized = false;
  private antecedentDatepickerMode: AntecedentPrecision | null = null;
  private pendingBirthDateIso = '';
  private pendingFocusedConsultationId: number | null = null;
  private relatedSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private relatedSearchRequestId = 0;
  private primaryDoctorSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private primaryDoctorSearchRequestId = 0;
  private patientAutosaveTimer: ReturnType<typeof setInterval> | null = null;
  private consultationAutosaveTimer: ReturnType<typeof setInterval> | null = null;
  private consultationAutosaveStatusTimer: ReturnType<typeof setInterval> | null = null;
  private autosaveToastHideTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveToastLastShownAt = 0;
  private isPersistingConsultationDraft = false;
  private pendingConsultationDraftSave = false;

  readonly isLoading = signal(true);
  readonly patient = signal<PatientDetail | null>(null);
  readonly consultations = signal<ConsultationRecord[]>([]);
  readonly patientDocuments = signal<PatientDocumentSummary[]>([]);
  readonly preferences = signal<UserAgendaPreferences | null>(null);

  readonly isSaving = signal(false);
  readonly saveError = signal('');
  readonly isLoadingDocuments = signal(false);
  readonly documentActionError = signal('');
  readonly isAutoSavingPatient = signal(false);
  readonly isUploadingPatientDocuments = signal(false);
  readonly isPatientDocumentDragOver = signal(false);
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
  private loadConsultationContextPromise: Promise<void> | null = null;
  private hydrateConsultationBillingStatePromises: Map<number, Promise<void>> = new Map();
  readonly consultationMotifMainHtml = signal('');
  readonly consultationTestsHtml = signal('');
  readonly consultationSchemaHtml = signal('');
  readonly consultationTreatmentsHtml = signal('');
  readonly consultationRemarksHtml = signal('');
  readonly consultationBillingChoice = signal<'bill' | 'free' | null>(null);
  readonly isConsultationBillingModalOpen = signal(false);
  readonly isGeneratingConsultationInvoice = signal(false);
  readonly consultationBillingServiceOptions = signal<Array<{ label: string; amountHt: number; tvaRate: number }>>([]);
  readonly consultationBillingPaymentMethodOptions = signal<string[]>([]);
  readonly consultationBillingStates = signal<Record<number, ConsultationBillingState>>({});
  readonly isConsultationPaymentModalOpen = signal(false);
  readonly isSavingConsultationPayment = signal(false);
  readonly editingConsultationPaymentId = signal<string | null>(null);
  readonly autosaveToastVisible = signal(false);
  readonly autosaveToastMessage = signal('');

  readonly showRelatedPicker = signal(false);
  readonly relatedSearch = signal('');
  readonly relatedSearchResults = signal<Patient[]>([]);
  readonly selectedRelatedPatients = signal<Patient[]>([]);
  readonly isSearchingRelated = signal(false);
  readonly primaryDoctorSearch = signal('');
  readonly primaryDoctorSuggestions = signal<PeoplePickerContact[]>([]);
  readonly isSearchingPrimaryDoctor = signal(false);
  readonly locationPairs = signal<LocationPair[]>([]);
  readonly postalCodeSuggestions = signal<string[]>([]);
  readonly citySuggestions = signal<string[]>([]);
  readonly showPostalCodeSuggestions = signal(false);
  readonly showCitySuggestions = signal(false);
  readonly isAntecedentModalOpen = signal(false);
  readonly antecedentError = signal('');
  readonly antecedentDatePrecision = signal<AntecedentPrecision>('date');
  readonly antecedentDateDisplay = signal('');
  readonly antecedentCategory = signal('');
  readonly antecedentDescription = signal('');
  readonly antecedentImportant = signal(false);
  readonly editingAntecedentId = signal<string | null>(null);
  readonly structuredAntecedents = signal<AntecedentTimelineItem[] | null>(null);
  readonly antecedentCategoryOptions = signal<string[]>([
    'Cardiologie',
    'Endocrinologie',
    'Gastro-entérologie',
    'Neurologie',
    'Orthopédie',
    'Psychologie',
    'Pneumologie',
    'Rhumatologie'
  ]);

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

  readonly consultationPaymentEditForm = this.fb.nonNullable.group({
    amount: ['0'],
    method: [''],
    bankName: [''],
    chequeNumber: [''],
    comment: [''],
    paidAtLocal: ['']
  });

  private readonly consultationProfileValue = toSignal(
    this.consultationEditForm.controls.profile.valueChanges,
    { initialValue: this.consultationEditForm.controls.profile.value }
  );
  private readonly consultationHeightValue = toSignal(
    this.consultationEditForm.controls.heightCm.valueChanges,
    { initialValue: this.consultationEditForm.controls.heightCm.value }
  );
  private readonly consultationWeightValue = toSignal(
    this.consultationEditForm.controls.weightKg.valueChanges,
    { initialValue: this.consultationEditForm.controls.weightKg.value }
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

  readonly antecedents = computed(() => {
    const structured = this.structuredAntecedents();
    if (structured !== null) {
      return structured;
    }
    return this.parseAntecedents(this.patient()?.medicalHistory ?? '');
  });

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
        label: 'Consultations récentes',
        consultations: ungrouped,
        collapseId: 'consultation-recent-group',
        initiallyOpen: true,
        isRecent: true
      });
    }

    const yearGroups = [...groupedByYear.entries()]
      .sort((left, right) => (order === 'Chronologique' ? left[0] - right[0] : right[0] - left[0]))
      .map(([year, consultations]) => ({
        key: `year-${year}`,
        label: String(year),
        consultations,
        collapseId: `consultation-year-${year}`,
        initiallyOpen: false,
        isRecent: false
      }));

    groups.push(...yearGroups);

    if (order === 'Chronologique' && ungrouped.length > 0) {
      groups.push({
        key: 'recent',
        label: 'Consultations récentes',
        consultations: ungrouped,
        collapseId: 'consultation-recent-group',
        initiallyOpen: groups.length === 0,
        isRecent: true
      });
    }

    if (groups.length === 0 && ungrouped.length > 0) {
      groups.push({
        key: 'all',
        label: 'Consultations',
        consultations: ungrouped,
        collapseId: 'consultation-all-group',
        initiallyOpen: true,
        isRecent: true
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
    const height = this.parseNullableNumber(this.consultationHeightValue());
    const weight = this.parseNullableNumber(this.consultationWeightValue());
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

  readonly activeConsultationBillingState = computed<ConsultationBillingState | null>(() => {
    const consultationId = this.activeConsultation()?.id;
    if (!consultationId) {
      return null;
    }

    return this.consultationBillingStates()[consultationId] ?? null;
  });

  readonly consultationAutosaveStatusText = computed(() => {
    if (this.consultationModalMode() === 'create') {
      const frequency = this.preferences()?.patientAutoSaveFrequency ?? 'Jamais';
      if (frequency === 'Jamais') {
        return 'Sauvegarde automatique désactivée dans votre profil';
      }

      const state = this.consultationAutosaveState();
      if (state === 'saving') {
        return `Sauvegarde du brouillon en cours (${frequency})`;
      }
      if (state === 'error') {
        return `Échec de la sauvegarde du brouillon (${frequency})`;
      }

      const savedAt = this.consultationLastSavedAt();
      if (!savedAt) {
        return `Nouvelle consultation — brouillon auto activé (${frequency})`;
      }

      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
      if (elapsedSeconds < 5) {
        return `Brouillon sauvegardé à l'instant (${frequency})`;
      }
      if (elapsedSeconds < 60) {
        return `Brouillon sauvegardé il y a ${elapsedSeconds}s (${frequency})`;
      }

      const elapsedMinutes = Math.floor(elapsedSeconds / 60);
      if (elapsedMinutes < 60) {
        return `Brouillon sauvegardé il y a ${elapsedMinutes} min (${frequency})`;
      }

      const elapsedHours = Math.floor(elapsedMinutes / 60);
      return `Brouillon sauvegardé il y a ${elapsedHours} h (${frequency})`;
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
    this.stopPatientAutosave();
    this.stopConsultationAutosave();
    this.clearAutosaveToastTimer();

    const input = this.birthDateInputRef()?.nativeElement;
    if (input) {
      try {
        $(input).datepicker('destroy');
      } catch {
        // ignore
      }
    }

    this.destroyAntecedentDatepicker();

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

  openAntecedentModal(): void {
    this.isAntecedentModalOpen.set(true);
    this.antecedentError.set('');
    this.editingAntecedentId.set(null);
    this.antecedentDatePrecision.set('date');
    this.antecedentDateDisplay.set('');
    this.antecedentCategory.set('');
    this.antecedentDescription.set('');
    this.antecedentImportant.set(false);
    queueMicrotask(() => this.initAntecedentDatepicker(true));
  }

  openAntecedentEditModal(id: string): void {
    const current = this.antecedents().find((item) => item.id === id);
    if (!current) {
      return;
    }

    this.isAntecedentModalOpen.set(true);
    this.antecedentError.set('');
    this.editingAntecedentId.set(current.id);
    this.antecedentDatePrecision.set(current.precision);
    this.antecedentDateDisplay.set(current.dateDisplay);
    this.antecedentCategory.set(current.category);
    this.antecedentDescription.set(current.description === 'Détail non renseigné' ? '' : current.description);
    this.antecedentImportant.set(current.important);
    queueMicrotask(() => this.initAntecedentDatepicker(true));
  }

  closeAntecedentModal(): void {
    this.destroyAntecedentDatepicker();
    this.isAntecedentModalOpen.set(false);
    this.antecedentError.set('');
    this.editingAntecedentId.set(null);
  }

  setAntecedentPrecision(precision: AntecedentPrecision): void {
    this.antecedentDatePrecision.set(precision);
    this.antecedentDateDisplay.set('');
    queueMicrotask(() => this.initAntecedentDatepicker(true));
  }

  setAntecedentCategory(value: string): void {
    this.antecedentCategory.set(value);
  }

  setAntecedentDescription(value: string): void {
    this.antecedentDescription.set(value);
  }

  setAntecedentImportant(value: boolean): void {
    this.antecedentImportant.set(value);
  }

  addAntecedent(): void {
    const dateDisplay = this.antecedentDateDisplay().trim();
    const category = this.antecedentCategory().trim();
    const description = this.antecedentDescription().trim();

    if (!dateDisplay || !category) {
      this.antecedentError.set('La date et le type d\'antécédent sont obligatoires.');
      return;
    }

    const precision = this.antecedentDatePrecision();
    const sortKey = this.buildAntecedentSortKey(precision, dateDisplay);
    if (sortKey === null) {
      this.antecedentError.set('Le format de date est invalide pour la précision choisie.');
      return;
    }

    const editingId = this.editingAntecedentId();
    const normalizedDescription = description || 'Détail non renseigné';
    const nextItem: AntecedentTimelineItem = {
      id: editingId ?? this.createTempKey('antecedent'),
      category,
      description: normalizedDescription,
      dateDisplay,
      precision,
      sortKey,
      important: this.antecedentImportant()
    };

    const baseItems = this.antecedents();
    const items = (editingId
      ? baseItems.map((item) => (item.id === editingId ? nextItem : item))
      : [...baseItems, nextItem]
    ).sort((left, right) => right.sortKey - left.sortKey);

    this.syncMedicalHistoryFromAntecedents(items);
    this.ensureAntecedentOption(category);
    this.closeAntecedentModal();
  }

  removeAntecedent(id: string): void {
    const next = this.antecedents().filter((item) => item.id !== id);
    this.syncMedicalHistoryFromAntecedents(next);
  }

  getAntecedentDateLabel(item: AntecedentTimelineItem): string {
    if (!item.dateDisplay) {
      return 'Date non renseignée';
    }
    if (item.precision === 'month') {
      return `Mois ${item.dateDisplay}`;
    }
    if (item.precision === 'year') {
      return `Année ${item.dateDisplay}`;
    }
    return item.dateDisplay;
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

  onPrimaryDoctorSearchChange(value: string): void {
    this.primaryDoctorSearch.set(value);
    this.editForm.controls.primaryDoctor.setValue(value.trim());

    if (this.primaryDoctorSearchDebounceId !== null) {
      clearTimeout(this.primaryDoctorSearchDebounceId);
      this.primaryDoctorSearchDebounceId = null;
    }

    const term = value.trim();
    if (term.length < 2) {
      this.primaryDoctorSuggestions.set([]);
      this.isSearchingPrimaryDoctor.set(false);
      return;
    }

    this.isSearchingPrimaryDoctor.set(true);
    this.primaryDoctorSearchDebounceId = setTimeout(() => {
      void this.searchPrimaryDoctorSuggestions(term);
    }, 250);
  }

  applyPrimaryDoctorSuggestion(contact: PeoplePickerContact): void {
    this.editForm.controls.primaryDoctor.setValue(contact.fullName);
    this.primaryDoctorSearch.set(contact.fullName);
    this.primaryDoctorSuggestions.set([]);
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

  async saveEdit(options?: { isAutoSave?: boolean }): Promise<void> {
    const isAutoSave = options?.isAutoSave === true;
    if (this.editForm.invalid || (isAutoSave ? this.isAutoSavingPatient() : this.isSaving())) {
      return;
    }

    const patient = this.patient();
    if (!patient) {
      return;
    }

    if (isAutoSave) {
      if (!this.editForm.dirty || this.isSaving()) {
        return;
      }
      this.isAutoSavingPatient.set(true);
    } else {
      this.isSaving.set(true);
      this.saveError.set('');
    }

    const payload = this.buildPatientUpdatePayload();

    try {
      await this.api.updatePatient(patient.id, payload);
      this.applyPatientSnapshot(payload);

      if (isAutoSave) {
        this.editForm.markAsPristine();
        this.showAutosaveToast('Fiche patient sauvegardée automatiquement');
      } else {
        await this.load(patient.id);
      }
    } catch {
      if (!isAutoSave) {
        this.saveError.set('Une erreur est survenue lors de la sauvegarde.');
      }
    } finally {
      if (isAutoSave) {
        this.isAutoSavingPatient.set(false);
      } else {
        this.isSaving.set(false);
      }
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

  async onPatientDocumentFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const files = input?.files;
    if (!files || files.length === 0) {
      return;
    }

    this.isPatientDocumentDragOver.set(false);
    await this.uploadPatientDocuments(Array.from(files));
    input.value = '';
  }

  onPatientDocumentDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isPatientDocumentDragOver.set(true);
  }

  onPatientDocumentDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isPatientDocumentDragOver.set(false);
  }

  async onPatientDocumentDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isPatientDocumentDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    await this.uploadPatientDocuments(Array.from(files));
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
      const currentStates = this.consultationBillingStates();
      const nextStates: Record<number, ConsultationBillingState> = {};
      let changed = false;

      for (const [key, value] of Object.entries(currentStates)) {
        if (value.invoiceDocumentRef === documentRef) {
          changed = true;
          continue;
        }

        nextStates[Number(key)] = value;
      }

      if (changed) {
        this.consultationBillingStates.set(nextStates);
        this.persistConsultationBillingStates();
      }
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

  private getConsultationModalInstance(): any {
    const modalElement = this.consultationModalRef()?.nativeElement;
    if (!modalElement) {
      return null;
    }
    return bootstrap.Modal.getOrCreateInstance(modalElement, { focus: false });
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
    void this.loadConsultationContext();
    void this.hydrateConsultationBillingState(consultation);

    this.cdr.detectChanges();

    queueMicrotask(() => {
      this.hydrateConsultationEditorsFromState();

      this.getConsultationModalInstance()?.show();

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
    this.consultationAutosaveState.set('idle');
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
    const defaultPractitioner = this.getDefaultConsultationPractitioner(this.practitioners());
    this.consultationEditForm.reset({
      startedAtLocal: this.toDateTimeLocalValue(nowIso),
      practitioner: defaultPractitioner?.displayName ?? defaultPractitioner?.username ?? '',
      title: '',
      important: false,
      heightCm: '',
      weightKg: '',
      evaBefore: 0,
      evaAfter: 0,
      profile: defaultProfile
    });

    this.setConsultationProfile(defaultProfile);

    try {
      const draft = await this.api.getNewConsultationDraft(patientId);
      if (draft?.payload) {
        const payload = draft.payload;
        const draftStartedAt = this.fromDateTimeLocalValue(this.toDateTimeLocalValue(payload.startedAt)) ?? payload.startedAt;
        this.consultationEditForm.reset({
          startedAtLocal: this.toDateTimeLocalValue(draftStartedAt),
          practitioner: payload.practitioner,
          title: payload.title,
          important: payload.important,
          heightCm: payload.heightCm != null ? String(payload.heightCm) : '',
          weightKg: payload.weightKg != null ? String(payload.weightKg) : '',
          evaBefore: payload.evaBefore,
          evaAfter: payload.evaAfter,
          profile: payload.profile || defaultProfile
        });
        this.consultationOfficeId.set(payload.officeId ?? this.consultationOfficeId());
        this.setConsultationProfile(payload.profile || defaultProfile);
        this.hydrateConsultationReasonsFromRecord(payload.reasonItems ?? []);
        this.consultationMotifMainHtml.set(payload.motifMainHtml ?? '');
        this.consultationTestsHtml.set(payload.testsHtml ?? '');
        this.consultationSchemaHtml.set(payload.schemaHtml ?? '');
        this.consultationTreatmentsHtml.set(payload.treatmentsHtml ?? '');
        this.consultationRemarksHtml.set(payload.remarksHtml ?? '');
        this.consultationPendingDocuments.set(
          (payload.consultationDocuments ?? []).map((doc) => ({
            tempKey: this.createTempKey('consultation-doc-draft'),
            documentRef: doc.documentRef || this.createDocumentRef(),
            fileName: doc.fileName,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
            title: doc.title,
            comment: doc.comment,
            contentBase64: doc.contentBase64
          }))
        );

        const updatedAtMs = Number(new Date(draft.updatedAt));
        if (!Number.isNaN(updatedAtMs)) {
          this.consultationLastSavedAt.set(updatedAtMs);
          this.consultationAutosaveState.set('saved');
        }
      }
    } catch {
      // Keep modal creation resilient if draft loading fails.
    }

    this.cdr.detectChanges();

    queueMicrotask(() => {
      this.hydrateConsultationEditorsFromState();
      this.getConsultationModalInstance()?.show();
      this.startConsultationAutosave();
    });
  }

  private getDefaultConsultationPractitioner(practitioners: Practitioner[]): { username: string; displayName: string } | null {
    const sessionUsername = this.authService.username().trim().toLowerCase();
    const normalizedPractitioners = Array.isArray(practitioners) ? practitioners : [];
    if (sessionUsername) {
      const sessionMatch = normalizedPractitioners.find((item) => item.username.trim().toLowerCase() === sessionUsername);
      if (sessionMatch) {
        const displayName = String(sessionMatch.displayName ?? '').trim() || sessionMatch.username;
        return {
          username: sessionMatch.username,
          displayName
        };
      }

      return {
        username: this.authService.username().trim(),
        displayName: this.authService.username().trim()
      };
    }

    if (normalizedPractitioners[0]) {
      const displayName = String(normalizedPractitioners[0].displayName ?? '').trim() || normalizedPractitioners[0].username;
      return {
        username: normalizedPractitioners[0].username,
        displayName
      };
    }

    return null;
  }

  private applyDefaultConsultationPractitioner(force = false): void {
    const currentValue = String(this.consultationEditForm.controls.practitioner.value ?? '').trim();
    if (!force && currentValue) {
      return;
    }

    const practitioner = this.getDefaultConsultationPractitioner(this.practitioners());
    const nextValue = practitioner?.displayName ?? '';

    this.consultationEditForm.controls.practitioner.setValue(nextValue);
  }

  closeConsultationModal(): void {
    this.stopConsultationAutosave();
    this.getConsultationModalInstance()?.hide();
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
      if (isAutoSave) {
        await this.persistNewConsultationDraft();
      } else {
        await this.createConsultationFromModal(closeOnSuccess);
      }
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
      if (isAutoSave) {
        this.showAutosaveToast('Consultation sauvegardée automatiquement');
      }

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

  async saveConsultationDraftNow(): Promise<void> {
    if (this.consultationModalMode() !== 'create') {
      return;
    }

    await this.persistNewConsultationDraft({ manual: true });
  }

  async generateConsultationSummaryPdf(): Promise<void> {
    const patient = this.patient();
    if (!patient || this.isGeneratingConsultationPdf()) {
      return;
    }

    const preferDownload = this.preferences()?.pdfDisplayMode === 'download';
    const previewWindow = !preferDownload
      ? window.open('about:blank', '_blank')
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
          const fallbackWindow = window.open(url, '_blank');
          if (!fallbackWindow) {
            window.location.assign(url);
          }
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

  async prepareConsultationInvoice(): Promise<void> {
    await this.loadConsultationContext();
    this.consultationBillingChoice.set('bill');
    if (!this.activeConsultationBillingState()) {
      this.populateConsultationBillingForm();
    }
    this.isConsultationBillingModalOpen.set(true);
  }

  isConsultationPaymentPending(): boolean {
    if (this.consultationBillingChoice() === 'free') {
      return false;
    }

    const billing = this.activeConsultationBillingState();
    if (!billing) {
      return true;
    }

    return billing.paymentStatus !== 'paid';
  }

  markConsultationAsFreeAct(): void {
    this.consultationBillingChoice.set('free');
    this.isConsultationBillingModalOpen.set(false);
  }

  closeConsultationBillingModal(): void {
    this.isConsultationBillingModalOpen.set(false);
  }

  async saveConsultationBillingDraft(): Promise<void> {
    const patient = this.patient();
    if (!patient || this.isGeneratingConsultationInvoice()) {
      return;
    }

    // If the consultation has not been saved yet (create mode), save it first so we
    // have a real consultation ID to attach the invoice to.
    if (this.consultationModalMode() === 'create') {
      await this.createConsultationFromModal(false);
      // If the consultation still has no ID after the save attempt, abort billing.
      if (!this.activeConsultation()?.id) {
        return;
      }
    }

    this.consultationBillingChoice.set('bill');
    this.isGeneratingConsultationInvoice.set(true);
    this.documentActionError.set('');

    try {
      const offices = await this.api.getOffices();
      const office = this.resolveConsultationBillingOffice(offices);
      if (!office) {
        this.documentActionError.set('Aucun cabinet actif trouvé pour appliquer le template de facture.');
        return;
      }
      const profile = await this.api.getMyUserProfile();
      const nowIso = new Date().toISOString();
      const invoiceNumber = this.generateConsultationInvoiceNumber(office, profile, new Date(nowIso));
      const pdfBlob = await this.buildConsultationInvoicePdfBlob(office, profile, nowIso, invoiceNumber);
      const base64 = await this.blobToBase64(pdfBlob);

      const raw = this.consultationBillingForm.getRawValue();
      const rawName = String(raw.documentName ?? '').trim() || 'Facture acquittee';
      const fileName = rawName.toLowerCase().endsWith('.pdf') ? rawName : `${rawName}.pdf`;
      const paymentMethod = String(raw.paymentMethod ?? '').trim();
      const currency = String(office.devise ?? 'EUR').trim() || 'EUR';
      const totalAmount = this.consultationBillingTotalTtc();
      const serviceLabel = String(raw.serviceLabel ?? '').trim() || 'Consultation';
      const quantity = Number(raw.quantity ?? 1);
      const amountHt = Number(raw.amountHt ?? 0);
      const tvaRate = Number(raw.tvaRate ?? 0);
      const paymentComment = String(raw.internalComment ?? '').trim() || 'Paiement enregistre lors de la facturation';
      const status: ConsultationPaymentStatus = !paymentMethod || paymentMethod === PAYMENT_PENDING_LABEL
        ? 'pending'
        : 'paid';
      const payments: ConsultationPaymentEntry[] = status === 'paid'
        ? [
          {
            id: this.createTempKey('pay'),
            amount: totalAmount,
            currency,
            method: paymentMethod,
            bankName: '',
            chequeNumber: '',
            comment: paymentComment,
            paidAt: nowIso
          }
        ]
        : [];

      const created = await this.api.createPatientDocument(patient.id, {
        consultationId: this.activeConsultation()?.id ?? null,
        officeId: office.id,
        fileName,
        mimeType: 'application/pdf',
        sizeBytes: pdfBlob.size,
        title: rawName,
        comment: String(raw.internalComment ?? '').trim(),
        contentBase64: base64
      });

      this.patientDocuments.update((items) => [created, ...items]);
      const consultationId = this.activeConsultation()?.id;
      if (consultationId) {
        const practitionerName = String(this.consultationEditForm.controls.practitioner.value ?? '').trim() || '-';
        this.upsertConsultationBillingState({
          consultationId,
          billingInvoiceId: null,
          invoiceNumber,
          totalAmount,
          currency,
          issuedAt: nowIso,
          internalComment: String(raw.internalComment ?? '').trim(),
          practitionerName,
          invoiceDocumentRef: created.documentRef,
          paymentStatus: status,
          payments
        });

        // Record the invoice in the accounting table so it shows in Comptabilite.
        try {
          const invoiceId = await this.api.createBillingInvoice({
            patientId: patient.id,
            consultationId,
            officeId: office.id,
            invoiceNumber,
            amountCents: Math.round(totalAmount * 100),
            status: status === 'paid' ? 'payee' : 'impayee',
            paymentMethod,
            issuedAt: nowIso,
            currency,
            notes: String(raw.internalComment ?? '').trim(),
            lineItems: [{
              label: serviceLabel,
              quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
              unitAmountHtCents: Math.max(0, Math.round(amountHt * 100)),
              vatRate: Number.isFinite(tvaRate) ? tvaRate : 0,
              displayOrder: 0
            }],
            payments: payments.map((payment) => ({
              paidAt: payment.paidAt,
              amountCents: Math.max(0, Math.round(payment.amount * 100)),
              currency: payment.currency,
              paymentMethod: payment.method,
              bankName: payment.bankName,
              chequeNumber: payment.chequeNumber,
              notes: payment.comment
            }))
          });
          this.upsertConsultationBillingState({
            ...this.consultationBillingStates()[consultationId],
            billingInvoiceId: invoiceId
          });
        } catch {
          // Non-blocking: PDF is already saved; accounting record will be retried next time.
        }
      }

      this.isConsultationBillingModalOpen.set(false);
    } catch {
      this.documentActionError.set('Impossible de générer la facture PDF pour cette consultation.');
    } finally {
      this.isGeneratingConsultationInvoice.set(false);
    }
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

  async downloadFinalizedConsultationInvoice(): Promise<void> {
    const billing = this.activeConsultationBillingState();
    if (!billing) {
      return;
    }

    const document = this.patientDocuments().find((item) => item.documentRef === billing.invoiceDocumentRef);
    if (!document) {
      this.documentActionError.set('Facture introuvable dans les documents de la consultation.');
      return;
    }

    await this.openPatientDocument(document);
  }

  isConsultationPdfDownloadPreferred(): boolean {
    return this.preferences()?.pdfDisplayMode === 'download';
  }

  async cancelConsultationInvoice(): Promise<void> {
    const billing = this.activeConsultationBillingState();
    if (!billing) {
      return;
    }

    this.documentActionError.set('');
    const documentRef = String(billing.invoiceDocumentRef ?? '').trim();
    if (documentRef) {
      try {
        await this.api.deletePatientDocument(documentRef);
        this.patientDocuments.update((items) => items.filter((item) => item.documentRef !== documentRef));
      } catch {
        this.documentActionError.set('Impossible d\'annuler la facture pour le moment.');
        return;
      }
    }

    if (billing.billingInvoiceId != null) {
      try {
        await this.api.deleteBillingInvoice(billing.billingInvoiceId);
      } catch {
        // Best-effort: document already removed, accounting record may need manual cleanup.
      }
    }

    this.consultationBillingStates.update((items) => {
      const next = { ...items };
      delete next[billing.consultationId];
      return next;
    });

    this.persistConsultationBillingStates();
    this.consultationBillingChoice.set(null);
  }

  async openConsultationPaymentEditModal(paymentId: string): Promise<void> {
    const activeConsult = this.activeConsultation();
    if (!activeConsult) {
      return;
    }

    // Ensure both context and billing state are ready
    await this.loadConsultationContext();
    await this.hydrateConsultationBillingState(activeConsult);

    const billing = this.activeConsultationBillingState();
    if (!billing) {
      return;
    }

    const payment = billing.payments.find((entry) => entry.id === paymentId);
    if (!payment) {
      return;
    }

    const availableMethods = this.getConsultationPaymentMethodOptions();
    const resolvedMethod = availableMethods.includes(payment.method)
      ? payment.method
      : (availableMethods[0] ?? '');

    this.editingConsultationPaymentId.set(payment.id);
    this.consultationPaymentEditForm.reset({
      amount: String(payment.amount),
      method: resolvedMethod,
      bankName: String(payment.bankName ?? '').trim(),
      chequeNumber: String(payment.chequeNumber ?? '').trim(),
      comment: String(payment.comment ?? '').trim(),
      paidAtLocal: this.toDateTimeLocalValue(payment.paidAt)
    });
    this.isConsultationPaymentModalOpen.set(true);
  }

  async openConsultationPaymentCreateModal(): Promise<void> {
    const activeConsult = this.activeConsultation();
    if (!activeConsult) {
      return;
    }

    // Ensure both context and billing state are ready
    await this.loadConsultationContext();
    await this.hydrateConsultationBillingState(activeConsult);

    const billing = this.activeConsultationBillingState();
    if (!billing) {
      return;
    }

    const availableMethods = this.getConsultationPaymentMethodOptions();

    const totalPaid = billing.payments.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    const remaining = Math.max(0, Number((billing.totalAmount - totalPaid).toFixed(2)));

    this.editingConsultationPaymentId.set(null);
    this.consultationPaymentEditForm.reset({
      amount: String(remaining),
      method: availableMethods[0] ?? '',
      bankName: '',
      chequeNumber: '',
      comment: '',
      paidAtLocal: this.toDateTimeLocalValue(new Date().toISOString())
    });
    this.isConsultationPaymentModalOpen.set(true);
  }

  closeConsultationPaymentEditModal(): void {
    this.isConsultationPaymentModalOpen.set(false);
    this.editingConsultationPaymentId.set(null);
    this.consultationPaymentEditForm.reset({
      amount: '0',
      method: '',
      bankName: '',
      chequeNumber: '',
      comment: '',
      paidAtLocal: ''
    });
  }

  async saveConsultationPaymentEdit(): Promise<void> {
    const billing = this.activeConsultationBillingState();
    const paymentId = this.editingConsultationPaymentId();
    if (!billing || this.isSavingConsultationPayment()) {
      return;
    }

    const raw = this.consultationPaymentEditForm.getRawValue();
    const amount = this.parsePaymentAmount(raw.amount);
    const method = String(raw.method ?? '').trim();
    const bankName = String(raw.bankName ?? '').trim();
    const chequeNumber = String(raw.chequeNumber ?? '').trim();
    const comment = String(raw.comment ?? '').trim();
    const isCheque = this.isChequePaymentMethod(method);
    const paidAt = this.fromDateTimeLocalValue(raw.paidAtLocal);

    if (!method || amount <= 0 || !paidAt || (isCheque && (!bankName || !chequeNumber))) {
      return;
    }

    const nextPayments = paymentId
      ? billing.payments.map((entry) =>
        entry.id === paymentId
          ? {
            ...entry,
            amount,
            method,
            bankName: isCheque ? bankName : '',
            chequeNumber: isCheque ? chequeNumber : '',
            comment,
            paidAt
          }
          : entry
      )
      : [
        ...billing.payments,
        {
          id: this.createTempKey('pay'),
          amount,
          currency: billing.currency,
          method,
          bankName: isCheque ? bankName : '',
          chequeNumber: isCheque ? chequeNumber : '',
          comment,
          paidAt
        }
      ];

    this.isSavingConsultationPayment.set(true);
    this.documentActionError.set('');

    try {
      const invoiceId = Number(billing.billingInvoiceId);
      if (Number.isInteger(invoiceId) && invoiceId > 0) {
        const invoice = await this.api.updateBillingInvoicePayments(invoiceId, {
          payments: nextPayments.map((entry) => ({
            paidAt: entry.paidAt,
            amountCents: Math.max(0, Math.round(entry.amount * 100)),
            currency: entry.currency,
            paymentMethod: entry.method,
            bankName: entry.bankName,
            chequeNumber: entry.chequeNumber,
            notes: String(entry.comment ?? "").trim()
          }))
        });
        this.upsertConsultationBillingState(
          this.mapInvoiceDetailToConsultationBillingState(
            billing.consultationId,
            billing.practitionerName,
            billing.invoiceDocumentRef,
            invoice
          )
        );
      } else {
        this.upsertConsultationBillingState({
          ...billing,
          payments: nextPayments,
          paymentStatus: this.computeConsultationPaymentStatus(billing.totalAmount, nextPayments)
        });
      }

      this.closeConsultationPaymentEditModal();
    } catch {
      this.documentActionError.set('Impossible de mettre à jour le paiement pour le moment.');
    } finally {
      this.isSavingConsultationPayment.set(false);
    }
  }

  async deleteConsultationPayment(paymentId: string): Promise<void> {
    const billing = this.activeConsultationBillingState();
    if (!billing || this.isSavingConsultationPayment()) {
      return;
    }

    const nextPayments = billing.payments.filter((entry) => entry.id !== paymentId);
    this.isSavingConsultationPayment.set(true);
    this.documentActionError.set('');

    try {
      const invoiceId = Number(billing.billingInvoiceId);
      if (Number.isInteger(invoiceId) && invoiceId > 0) {
        const invoice = await this.api.updateBillingInvoicePayments(invoiceId, {
          payments: nextPayments.map((entry) => ({
            paidAt: entry.paidAt,
            amountCents: Math.max(0, Math.round(entry.amount * 100)),
            currency: entry.currency,
            paymentMethod: entry.method,
            bankName: entry.bankName,
            chequeNumber: entry.chequeNumber,
            notes: String(entry.comment ?? "").trim()
          }))
        });
        this.upsertConsultationBillingState(
          this.mapInvoiceDetailToConsultationBillingState(
            billing.consultationId,
            billing.practitionerName,
            billing.invoiceDocumentRef,
            invoice
          )
        );
      } else {
        this.upsertConsultationBillingState({
          ...billing,
          payments: nextPayments,
          paymentStatus: this.computeConsultationPaymentStatus(billing.totalAmount, nextPayments)
        });
      }
    } catch {
      this.documentActionError.set('Impossible de supprimer le paiement pour le moment.');
    } finally {
      this.isSavingConsultationPayment.set(false);
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

  getConsultationBillingPaidAmount(billing: ConsultationBillingState): number {
    const total = billing.payments.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    return Number(total.toFixed(2));
  }

  getConsultationPaymentMethodOptions(): string[] {
    const values = this.consultationBillingPaymentMethodOptions()
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);

    return [...new Set(values)];
  }

  getConsultationPaymentValidationError(): string {
    const raw = this.consultationPaymentEditForm.getRawValue();
    const amount = this.parsePaymentAmount(raw.amount);
    if (amount <= 0) {
      return 'Saisissez un montant supérieur à 0.';
    }

    const method = String(raw.method ?? '').trim();
    if (!method) {
      return 'Sélectionnez un moyen de paiement.';
    }

    if (this.isChequePaymentMethod(method)) {
      const bankName = String(raw.bankName ?? '').trim();
      if (!bankName) {
        return 'Renseignez la banque du chèque.';
      }

      const chequeNumber = String(raw.chequeNumber ?? '').trim();
      if (!chequeNumber) {
        return 'Renseignez le numero du chèque.';
      }
    }

    const allowedMethods = this.getConsultationPaymentMethodOptions();
    if (allowedMethods.length === 0) {
      return 'Aucun moyen de paiement actif n\'est configuré pour ce cabinet.';
    }

    if (!allowedMethods.includes(method)) {
      return 'Le moyen de paiement doit faire partie des moyens actifs du cabinet.';
    }

    const paidAtRaw = String(raw.paidAtLocal ?? '').trim();
    if (!paidAtRaw) {
      return 'Renseignez la date et heure du paiement.';
    }

    if (!this.fromDateTimeLocalValue(paidAtRaw)) {
      return 'Date et heure de paiement invalides.';
    }

    return '';
  }

  getConsultationBillingRemainingAmount(billing: ConsultationBillingState): number {
    const remaining = Math.max(0, billing.totalAmount - this.getConsultationBillingPaidAmount(billing));
    return Number(remaining.toFixed(2));
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
    this.structuredAntecedents.set(null);

    try {
      const [patient, consultations, documents, preferences, antecedents] = await Promise.all([
        this.api.getPatientDetail(id),
        this.api.getPatientConsultations(id),
        this.api.getPatientDocuments(id),
        this.api.getMyAgendaPreferences(),
        this.api.getPatientAntecedents(id).catch(() => [])
      ]);

      this.patient.set(patient);
      this.consultations.set(consultations);
      this.patientDocuments.set(documents);
      this.preferences.set(preferences);
      this.structuredAntecedents.set(
        antecedents.length > 0
          ? this.mapStructuredAntecedentsToTimelineItems(antecedents)
          : null
      );
      this.startEdit();
      this.startPatientAutosave();
      this.primeConsultationBillingStates(consultations);

      queueMicrotask(() => {
        if (this.pendingFocusedConsultationId != null) {
          this.focusConsultationById(this.pendingFocusedConsultationId);
        }
      });
    } catch {
      this.patient.set(null);
      this.consultations.set([]);
      this.patientDocuments.set([]);
      this.structuredAntecedents.set(null);
      this.stopPatientAutosave();
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
    this.primaryDoctorSearch.set(patient.primaryDoctor ?? '');
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
        city: '',
        consultationCount: 0
      }))
    );

    void this.enrichRelatedPatientsWithRealData(names);
  }

  private async enrichRelatedPatientsWithRealData(names: string[]): Promise<void> {
    if (names.length === 0) {
      return;
    }

    const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

    await Promise.all(
      names.map(async (name) => {
        try {
          const results = await this.api.getPatients(name);
          const match = results.find((p) => normalize(p.fullName) === normalize(name));
          if (match) {
            this.selectedRelatedPatients.update((items) =>
              items.map((item) => (normalize(item.fullName) === normalize(name) && item.id < 0 ? match : item))
            );
          }
        } catch (error) {
          console.error(`[enrichRelatedPatients] Failed to look up patient "${name}":`, error);
        }
      })
    );

    this.cdr.markForCheck();
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

  private async searchPrimaryDoctorSuggestions(term: string): Promise<void> {
    const requestId = ++this.primaryDoctorSearchRequestId;
    try {
      const contacts = await this.api.searchPeopleContacts(term);
      if (requestId !== this.primaryDoctorSearchRequestId) {
        return;
      }

      this.primaryDoctorSuggestions.set(contacts.slice(0, 8));
    } catch {
      if (requestId !== this.primaryDoctorSearchRequestId) {
        return;
      }
      this.primaryDoctorSuggestions.set([]);
    } finally {
      if (requestId === this.primaryDoctorSearchRequestId) {
        this.isSearchingPrimaryDoctor.set(false);
      }
    }
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

  private initAntecedentDatepicker(forceReinit = false): void {
    const input = this.antecedentDateInputRef()?.nativeElement;
    if (!input) {
      return;
    }

    const precision = this.antecedentDatePrecision();
    if (!forceReinit && this.antecedentDatepickerMode === precision) {
      return;
    }

    this.destroyAntecedentDatepicker();

    const format = precision === 'date' ? 'dd/mm/yyyy' : precision === 'month' ? 'mm/yyyy' : 'yyyy';
    const minViewMode = precision === 'date' ? 0 : precision === 'month' ? 1 : 2;

    $(input).datepicker({
      language: 'fr',
      format,
      minViewMode,
      container: 'body',
      autoclose: true,
      todayHighlight: true,
      weekStart: 1,
      startView: 2,
      endDate: new Date()
    }).on('changeDate', (event: { date: Date }) => {
      const date = event.date;
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return;
      }

      const value = precision === 'date'
        ? `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`
        : precision === 'month'
          ? `${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`
          : String(date.getFullYear());

      this.antecedentDateDisplay.set(value);
      this.cdr.markForCheck();
    });

    this.antecedentDatepickerMode = precision;
    this.applyAntecedentDateToPicker();
  }

  private destroyAntecedentDatepicker(): void {
    const input = this.antecedentDateInputRef()?.nativeElement;
    if (!input) {
      this.antecedentDatepickerMode = null;
      return;
    }

    try {
      $(input).datepicker('destroy');
    } catch {
      // ignore
    }

    this.antecedentDatepickerMode = null;
  }

  private applyAntecedentDateToPicker(): void {
    const input = this.antecedentDateInputRef()?.nativeElement;
    const raw = this.antecedentDateDisplay().trim();
    if (!input || !raw) {
      return;
    }

    const date = this.parseAntecedentDisplayToDate(this.antecedentDatePrecision(), raw);
    if (!date) {
      return;
    }

    try {
      $(input).datepicker('setDate', date);
    } catch {
      // ignore
    }
  }

  private parseAntecedentDisplayToDate(precision: AntecedentPrecision, display: string): Date | null {
    if (precision === 'year') {
      const year = Number(display);
      if (!Number.isInteger(year)) {
        return null;
      }
      const date = new Date(year, 0, 1);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    if (precision === 'month') {
      const match = display.match(/^(\d{2})\/(\d{4})$/);
      if (!match) {
        return null;
      }
      const month = Number(match[1]);
      const year = Number(match[2]);
      if (!Number.isInteger(month) || !Number.isInteger(year) || month < 1 || month > 12) {
        return null;
      }
      const date = new Date(year, month - 1, 1);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const match = display.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
      return null;
    }

    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }

    return date;
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

  private buildAntecedentSortKey(precision: AntecedentPrecision, display: string): number | null {
    if (precision === 'year') {
      const year = Number(display);
      if (!Number.isInteger(year)) {
        return null;
      }
      return year * 10000 + 1231;
    }

    if (precision === 'month') {
      const [monthStr, yearStr] = display.split('/');
      const month = Number(monthStr);
      const year = Number(yearStr);
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return null;
      }
      return year * 10000 + month * 100 + 31;
    }

    const [dayStr, monthStr, yearStr] = display.split('/');
    const day = Number(dayStr);
    const month = Number(monthStr);
    const year = Number(yearStr);
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31
    ) {
      return null;
    }

    return year * 10000 + month * 100 + day;
  }

  private syncMedicalHistoryFromAntecedents(items: AntecedentTimelineItem[]): void {
    const sortedItems = [...items].sort((left, right) => right.sortKey - left.sortKey);
    const serialized = sortedItems.map((item) => ({
      id: item.id,
      datePrecision: item.precision,
      date: item.dateDisplay,
      category: item.category,
      description: item.description,
      important: item.important,
      sortKey: item.sortKey
    }));

    const value = JSON.stringify(serialized);
    this.structuredAntecedents.set(sortedItems);
    this.editForm.controls.medicalHistory.setValue(value);
    this.editForm.controls.medicalHistory.markAsDirty();

    this.patient.update((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        medicalHistory: value
      };
    });
  }

  private mapStructuredAntecedentsToTimelineItems(records: PatientAntecedentRecord[]): AntecedentTimelineItem[] {
    return records
      .map((record) => ({
        id: `db-${record.id}`,
        category: String(record.category ?? '').trim() || 'Antécédent',
        description: String(record.description ?? '').trim() || 'Détail non renseigné',
        dateDisplay: String(record.date ?? '').trim(),
        precision: record.datePrecision,
        sortKey: Number(record.sortKey) || 0,
        important: Boolean(record.important)
      }))
      .filter((item) => item.dateDisplay.length > 0 && item.category.length > 0)
      .sort((left, right) => right.sortKey - left.sortKey);
  }

  private ensureAntecedentOption(category: string): void {
    const normalized = String(category ?? '').trim();
    if (!normalized) {
      return;
    }

    this.antecedentCategoryOptions.update((items) => {
      if (items.includes(normalized)) {
        return items;
      }
      return [...items, normalized].sort((left, right) => left.localeCompare(right, 'fr'));
    });
  }

  private focusConsultationById(consultationId: number): void {
    const consultation = this.consultationRecords().find((entry) => entry.id === consultationId);
    if (!consultation) {
      return;
    }

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

  private async uploadPatientDocuments(files: File[]): Promise<void> {
    if (this.isUploadingPatientDocuments()) {
      return;
    }

    const patientId = this.patient()?.id;
    if (!patientId) {
      return;
    }

    this.documentActionError.set('');
    this.isUploadingPatientDocuments.set(true);

    try {
      const createdDocuments: PatientDocumentSummary[] = [];

      for (const file of files) {
        const contentBase64 = await this.fileToBase64(file);
        const created = await this.api.createPatientDocument(patientId, {
          consultationId: null,
          officeId: this.consultationOfficeId(),
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          title: file.name,
          comment: '',
          contentBase64
        });

        createdDocuments.push(created);
      }

      this.patientDocuments.update((items) => [...createdDocuments, ...items]);
    } catch {
      this.documentActionError.set('Impossible d\'ajouter le document patient.');
    } finally {
      this.isUploadingPatientDocuments.set(false);
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
    this.consultationAutosaveState.set('idle');

    try {
      const created = await this.api.createPatientConsultation(patientId, this.buildCreateConsultationPayload());

      this.consultations.update((items) => [created, ...items]);
      this.activeConsultation.set(created);
      this.consultationModalMode.set('edit');
      this.consultationLastSavedAt.set(Date.now());
      this.consultationAutosaveState.set('saved');
      this.consultationPendingDocuments.set([]);
      const docs = await this.api.getPatientDocuments(patientId);
      this.patientDocuments.set(docs);

      try {
        await this.api.deleteNewConsultationDraft(patientId);
      } catch {
        // The consultation is already created; draft cleanup failure must stay non-blocking.
      }

      if (closeOnSuccess) {
        this.closeConsultationModal();
      }
    } catch {
      this.consultationAutosaveState.set('idle');
      this.consultationSaveError.set('Impossible de créer la consultation.');
    } finally {
      this.isCreatingConsultation.set(false);
      this.isSavingConsultation.set(false);
    }
  }

  private buildCreateConsultationPayload(): CreatePatientConsultationPayload {
    const raw = this.consultationEditForm.getRawValue();

    return {
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
    };
  }

  private hasCreateConsultationDraftChanges(): boolean {
    return this.consultationEditForm.dirty
      || Boolean(this.consultationMotifMainHtml().trim())
      || Boolean(this.consultationTestsHtml().trim())
      || Boolean(this.consultationSchemaHtml().trim())
      || Boolean(this.consultationTreatmentsHtml().trim())
      || Boolean(this.consultationRemarksHtml().trim())
      || this.consultationPendingDocuments().length > 0
      || this.consultationSelectedReasonItems().length > 0;
  }

  private async persistNewConsultationDraft(options?: { manual?: boolean }): Promise<void> {
    const isManual = options?.manual === true;

    if (this.consultationModalMode() !== 'create') {
      return;
    }

    const patientId = this.patient()?.id ?? null;
    if (!patientId || this.consultationEditForm.invalid) {
      return;
    }

    if (!this.hasCreateConsultationDraftChanges()) {
      return;
    }

    if (this.isPersistingConsultationDraft) {
      this.pendingConsultationDraftSave = true;
      return;
    }

    this.isPersistingConsultationDraft = true;
    this.consultationAutosaveState.set('saving');
    try {
      await this.api.saveNewConsultationDraft(patientId, this.buildCreateConsultationPayload());
      this.consultationLastSavedAt.set(Date.now());
      this.consultationAutosaveState.set('saved');
      if (isManual) {
        this.showAutosaveToast('Brouillon de consultation sauvegardé', { force: true });
      } else {
        this.showAutosaveToast('Brouillon de consultation sauvegardé automatiquement');
      }
    } catch {
      this.consultationAutosaveState.set('error');
    } finally {
      this.isPersistingConsultationDraft = false;
      if (this.pendingConsultationDraftSave) {
        this.pendingConsultationDraftSave = false;
        void this.persistNewConsultationDraft();
      }
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
    if (this.loadConsultationContextPromise) {
      return this.loadConsultationContextPromise;
    }

    this.isLoadingConsultationContext.set(true);
    this.loadConsultationContextPromise = (async () => {
      try {
        const preferredOfficeId = this.resolvePreferredConsultationOfficeId();
        const context: ConsultationContextPayload = await this.api.getConsultationContext(preferredOfficeId);
        this.consultationOfficeId.set(context.officeId ?? null);
        this.consultationOfficeName.set(context.officeName ?? null);
        this.practitioners.set(Array.isArray(context.practitioners) ? context.practitioners : []);
        this.consultationOfficeProfiles.set(Array.isArray(context.profiles) ? context.profiles : []);
        if (this.consultationModalMode() === 'create') {
          this.applyDefaultConsultationPractitioner();
        }
        if (Array.isArray(context.paymentMethods)) {
          const serviceOptions = (context.serviceTypes ?? [])
            .map((item) => ({
              label: String(item.label ?? '').trim(),
              amountHt: Number(item.amountHt) || 0,
              tvaRate: Number(item.vatRate) || 0
            }))
            .filter((item) => Boolean(item.label));
          this.consultationBillingServiceOptions.set(serviceOptions);
          this.consultationBillingPaymentMethodOptions.set(
            context.paymentMethods.map((m) => String(m ?? '').trim()).filter(Boolean)
          );
          this.applyConsultationBillingDefaults();
        } else {
          await this.loadConsultationBillingCatalog(context.officeId ?? preferredOfficeId ?? null);
        }
      } catch {
        this.consultationOfficeId.set(null);
        this.consultationOfficeName.set(null);
        this.practitioners.set([]);
        this.consultationOfficeProfiles.set([]);
        this.consultationBillingServiceOptions.set([]);
        this.consultationBillingPaymentMethodOptions.set([]);
      } finally {
        this.isLoadingConsultationContext.set(false);
        this.loadConsultationContextPromise = null;
      }
    })();

    return this.loadConsultationContextPromise;
  }

  private async loadConsultationBillingCatalog(contextOfficeId: number | null): Promise<void> {
    try {
      const offices = await this.api.getOffices();
      const preferredOfficeId = this.resolvePreferredConsultationOfficeId();
      const requestedOfficeId = Number.isInteger(contextOfficeId) && Number(contextOfficeId) > 0
        ? Number(contextOfficeId)
        : (Number.isInteger(preferredOfficeId) && Number(preferredOfficeId) > 0 ? Number(preferredOfficeId) : null);

      const contextId = Number.isInteger(requestedOfficeId) && Number(requestedOfficeId) > 0
        ? Number(requestedOfficeId)
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

  private resolvePreferredConsultationOfficeId(): number | null {
    const activeOfficeId = this.authService.activeOfficeId();
    if (Number.isInteger(activeOfficeId) && Number(activeOfficeId) > 0) {
      return Number(activeOfficeId);
    }

    const contextOfficeId = this.consultationOfficeId();
    return Number.isInteger(contextOfficeId) && Number(contextOfficeId) > 0
      ? Number(contextOfficeId)
      : null;
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
      if (this.consultationModalMode() === 'edit' && !this.activeConsultation()) {
        return;
      }
      void this.saveConsultation({ closeOnSuccess: false, isAutoSave: true });
    }, intervalMs);
  }

  private startPatientAutosave(): void {
    this.stopPatientAutosave();
    const intervalMs = this.getAutoSaveIntervalMs();
    if (intervalMs === null) {
      return;
    }

    this.patientAutosaveTimer = setInterval(() => {
      void this.saveEdit({ isAutoSave: true });
    }, intervalMs);
  }

  private stopPatientAutosave(): void {
    if (this.patientAutosaveTimer !== null) {
      clearInterval(this.patientAutosaveTimer);
      this.patientAutosaveTimer = null;
    }
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
    return this.getAutoSaveIntervalMs();
  }

  private getAutoSaveIntervalMs(): number | null {
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

  private buildPatientUpdatePayload(): ReturnType<typeof this.editForm.getRawValue> {
    const { relatedPeople, ...rest } = this.editForm.getRawValue();
    return {
      ...rest,
      relatedPeople: this.editForm.controls.relatedPeople.value
    };
  }

  private applyPatientSnapshot(payload: ReturnType<typeof this.editForm.getRawValue>): void {
    this.patient.update((current) => {
      if (!current) {
        return current;
      }

      const fullName = [payload.firstName, payload.lastName].map((item) => item.trim()).filter(Boolean).join(' ');
      const phone = String(payload.mobilePhone ?? '').trim() || String(payload.landlinePhone ?? '').trim();

      return {
        ...current,
        ...payload,
        fullName: fullName || current.fullName,
        phone
      };
    });
  }

  private showAutosaveToast(message: string, options?: { force?: boolean }): void {
    const now = Date.now();
    const force = options?.force === true;
    if (!force && now - this.autosaveToastLastShownAt < 15000) {
      return;
    }

    this.autosaveToastLastShownAt = now;
    this.autosaveToastMessage.set(message);
    this.autosaveToastVisible.set(true);

    this.clearAutosaveToastTimer();
    this.autosaveToastHideTimer = setTimeout(() => {
      this.autosaveToastVisible.set(false);
      this.autosaveToastHideTimer = null;
    }, 2600);
  }

  private clearAutosaveToastTimer(): void {
    if (this.autosaveToastHideTimer !== null) {
      clearTimeout(this.autosaveToastHideTimer);
      this.autosaveToastHideTimer = null;
    }
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

  private resolveConsultationBillingOffice(offices: Office[]): Office | null {
    const contextOfficeId = this.consultationOfficeId();
    if (Number.isInteger(contextOfficeId) && Number(contextOfficeId) > 0) {
      const contextOffice = offices.find((item) => item.id === Number(contextOfficeId));
      if (contextOffice) {
        return contextOffice;
      }
    }

    return null;
  }

  private primeConsultationBillingStates(consultations: ConsultationRecord[]): void {
    const billableConsultations = consultations.filter((consultation) => {
      if (consultation.type === 'appointment') {
        return false;
      }

      const billingInvoiceId = Number(consultation.billingInvoiceId);
      return Number.isInteger(billingInvoiceId) && billingInvoiceId > 0;
    });

    for (const consultation of billableConsultations) {
      void this.hydrateConsultationBillingState(consultation);
    }
  }

  private async hydrateConsultationBillingState(consultation: ConsultationRecord): Promise<void> {
    const consultationId = Number(consultation.id);
    if (!Number.isInteger(consultationId) || consultationId <= 0) {
      return;
    }

    // If already hydrating, return the existing promise
    const existingPromise = this.hydrateConsultationBillingStatePromises.get(consultationId);
    if (existingPromise) {
      return existingPromise;
    }

    // Create and store the hydration promise
    const hydrationPromise = (async () => {
      const states = this.consultationBillingStates();
      const billingInvoiceId = Number(consultation.billingInvoiceId);
      const hasValidInvoiceId = Number.isInteger(billingInvoiceId) && billingInvoiceId > 0;

      if (states[consultationId]) {
        // Only skip re-fetch if the cached state already reflects the current invoice,
        // or if this consultation has no invoice at all.
        if (!hasValidInvoiceId || states[consultationId].billingInvoiceId === billingInvoiceId) {
          return;
        }
      }
      if (hasValidInvoiceId) {
        try {
          const invoice = await this.api.getBillingInvoice(billingInvoiceId);
          const invoiceDocumentRef = this.resolveConsultationInvoiceDocumentRef(consultationId, invoice.issuedAt);

          this.consultationBillingStates.update((items) => ({
            ...items,
            [consultationId]: this.mapInvoiceDetailToConsultationBillingState(
              consultationId,
              consultation.practitioner || '-',
              invoiceDocumentRef,
              invoice
            )
          }));
          this.persistConsultationBillingStates();
          this.consultationBillingChoice.set('bill');
          return;
        } catch {
          // Fall back to locally persisted billing state.
        }
      }

      const persisted = this.readPersistedConsultationBillingStates();
      const state = persisted[consultationId];
      if (!state) {
        return;
      }

      this.consultationBillingStates.update((items) => ({
        ...items,
        [consultationId]: state
      }));
      this.consultationBillingChoice.set('bill');
    })();

    this.hydrateConsultationBillingStatePromises.set(consultationId, hydrationPromise);
    try {
      await hydrationPromise;
    } finally {
      this.hydrateConsultationBillingStatePromises.delete(consultationId);
    }
  }

  private mapInvoiceDetailToConsultationBillingState(
    consultationId: number,
    practitionerName: string,
    invoiceDocumentRef: string,
    invoice: Awaited<ReturnType<ApiService['getBillingInvoice']>>
  ): ConsultationBillingState {
    return {
      consultationId,
      billingInvoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: Number((invoice.amountCents / 100).toFixed(2)),
      currency: invoice.payments[0]?.currency || 'EUR',
      issuedAt: invoice.issuedAt,
      internalComment: invoice.notes,
      practitionerName,
      invoiceDocumentRef,
      paymentStatus: this.computeConsultationPaymentStatus(
        Number((invoice.amountCents / 100).toFixed(2)),
        invoice.payments.map((entry) => ({
          id: `db-pay-${entry.id}`,
          amount: Number((entry.amountCents / 100).toFixed(2)),
          currency: entry.currency,
          method: entry.paymentMethod,
          bankName: String(entry.bankName ?? '').trim(),
          chequeNumber: String(entry.chequeNumber ?? '').trim(),
          comment: String(entry.notes ?? '').trim(),
          paidAt: entry.paidAt
        }))
      ),
      payments: invoice.payments.map((entry) => ({
        id: `db-pay-${entry.id}`,
        amount: Number((entry.amountCents / 100).toFixed(2)),
        currency: entry.currency,
        method: entry.paymentMethod,
        bankName: String(entry.bankName ?? '').trim(),
        chequeNumber: String(entry.chequeNumber ?? '').trim(),
        comment: String(entry.notes ?? '').trim(),
        paidAt: entry.paidAt
      }))
    };
  }

  private computeConsultationPaymentStatus(totalAmount: number, payments: ConsultationPaymentEntry[]): ConsultationPaymentStatus {
    const paidAmount = payments.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    const effectiveTotal = Math.max(0, Number(totalAmount) || 0);
    if (paidAmount <= 0) {
      return 'pending';
    }
    if (paidAmount >= effectiveTotal) {
      return 'paid';
    }
    return 'partial';
  }

  private parsePaymentAmount(rawAmount: unknown): number {
    const normalized = String(rawAmount ?? '')
      .replace(/\s+/g, '')
      .replace(',', '.');
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return Number(parsed.toFixed(2));
  }

  isConsultationPaymentMethodChequeSelected(): boolean {
    const method = String(this.consultationPaymentEditForm.controls.method.value ?? '').trim();
    return this.isChequePaymentMethod(method);
  }

  isConsultationChequePaymentMethod(method: string): boolean {
    return this.isChequePaymentMethod(method);
  }

  private isChequePaymentMethod(method: string): boolean {
    const normalized = String(method ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return normalized.includes('cheque') || normalized.includes('chq') || normalized.includes('check');
  }

  private resolveConsultationInvoiceDocumentRef(consultationId: number, issuedAtIso: string): string {
    const docs = this.patientDocuments()
      .filter((item) => Number(item.consultationId) === consultationId && String(item.mimeType ?? '').toLowerCase() === 'application/pdf');

    if (docs.length === 0) {
      return '';
    }

    const invoiceDocs = docs.filter((item) => {
      const title = String(item.title ?? '').toLowerCase();
      const fileName = String(item.fileName ?? '').toLowerCase();
      return title.includes('facture') || fileName.includes('facture');
    });

    const candidates = invoiceDocs.length > 0 ? invoiceDocs : docs;
    const issuedAtMs = new Date(issuedAtIso).getTime();
    const safeIssuedAtMs = Number.isFinite(issuedAtMs) ? issuedAtMs : null;

    if (safeIssuedAtMs == null) {
      return String(candidates[0]?.documentRef ?? '').trim();
    }

    const best = [...candidates].sort((left, right) => {
      const leftMs = new Date(left.createdAt).getTime();
      const rightMs = new Date(right.createdAt).getTime();
      const leftDelta = Math.abs((Number.isFinite(leftMs) ? leftMs : safeIssuedAtMs) - safeIssuedAtMs);
      const rightDelta = Math.abs((Number.isFinite(rightMs) ? rightMs : safeIssuedAtMs) - safeIssuedAtMs);
      return leftDelta - rightDelta;
    })[0];

    return String(best?.documentRef ?? '').trim();
  }

  private upsertConsultationBillingState(state: ConsultationBillingState): void {
    this.consultationBillingStates.update((items) => ({
      ...items,
      [state.consultationId]: state
    }));
    this.persistConsultationBillingStates();
    this.consultationBillingChoice.set('bill');
  }

  private generateConsultationInvoiceNumber(office: Office | null, profile: MyUserProfile | null, now: Date): string {
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const format = office?.invoiceNumberFormat ?? 'AAAA-XXXXXX';

    let prefix = `${year}${month}${day}`;
    let digits = 6;
    if (format === 'AAAA-XXXXXX') {
      prefix = year;
      digits = 6;
    } else if (format === 'AAAAMM-XXXXXX') {
      prefix = `${year}${month}`;
      digits = 6;
    } else if (format === 'AAAAMMJJ-XXXXXX') {
      prefix = `${year}${month}${day}`;
      digits = 6;
    } else if (format === 'AAAAMM-XXXX : RAZ mensuelle (déconseillé)') {
      prefix = `${year}${month}`;
      digits = 4;
    } else if (format === 'AAAA-XXXX : RAZ annuel') {
      prefix = year;
      digits = 4;
    }

    const periodKey = prefix;
    const numberingScope = office?.numberingConfiguration === 'Numérotation par praticien'
      ? `user:${profile?.id ?? 0}`
      : 'global';
    const storageKey = `osteosoft:invoice-seq:${office?.id ?? 0}:${numberingScope}:${format}:${periodKey}`;

    let sequence = 1;
    if (typeof window !== 'undefined') {
      try {
        const previous = Number(window.localStorage.getItem(storageKey) ?? '0');
        const safePrevious = Number.isFinite(previous) && previous > 0 ? previous : 0;
        sequence = safePrevious + 1;
        window.localStorage.setItem(storageKey, String(sequence));
      } catch {
        sequence = Math.floor(Math.random() * (10 ** digits));
      }
    } else {
      sequence = Math.floor(Math.random() * (10 ** digits));
    }

    const sequenceLabel = String(sequence).padStart(digits, '0').slice(-digits);
    return `${prefix}-${sequenceLabel}`;
  }

  private readPersistedConsultationBillingStates(): Record<number, ConsultationBillingState> {
    const patientId = this.patient()?.id;
    if (!patientId || typeof window === 'undefined') {
      return {};
    }

    try {
      const raw = window.localStorage.getItem(`${CONSULTATION_BILLING_STORAGE_KEY}:${patientId}`);
      if (!raw) {
        return {};
      }

      const parsed = JSON.parse(raw) as Record<string, ConsultationBillingState>;
      const normalized: Record<number, ConsultationBillingState> = {};
      for (const [key, value] of Object.entries(parsed ?? {})) {
        const consultationId = Number(key);
        if (!Number.isInteger(consultationId) || consultationId <= 0 || !value) {
          continue;
        }

        normalized[consultationId] = value;
      }

      return normalized;
    } catch {
      return {};
    }
  }

  private persistConsultationBillingStates(): void {
    const patientId = this.patient()?.id;
    if (!patientId || typeof window === 'undefined') {
      return;
    }

    try {
      const states = this.consultationBillingStates();
      window.localStorage.setItem(`${CONSULTATION_BILLING_STORAGE_KEY}:${patientId}`, JSON.stringify(states));
    } catch {
      // Ignore localStorage failures.
    }
  }

  private async buildConsultationInvoicePdfBlob(
    office: Office | null,
    profile: MyUserProfile,
    issuedAtIso: string,
    invoiceNumber: string
  ): Promise<Blob> {
    const raw = this.consultationBillingForm.getRawValue();
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2);
    const currency = String(office?.devise ?? 'EUR').trim() || 'EUR';
    const quantity = Math.max(0, Number(raw.quantity) || 0);
    const unitPrice = Math.max(0, Number(raw.amountHt) || 0);
    const tvaRate = Math.max(0, Number(raw.tvaRate) || 0);
    const totalHt = Number((quantity * unitPrice).toFixed(2));
    const totalTva = Number((totalHt * (tvaRate / 100)).toFixed(2));
    const totalAmount = Number((totalHt + totalTva).toFixed(2));

    const drawBox = (x: number, y: number, w: number, h: number): void => {
      pdf.setDrawColor(206, 214, 226);
      pdf.rect(x, y, w, h);
    };

    const writeRight = (text: string, xRight: number, y: number): void => {
      const width = pdf.getTextWidth(text);
      pdf.text(text, xRight - width, y);
    };

    const drawSection = (title: string, x: number, y: number, w: number, h: number, lines: string[]): void => {
      drawBox(x, y, w, h);
      pdf.setFillColor(246, 248, 251);
      pdf.rect(x, y, w, 6, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(title, x + 2, y + 4.2);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.6);
      let lineY = y + 10;
      for (const line of lines) {
        if (lineY > y + h - 2) {
          break;
        }
        pdf.text(line, x + 2, lineY);
        lineY += 4;
      }
    };

    let y = margin;

    const officeX = margin;
    const officeW = contentWidth * 0.58;
    const invoiceX = officeX + officeW + 4;
    const invoiceW = contentWidth - officeW - 4;
    const topBlockH = 44;

    drawBox(officeX, y, officeW, topBlockH);

    if (office?.logoData && office.logoData.startsWith('data:image/')) {
      try {
        pdf.addImage(office.logoData, 'PNG', officeX + 2, y + 2, 16, 16);
      } catch {
        // Keep generating even if logo is invalid.
      }
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    const officeName = String(office?.name ?? this.consultationOfficeName() ?? 'Cabinet').trim() || 'Cabinet';
    const officeHeading = officeName.toLowerCase().startsWith('cabinet') ? officeName : `Cabinet de ${officeName}`;
    pdf.text(officeHeading, officeX + 21, y + 7);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);

    const topLeftLines = [
      `${String(profile.lastName ?? '').trim()} ${String(profile.firstName ?? '').trim()}`.trim(),
      String(profile.nameSuffixText ?? '').trim(),
      String(office?.addressLine1 ?? '').trim(),
      String(office?.addressLine2 ?? '').trim(),
      `${String(office?.postalCode ?? '').trim()} ${String(office?.city ?? '').trim()}`.trim(),
      String(office?.email ?? '').trim(),
      String(office?.website ?? '').trim()
    ].filter(Boolean);

    let topY = y + 12;
    for (const line of topLeftLines) {
      pdf.text(line, officeX + 21, topY);
      topY += 3.8;
      if (topY > y + topBlockH - 2) {
        break;
      }
    }

    drawBox(invoiceX, y, invoiceW, topBlockH);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(22);
    writeRight('FACTURE', invoiceX + invoiceW - 3, y + 11);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    writeRight(`N° ${invoiceNumber}`, invoiceX + invoiceW - 3, y + 19);
    writeRight(`Date : ${this.formatShortDate(issuedAtIso)}`, invoiceX + invoiceW - 3, y + 24);
    writeRight(`Échéance : ${this.formatShortDate(issuedAtIso)}`, invoiceX + invoiceW - 3, y + 29);

    pdf.setDrawColor(200, 40, 40);
    pdf.setTextColor(200, 40, 40);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    writeRight('FACTURE ACQUITÉE', invoiceX + invoiceW - 3, y + 39);
    pdf.setTextColor(0, 0, 0);

    y += topBlockH + 6;

    const leftInfoW = contentWidth * 0.5;
    const rightInfoX = margin + leftInfoW + 4;
    const rightInfoW = contentWidth - leftInfoW - 4;
    const blockH = 36;

    drawSection('Informations facture', margin, y, leftInfoW, blockH, [
      `N° facture : ${invoiceNumber}`,
      `Date facture : ${this.formatShortDate(issuedAtIso)}`,
      `N° Sécu: ${String(raw.socialSecurityNumber ?? '').trim() || '-'}`,
      `N° Mutuelle: ${String(raw.insurance ?? '').trim() || '-'}`
    ]);

    const patientLines = [
      `${String(raw.lastName ?? '').trim()} ${String(raw.firstName ?? '').trim()}`.trim(),
      String(raw.address1 ?? '').trim(),
      String(raw.address2 ?? '').trim(),
      `${String(raw.postalCode ?? '').trim()} ${String(raw.city ?? '').trim()}`.trim(),
      String(raw.country ?? '').trim()
    ].filter(Boolean);

    const birthDateLine = this.formatShortDate(String(raw.birthDate ?? '').trim());
    if (birthDateLine && birthDateLine !== String(raw.birthDate ?? '').trim()) {
      patientLines.push(`Date de naissance : ${birthDateLine}`);
    }

    drawSection('A l\'attention de :', rightInfoX, y, rightInfoW, blockH, patientLines);

    y += blockH + 8;

    const tableX = margin;
    const tableW = contentWidth;
    const headerH = 7;
    const rowH = 9;
    const tableH = headerH + rowH;

    drawBox(tableX, y, tableW, tableH);
    pdf.setFillColor(246, 248, 251);
    pdf.rect(tableX, y, tableW, headerH, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.8);
    pdf.text('Description', tableX + 2, y + 4.6);
    pdf.text('Qté', tableX + (tableW * 0.56), y + 4.6);
    pdf.text('PU HT', tableX + (tableW * 0.66), y + 4.6);
    pdf.text('TVA', tableX + (tableW * 0.78), y + 4.6);
    pdf.text('Total TTC', tableX + (tableW * 0.88), y + 4.6);
    pdf.line(tableX, y + headerH, tableX + tableW, y + headerH);

    const colQty = tableX + (tableW * 0.54);
    const colPu = tableX + (tableW * 0.64);
    const colTva = tableX + (tableW * 0.76);
    const colTotal = tableX + (tableW * 0.86);
    pdf.line(colQty, y, colQty, y + tableH);
    pdf.line(colPu, y, colPu, y + tableH);
    pdf.line(colTva, y, colTva, y + tableH);
    pdf.line(colTotal, y, colTotal, y + tableH);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);
    pdf.text(String(raw.serviceLabel ?? '').trim() || 'Consultation', tableX + 2, y + headerH + 5.2);
    pdf.text(String(quantity), colQty + 2, y + headerH + 5.2);
    pdf.text(`${unitPrice.toFixed(2)} ${currency}`, colPu + 2, y + headerH + 5.2);
    pdf.text(`${tvaRate.toFixed(2)} %`, colTva + 2, y + headerH + 5.2);
    writeRight(`${totalAmount.toFixed(2)} ${currency}`, tableX + tableW - 2, y + headerH + 5.2);

    y += tableH + 4;
    const totalsX = tableX + (tableW * 0.58);
    const totalsW = tableX + tableW - totalsX;
    const totalsRowH = 6.5;
    drawBox(totalsX, y, totalsW, totalsRowH * 3);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);
    pdf.text('Total HT', totalsX + 2, y + 4.5);
    writeRight(`${totalHt.toFixed(2)} ${currency}`, totalsX + totalsW - 2, y + 4.5);
    pdf.line(totalsX, y + totalsRowH, totalsX + totalsW, y + totalsRowH);
    pdf.text(`TVA (${tvaRate.toFixed(2)} %)`, totalsX + 2, y + totalsRowH + 4.5);
    writeRight(`${totalTva.toFixed(2)} ${currency}`, totalsX + totalsW - 2, y + totalsRowH + 4.5);
    pdf.line(totalsX, y + (totalsRowH * 2), totalsX + totalsW, y + (totalsRowH * 2));
    pdf.setFont('helvetica', 'bold');
    pdf.text('Total TTC', totalsX + 2, y + (totalsRowH * 2) + 4.5);
    writeRight(`${totalAmount.toFixed(2)} ${currency}`, totalsX + totalsW - 2, y + (totalsRowH * 2) + 4.5);

    y += (totalsRowH * 3) + 7;

    const paymentBoxH = 20;
    drawSection('Liste des paiements effectués', tableX, y, tableW * 0.62, paymentBoxH, []);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.8);
    const paymentTextY = y + 11;
    pdf.setFont('helvetica', 'normal');
    const paymentMethod = String(raw.paymentMethod ?? '').trim();
    if (paymentMethod && paymentMethod !== PAYMENT_PENDING_LABEL) {
      pdf.text(`${this.formatShortDate(issuedAtIso)} - ${paymentMethod} - ${totalAmount.toFixed(2)} ${currency}`, tableX + 2, paymentTextY);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(26, 122, 58);
      pdf.text('RÉGLÉ', tableX + 2, paymentTextY + 5);
      pdf.setTextColor(0, 0, 0);
    } else {
      pdf.setTextColor(166, 125, 0);
      pdf.text('Aucun paiement enregistré', tableX + 2, paymentTextY);
      pdf.setTextColor(0, 0, 0);
    }

    const signatureX = tableX + (tableW * 0.65);
    const signatureW = tableX + tableW - signatureX;
    drawBox(signatureX, y, signatureW, paymentBoxH);
    const editionPlace = String(office?.city ?? this.consultationOfficeName() ?? '').trim() || 'Cabinet';
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.8);
    writeRight(`Éditée à ${editionPlace}, le ${this.formatShortDate(issuedAtIso)}`, signatureX + signatureW - 2, y + 7);
    pdf.setFont('helvetica', 'bold');
    writeRight('Signature', signatureX + signatureW - 2, y + 13);
    if (String(profile.signatureText ?? '').trim()) {
      pdf.setFont('helvetica', 'italic');
      writeRight(String(profile.signatureText ?? '').trim(), signatureX + signatureW - 2, y + 18);
    }

    const footerY = pageHeight - 14;
    pdf.setDrawColor(214, 220, 229);
    pdf.line(margin, footerY - 4, pageWidth - margin, footerY - 4);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);

    const regParts = [
      `SIRET: ${String(profile.siret ?? '').trim() || '-'}`,
      `RPPS: ${String(profile.rppsCode ?? '').trim() || '-'}`,
      `APE: ${String(profile.apeNafCode ?? '').trim() || '-'}`,
      `ADELI: ${String(profile.adeliCode ?? '').trim() || '-'}`
    ];
    const tvaText = 'TVA non applicable, art. 261-4-1 du CGI';
    const footerText = `${regParts.join(' | ')} | ${tvaText}`;
    const wrappedFooter = pdf.splitTextToSize(footerText, contentWidth) as string[];
    pdf.text(wrappedFooter, margin, footerY);

    return pdf.output('blob');
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const marker = 'base64,';
        const markerIndex = result.indexOf(marker);
        resolve(markerIndex >= 0 ? result.slice(markerIndex + marker.length) : result);
      };
      reader.onerror = () => reject(new Error('Blob read failed'));
      reader.readAsDataURL(blob);
    });
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