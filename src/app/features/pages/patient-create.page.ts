import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { jsPDF } from 'jspdf';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ConsultationReasonItem, LocationPair, Office, OfficeConsultationProfile, Patient, PatientDetail, PeoplePickerContact, Practitioner } from '../../core/api.types';
import { ConsultationDocumentUploadPayload, CreatePatientPayload } from '../../core/api.types';

declare const $: any;

type AntecedentPrecision = 'date' | 'month' | 'year';

type AntecedentItem = {
  id: number;
  precision: AntecedentPrecision;
  dateDisplay: string;
  sortKey: number;
  category: string;
  description: string;
  important: boolean;
};

const LOCAL_DRAFT_KEY = 'osteosoft:new-patient-draft';
const PAYMENT_PENDING_LABEL = 'Paiement en attente';

type DraftSaveState = 'idle' | 'saving' | 'saved' | 'error';

type ConsultationTab = 'consultation' | 'documents' | 'courriers' | 'paiement';

type ConsultationDraft = {
  startedAt: string;
  officeId: number | null;
  officeName: string | null;
  practitioner: string;
  practitionerUsername?: string;
  title: string;
  important: boolean;
  heightCm: number | null;
  weightKg: number | null;
  evaBefore: number;
  evaAfter: number;
  profile: string;
  selectedReasons: string[];
  reasonItems: ConsultationReasonItem[];
  documentRefs?: string[];
  motifMainHtml: string;
  testsHtml: string;
  schemaHtml: string;
  treatmentsHtml: string;
  remarksHtml: string;
};

type ConsultationUploadDocument = Omit<ConsultationDocumentUploadPayload, 'documentRef'> & {
  documentRef: string;
  tempKey: string;
};

type ConsultationReasonSelection = {
  checked: boolean;
  value: string;
  important: boolean;
};

type ParentContactField =
  | 'mobilePhone'
  | 'landlinePhone'
  | 'email'
  | 'address1'
  | 'address2'
  | 'postalCode'
  | 'city'
  | 'country';

type ParentPrefillCandidate = {
  id: number;
  fullName: string;
  contacts: Record<ParentContactField, string>;
};

const parentContactFields: ParentContactField[] = [
  'mobilePhone',
  'landlinePhone',
  'email',
  'address1',
  'address2',
  'postalCode',
  'city',
  'country'
];

@Component({
  selector: 'app-patient-create-page',
  imports: [ReactiveFormsModule],
  templateUrl: './patient-create.page.html',
  styleUrl: './patient-create.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientCreatePage implements OnInit, AfterViewInit, OnDestroy {
  private readonly formBuilder = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  private readonly birthDateInputRef = viewChild.required<ElementRef<HTMLInputElement>>('birthDateInput');
  private readonly antecedentDateInputRef = viewChild<ElementRef<HTMLInputElement>>('antecedentDateInput');
  private readonly motifMainEditorRef = viewChild<ElementRef<HTMLDivElement>>('motifMainEditor');
  private readonly testsEditorRef = viewChild<ElementRef<HTMLDivElement>>('testsEditor');
  private readonly schemaEditorRef = viewChild<ElementRef<HTMLDivElement>>('schemaEditor');
  private readonly treatmentsEditorRef = viewChild<ElementRef<HTMLDivElement>>('treatmentsEditor');
  private readonly remarksEditorRef = viewChild<ElementRef<HTMLDivElement>>('remarksEditor');

  readonly currentStep = signal<1 | 2 | 3 | 4 | 5>(1);
  readonly isSaving = signal(false);
  readonly errorMessage = signal('');
  readonly showRelatedPicker = signal(false);
  readonly relatedSearch = signal('');
  readonly relatedSearchResults = signal<Patient[]>([]);
  readonly selectedRelatedPatients = signal<Patient[]>([]);
  readonly relatedContactCards = signal<ParentPrefillCandidate[]>([]);
  readonly isSearchingRelated = signal(false);
  readonly isParentPrefillModalOpen = signal(false);
  readonly parentPrefillCandidates = signal<ParentPrefillCandidate[]>([]);
  readonly parentPrefillSelections = signal<Record<ParentContactField, string>>(this.createEmptyParentPrefillSelections());
  readonly parentPrefillFields = parentContactFields;
  readonly locationPairs = signal<LocationPair[]>([]);
  readonly postalCodeSuggestions = signal<string[]>([]);
  readonly citySuggestions = signal<string[]>([]);
  readonly showPostalCodeSuggestions = signal(false);
  readonly showCitySuggestions = signal(false);
  readonly antecedentItems = signal<AntecedentItem[]>([]);
  readonly isAntecedentModalOpen = signal(false);
  readonly antecedentError = signal('');
  readonly antecedentDatePrecision = signal<AntecedentPrecision>('date');
  readonly antecedentDateDisplay = signal('');
  readonly antecedentCategory = signal('');
  readonly antecedentDescription = signal('');
  readonly antecedentImportant = signal(false);
  readonly draftSaveState = signal<DraftSaveState>('idle');
  readonly lastDraftSavedAt = signal<number | null>(null);
  readonly draftStatusNowTick = signal(Date.now());
  readonly primaryDoctorSearch = signal('');
  readonly primaryDoctorSuggestions = signal<PeoplePickerContact[]>([]);
  readonly isSearchingPrimaryDoctor = signal(false);
  readonly referredBySuggestions = signal<string[]>([]);
  readonly isSearchingReferredBy = signal(false);

  readonly draftStatusText = computed(() => {
    this.draftStatusNowTick();

    const state = this.draftSaveState();
    if (state === 'saving') {
      return 'Sauvegarde en cours...';
    }
    if (state === 'error') {
      return 'Echec de la sauvegarde automatique';
    }

    const savedAt = this.lastDraftSavedAt();
    if (!savedAt) {
      return 'Aucune sauvegarde automatique encore effectuee';
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
    if (elapsedSeconds < 5) {
      return 'Derniere sauvegarde a l\'instant';
    }
    if (elapsedSeconds < 60) {
      return `Derniere sauvegarde il y a ${elapsedSeconds}s`;
    }

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
      return `Derniere sauvegarde il y a ${elapsedMinutes} min`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    return `Derniere sauvegarde il y a ${elapsedHours} h`;
  });

  readonly antecedentCategoryOptions = signal<string[]>([
    'Psychologie',
    'Traitement medical',
    'Hospitalisation',
    'Chirurgie',
    'Allergie',
    'Accident',
    'Pathologie chronique',
    'Antecedent familial'
  ]);

  readonly consultationActiveTab = signal<ConsultationTab>('consultation');
  readonly consultationStartedAtIso = signal(new Date().toISOString());
  readonly consultationOfficeId = signal<number | null>(null);
  readonly consultationOfficeName = signal<string | null>(null);
  readonly consultationPractitioner = signal('');
  readonly consultationPractitionerUsername = signal('');
  readonly practitioners = signal<Practitioner[]>([]);
  readonly consultationTitle = signal('');
  readonly consultationImportant = signal(false);
  readonly consultationHeightCm = signal<number | null>(null);
  readonly consultationWeightKg = signal<number | null>(null);
  readonly consultationEvaBefore = signal(0);
  readonly consultationEvaAfter = signal(0);
  readonly consultationProfile = signal('');
  readonly consultationProfileOptions = signal<string[]>([]);
  readonly consultationOfficeProfiles = signal<OfficeConsultationProfile[]>([]);
  readonly consultationReasonSelections = signal<Record<string, ConsultationReasonSelection>>({});
  readonly consultationDocuments = signal<ConsultationUploadDocument[]>([]);
  readonly isConsultationDocumentDragOver = signal(false);
  readonly isGeneratingConsultationPdf = signal(false);
  readonly consultationPdfError = signal('');
  readonly consultationPdfDisplayMode = signal<'browser' | 'download'>('browser');
  readonly consultationBillingChoice = signal<'bill' | 'free' | null>(null);
  readonly isConsultationBillingModalOpen = signal(false);
  readonly consultationBillingServiceOptions = signal<Array<{ label: string; amountHt: number; tvaRate: number }>>([]);
  readonly consultationBillingPaymentMethodOptions = signal<string[]>([]);
  readonly consultationMotifMainHtml = signal('');
  readonly consultationTestsHtml = signal('');
  readonly consultationSchemaHtml = signal('');
  readonly consultationTreatmentsHtml = signal('');
  readonly consultationRemarksHtml = signal('');
  readonly isConsultationLinkStrategyModalOpen = signal(false);

  readonly consultationProfileReasons = computed(() => {
    const selectedProfile = this.consultationProfile().trim();
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

  readonly consultationSelectedReasonItems = computed(() => {
    return this.consultationReasonItems()
      .filter((item) => item.checked)
      .map((item) => ({
        label: item.reason,
        value: item.value.trim(),
        important: item.important
      }));
  });

  readonly consultationStartedAtInput = computed(() => this.toDateTimeLocalValue(this.consultationStartedAtIso()));

  readonly consultationStartedAtLabel = computed(() => {
    const parsed = new Date(this.consultationStartedAtIso());
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

  readonly bmi = computed(() => {
    const heightCm = this.consultationHeightCm();
    const weightKg = this.consultationWeightKg();
    if (!heightCm || !weightKg || heightCm <= 0 || weightKg <= 0) {
      return null;
    }

    const heightM = heightCm / 100;
    return Number((weightKg / (heightM * heightM)).toFixed(1));
  });

  readonly consultationBillingForm = this.formBuilder.nonNullable.group({
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

  private relatedSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private relatedSearchRequestId = 0;
  private primaryDoctorSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private primaryDoctorSearchRequestId = 0;
  private referredBySearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private referredBySearchRequestId = 0;
  private antecedentIdSequence = 1;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private draftStatusTimer: ReturnType<typeof setInterval> | null = null;
  private isPersistingDraft = false;
  private pendingDraftSave = false;
  private isViewReady = false;
  private pendingBirthDateIso = '';
  private isSynchronizingLocationFields = false;
  private pendingConsultationLinkStrategy: 'attach-existing' | 'create-new' | null = null;
  private readonly consultationOfficeContextEffect = effect(() => {
    const officeId = this.authService.activeOfficeId();
    void this.loadConsultationContext(officeId);
  });

  private readonly motifMainEditorEffect = effect(() => {
    const html = this.consultationMotifMainHtml();
    const el = this.motifMainEditorRef()?.nativeElement;
    if (el && document.activeElement !== el) { el.innerHTML = html; }
  });

  private readonly testsEditorEffect = effect(() => {
    const html = this.consultationTestsHtml();
    const el = this.testsEditorRef()?.nativeElement;
    if (el && document.activeElement !== el) { el.innerHTML = html; }
  });

  private readonly schemaEditorEffect = effect(() => {
    const html = this.consultationSchemaHtml();
    const el = this.schemaEditorRef()?.nativeElement;
    if (el && document.activeElement !== el) { el.innerHTML = html; }
  });

  private readonly treatmentsEditorEffect = effect(() => {
    const html = this.consultationTreatmentsHtml();
    const el = this.treatmentsEditorRef()?.nativeElement;
    if (el && document.activeElement !== el) { el.innerHTML = html; }
  });

  private readonly remarksEditorEffect = effect(() => {
    const html = this.consultationRemarksHtml();
    const el = this.remarksEditorRef()?.nativeElement;
    if (el && document.activeElement !== el) { el.innerHTML = html; }
  });

  /** ISO date (yyyy-mm-dd) kept in sync by the datepicker */
  private readonly birthDateIso = signal('');

  readonly form = this.formBuilder.nonNullable.group({
    sex: this.formBuilder.nonNullable.control<'Non renseigne' | 'Femme' | 'Homme'>('Non renseigne'),
    lastName: ['', [Validators.required, Validators.maxLength(100)]],
    firstName: ['', [Validators.required, Validators.maxLength(100)]],
    birthDate: ['', [Validators.required]],
    mobilePhone: ['', [Validators.maxLength(50)]],
    landlinePhone: ['', [Validators.maxLength(50)]],
    email: ['', [Validators.maxLength(150), Validators.email]],
    address1: ['', [Validators.maxLength(150)]],
    address2: ['', [Validators.maxLength(150)]],
    postalCode: ['', [Validators.maxLength(20)]],
    city: ['', [Validators.maxLength(100)]],
    country: ['France', [Validators.maxLength(80)]],
    maritalStatus: this.formBuilder.nonNullable.control<
      'Non renseigne' | 'Celibataire' | 'Marie(e)' | 'Pacse(e)' | 'Divorce(e)' | 'Veuf(ve)'
    >('Non renseigne'),
    childrenCount: this.formBuilder.nonNullable.control(0, [Validators.min(0), Validators.max(50)]),
    occupationOrSchool: ['', [Validators.maxLength(200)]],
    hobbies: ['', [Validators.maxLength(500)]],
    primaryDoctor: ['', [Validators.maxLength(160)]],
    socialSecurityNumber: ['', [Validators.maxLength(32)]],
    referredBy: ['', [Validators.maxLength(160)]],
    manualPreference: this.formBuilder.nonNullable.control<'Non renseigne' | 'Droitier' | 'Gaucher'>('Non renseigne'),
    generalRemarks: ['', [Validators.maxLength(5000)]],
    relatedPeople: ['', [Validators.maxLength(500)]],
    isDeceased: [false],
    medicalHistory: ['', [Validators.maxLength(5000)]],
    consultationNote: ['', [Validators.maxLength(30000)]]
  });

  /** Reactive snapshot of form values — used in computed signals */
  private readonly formValues = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  readonly sexValue = computed(() => this.formValues().sex ?? 'Non renseigne');

  readonly step1Valid = computed(() => {
    const vals = this.formValues();
    return (
      (vals.lastName?.trim().length ?? 0) > 0 &&
      (vals.firstName?.trim().length ?? 0) > 0 &&
      (vals.birthDate?.trim().length ?? 0) > 0
    );
  });

  readonly ageText = computed(() => {
    const birthDate = this.birthDateIso();
    if (!birthDate) return '';
    const birth = new Date(birthDate);
    if (Number.isNaN(birth.getTime())) return '';
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age -= 1;
    return age >= 0 ? `${age} ans` : '';
  });

  readonly isMinorPatient = computed(() => {
    const birthDate = this.birthDateIso();
    const age = this.computeAgeFromIsoDate(birthDate);
    return age !== null && age < 18;
  });

  setSex(value: 'Non renseigne' | 'Femme' | 'Homme'): void {
    this.form.controls.sex.setValue(value);
  }

  onPostalCodeInput(value: string): void {
    this.updateLocationSuggestions(value, this.form.controls.city.value);
    this.syncCityFromPostalCode(value);
    this.showPostalCodeSuggestions.set(Boolean(value.trim()) && this.postalCodeSuggestions().length > 0);
  }

  onCityInput(value: string): void {
    this.updateLocationSuggestions(this.form.controls.postalCode.value, value);
    this.syncPostalCodeFromCity(value);
    this.showCitySuggestions.set(Boolean(value.trim()) && this.citySuggestions().length > 0);
  }

  onPostalCodeFocus(): void {
    const value = this.form.controls.postalCode.value;
    this.updateLocationSuggestions(value, this.form.controls.city.value);
    this.showPostalCodeSuggestions.set(Boolean(value.trim()) && this.postalCodeSuggestions().length > 0);
  }

  onCityFocus(): void {
    const value = this.form.controls.city.value;
    this.updateLocationSuggestions(this.form.controls.postalCode.value, value);
    this.showCitySuggestions.set(Boolean(value.trim()) && this.citySuggestions().length > 0);
  }

  onPostalCodeBlur(): void {
    this.syncCityFromPostalCode(this.form.controls.postalCode.value);
    setTimeout(() => this.showPostalCodeSuggestions.set(false), 120);
  }

  onCityBlur(): void {
    this.syncPostalCodeFromCity(this.form.controls.city.value);
    setTimeout(() => this.showCitySuggestions.set(false), 120);
  }

  applyPostalCodeSuggestion(postalCode: string): void {
    this.form.controls.postalCode.setValue(postalCode);
    this.syncCityFromPostalCode(postalCode);
    this.showPostalCodeSuggestions.set(false);
  }

  applyCitySuggestion(city: string): void {
    this.form.controls.city.setValue(city);
    this.syncPostalCodeFromCity(city);
    this.showCitySuggestions.set(false);
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
    void this.refreshRelatedContactCards();
  }

  removeRelatedPatient(patientId: number): void {
    this.selectedRelatedPatients.update((items) => items.filter((item) => item.id !== patientId));
    this.syncRelatedPeopleField();
    void this.refreshRelatedContactCards();
  }

  async applyRelatedContactCard(candidateId: number): Promise<void> {
    const candidate = this.relatedContactCards().find((item) => item.id === candidateId);
    if (!candidate) {
      return;
    }

    this.applyParentCandidateCoordinates(candidate, false);
    await this.persistDraft();
  }

  closeParentPrefillModal(): void {
    this.isParentPrefillModalOpen.set(false);
    this.parentPrefillCandidates.set([]);
    this.parentPrefillSelections.set(this.createEmptyParentPrefillSelections());
  }

  getParentPrefillFieldLabel(field: ParentContactField): string {
    const labels: Record<ParentContactField, string> = {
      mobilePhone: 'Telephone portable',
      landlinePhone: 'Telephone fixe',
      email: 'Adresse email',
      address1: 'Adresse',
      address2: 'Complement d\'adresse',
      postalCode: 'Code postal',
      city: 'Ville',
      country: 'Pays'
    };

    return labels[field];
  }

  getParentPrefillOptions(field: ParentContactField): Array<{ value: string; label: string }> {
    const options: Array<{ value: string; label: string }> = [];
    const seen = new Set<string>();

    for (const candidate of this.parentPrefillCandidates()) {
      const value = candidate.contacts[field].trim();
      if (!value || seen.has(value)) {
        continue;
      }

      seen.add(value);
      options.push({
        value,
        label: `${candidate.fullName} - ${value}`
      });
    }

    return options;
  }

  getParentPrefillSelection(field: ParentContactField): string {
    return this.parentPrefillSelections()[field] ?? '';
  }

  setParentPrefillSelection(field: ParentContactField, value: string): void {
    this.parentPrefillSelections.update((current) => ({
      ...current,
      [field]: value
    }));
  }

  async applyParentPrefillSelections(): Promise<void> {
    const selections = this.parentPrefillSelections();
    for (const field of parentContactFields) {
      const value = selections[field].trim();
      if (!value) {
        continue;
      }

      this.form.controls[field].setValue(value);
    }

    this.closeParentPrefillModal();
    await this.persistDraft();
  }

  getRelatedPatientIcon(sex: Patient['sex']): string {
    if (sex === 'Femme') {
      return 'fa-solid fa-venus';
    }
    if (sex === 'Homme') {
      return 'fa-solid fa-mars';
    }
    return 'fa-solid fa-circle-question';
  }

  getRelatedPatientMeta(patient: Patient): string {
    const ageText = patient.age === null ? 'Age inconnu' : `${patient.age} ans`;
    const consultationText = `${patient.consultationCount} consultation${patient.consultationCount > 1 ? 's' : ''}`;
    return `${ageText} - ${consultationText}`;
  }

  formatCandidateAddress(candidate: ParentPrefillCandidate): string {
    return [candidate.contacts.address1, candidate.contacts.postalCode, candidate.contacts.city]
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0)
      .join(' ');
  }

  onPrimaryDoctorSearchChange(value: string): void {
    this.primaryDoctorSearch.set(value);
    this.form.controls.primaryDoctor.setValue(value.trim());

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
    }, 220);
  }

  applyPrimaryDoctorSuggestion(contact: PeoplePickerContact): void {
    this.form.controls.primaryDoctor.setValue(contact.fullName);
    this.primaryDoctorSearch.set(contact.fullName);
    this.primaryDoctorSuggestions.set([]);
  }

  onReferredByInput(value: string): void {
    this.form.controls.referredBy.setValue(value);

    if (this.referredBySearchDebounceId !== null) {
      clearTimeout(this.referredBySearchDebounceId);
      this.referredBySearchDebounceId = null;
    }

    const term = value.trim();
    if (term.length < 2) {
      this.referredBySuggestions.set([]);
      this.isSearchingReferredBy.set(false);
      return;
    }

    this.isSearchingReferredBy.set(true);
    this.referredBySearchDebounceId = setTimeout(() => {
      void this.searchReferredBySuggestions(term);
    }, 220);
  }

  applyReferredBySuggestion(value: string): void {
    this.form.controls.referredBy.setValue(value);
    this.referredBySuggestions.set([]);
  }

  openAntecedentModal(): void {
    this.isAntecedentModalOpen.set(true);
    this.antecedentError.set('');
    this.antecedentDatePrecision.set('date');
    this.antecedentDateDisplay.set('');
    this.antecedentCategory.set('');
    this.antecedentDescription.set('');
    this.antecedentImportant.set(false);

    queueMicrotask(() => this.initAntecedentDatepicker());
  }

  closeAntecedentModal(): void {
    this.isAntecedentModalOpen.set(false);
    this.antecedentError.set('');
    this.destroyAntecedentDatepicker();
  }

  setAntecedentPrecision(precision: AntecedentPrecision): void {
    this.antecedentDatePrecision.set(precision);
    this.antecedentDateDisplay.set('');
    this.initAntecedentDatepicker();
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

  setConsultationTab(tab: ConsultationTab): void {
    this.consultationActiveTab.set(tab);
  }

  setConsultationPractitioner(value: string): void {
    const raw = value.trim();
    if (!raw) {
      this.consultationPractitioner.set('');
      this.consultationPractitionerUsername.set('');
      this.syncConsultationNoteFromState();
      return;
    }

    const lowerRaw = raw.toLowerCase();
    const picked = this.practitionerPickerOptions().find((option) =>
      option.displayName.toLowerCase() === lowerRaw || option.username.toLowerCase() === lowerRaw
    );

    if (picked) {
      this.consultationPractitioner.set(picked.displayName);
      this.consultationPractitionerUsername.set(picked.username);
    } else {
      this.consultationPractitioner.set(raw);
      this.consultationPractitionerUsername.set('');
    }

    this.syncConsultationNoteFromState();
  }

  setConsultationStartedAt(value: string): void {
    const iso = this.fromDateTimeLocalValue(value);
    if (!iso) {
      return;
    }

    this.consultationStartedAtIso.set(iso);
    this.syncConsultationNoteFromState();
  }

  setConsultationTitle(value: string): void {
    this.consultationTitle.set(value);
    this.syncConsultationNoteFromState();
  }

  setConsultationImportant(value: boolean): void {
    this.consultationImportant.set(value);
    this.syncConsultationNoteFromState();
  }

  setConsultationHeightCm(value: string): void {
    this.consultationHeightCm.set(this.parseNullableNumber(value));
    this.syncConsultationNoteFromState();
  }

  setConsultationWeightKg(value: string): void {
    this.consultationWeightKg.set(this.parseNullableNumber(value));
    this.syncConsultationNoteFromState();
  }

  setConsultationEvaBefore(value: string): void {
    this.consultationEvaBefore.set(Number(value));
    this.syncConsultationNoteFromState();
  }

  setConsultationEvaAfter(value: string): void {
    this.consultationEvaAfter.set(Number(value));
    this.syncConsultationNoteFromState();
  }

  setConsultationProfile(value: string): void {
    const selected = value.trim();
    this.consultationProfile.set(selected);
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
    this.syncConsultationNoteFromState();
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

    this.syncConsultationNoteFromState();
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

    this.syncConsultationNoteFromState();
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

    this.syncConsultationNoteFromState();
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

    await this.addConsultationDocuments(Array.from(files));
  }

  async onConsultationDocumentFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const files = input?.files;
    if (!files || files.length === 0) {
      return;
    }

    await this.addConsultationDocuments(Array.from(files));
    input.value = '';
  }

  removeConsultationDocument(tempKey: string): void {
    this.consultationDocuments.update((items) => items.filter((item) => item.tempKey !== tempKey));
    this.syncConsultationNoteFromState();
  }

  updateConsultationDocumentTitle(tempKey: string, title: string): void {
    this.consultationDocuments.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, title } : item))
    );
    this.syncConsultationNoteFromState();
  }

  updateConsultationDocumentComment(tempKey: string, comment: string): void {
    this.consultationDocuments.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, comment } : item))
    );
    this.syncConsultationNoteFromState();
  }

  onConsultationRichTextInput(
    field: 'motifMain' | 'tests' | 'schema' | 'treatments' | 'remarks',
    event: Event
  ): void {
    const html = (event.target as HTMLDivElement).innerHTML;

    if (field === 'motifMain') this.consultationMotifMainHtml.set(html);
    else if (field === 'tests') this.consultationTestsHtml.set(html);
    else if (field === 'schema') this.consultationSchemaHtml.set(html);
    else if (field === 'treatments') this.consultationTreatmentsHtml.set(html);
    else this.consultationRemarksHtml.set(html);

    this.syncConsultationNoteFromState();
  }

  applyEditorCommand(
    field: 'motifMain' | 'tests' | 'schema' | 'treatments' | 'remarks',
    command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList'
  ): void {
    const editor = this.getEditorElement(field);
    if (!editor) {
      return;
    }

    editor.focus();
    document.execCommand(command, false);
    this.syncConsultationNoteFromState();
  }

  addAntecedent(): void {
    const dateDisplay = this.antecedentDateDisplay().trim();
    const category = this.antecedentCategory().trim();
    const description = this.antecedentDescription().trim();

    if (!dateDisplay || !category) {
      this.antecedentError.set('La date et le type d\'antecedent sont obligatoires.');
      return;
    }

    const precision = this.antecedentDatePrecision();
    const sortKey = this.buildAntecedentSortKey(precision, dateDisplay);
    if (sortKey === null) {
      this.antecedentError.set('Le format de date est invalide pour la precision choisie.');
      return;
    }

    const item: AntecedentItem = {
      id: this.antecedentIdSequence++,
      precision,
      dateDisplay,
      sortKey,
      category,
      description,
      important: this.antecedentImportant()
    };

    this.antecedentItems.update((items) => [...items, item].sort((a, b) => b.sortKey - a.sortKey));
    this.ensureAntecedentOption(category);
    this.syncMedicalHistoryFromAntecedents();
    this.closeAntecedentModal();
  }

  removeAntecedent(id: number): void {
    this.antecedentItems.update((items) => items.filter((item) => item.id !== id));
    this.syncMedicalHistoryFromAntecedents();
  }

  getAntecedentDateLabel(item: AntecedentItem): string {
    if (item.precision === 'month') {
      return `Mois ${item.dateDisplay}`;
    }
    if (item.precision === 'year') {
      return `Annee ${item.dateDisplay}`;
    }
    return item.dateDisplay;
  }

  async goNext(): Promise<void> {
    if (this.currentStep() === 1) {
      if (!this.step1Valid()) {
        this.form.controls.lastName.markAsTouched();
        this.form.controls.firstName.markAsTouched();
        this.form.controls.birthDate.markAsTouched();
        return;
      }

      this.currentStep.set(2);
      await this.refreshRelatedContactCards();
    } else if (this.currentStep() === 2) {
      this.currentStep.set(3);
    } else if (this.currentStep() === 3) {
      this.currentStep.set(4);
    } else if (this.currentStep() === 4) {
      this.currentStep.set(5);
    }

    await this.persistDraft();
  }

  async goPrev(): Promise<void> {
    if (this.currentStep() === 2) this.currentStep.set(1);
    else if (this.currentStep() === 3) this.currentStep.set(2);
    else if (this.currentStep() === 4) this.currentStep.set(3);
    else if (this.currentStep() === 5) this.currentStep.set(4);

    await this.persistDraft();
  }

  ngOnInit(): void {
    void this.loadAntecedentTypes();
    void this.loadLocationPairs();
    void this.loadConsultationPdfDisplayMode();

    this.syncConsultationNoteFromState();
    void this.loadDraft();

    this.draftStatusTimer = setInterval(() => {
      this.draftStatusNowTick.set(Date.now());
    }, 1000);

    this.autosaveTimer = setInterval(() => {
      const step = this.currentStep();
      if (step === 4 || step === 5) {
        void this.persistDraft();
      }
    }, 3 * 60 * 1000);
  }

  async generateConsultationSummaryPdf(): Promise<void> {
    if (this.isGeneratingConsultationPdf()) {
      return;
    }

    const preferDownload = this.consultationPdfDisplayMode() === 'download';
    const previewWindow = !preferDownload
      ? window.open('about:blank', '_blank')
      : null;

    this.consultationPdfError.set('');
    this.isGeneratingConsultationPdf.set(true);

    try {
      const profile = await this.api.getMyUserProfile();
      const consultationDate = this.formatConsultationDate(this.consultationStartedAtIso());
      const firstName = String(this.form.controls.firstName.value ?? '').trim();
      const lastName = String(this.form.controls.lastName.value ?? '').trim();
      const fullName = `${firstName} ${lastName}`.trim() || 'Patient';

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
      writeParagraph(`Patient : ${this.normalizeMultilineText(fullName)}`, 11, 1);
      writeParagraph(`Date de consultation : ${consultationDate}`, 11, 1);
      writeParagraph(`Praticien : ${this.normalizeMultilineText(this.consultationPractitioner() || '-')}`, 11, 1);
      writeParagraph(`Titre : ${this.normalizeMultilineText(this.consultationTitle() || '-')}`, 11, 4);

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
          `Profil : ${this.normalizeMultilineText(this.consultationProfile() || '-')}`,
          `Taille : ${this.consultationHeightCm() ?? '-'}`,
          `Poids : ${this.consultationWeightKg() ?? '-'}`,
          `EVA debut : ${this.consultationEvaBefore()}/10`,
          `EVA fin : ${this.consultationEvaAfter()}/10`
        ].join('\n')
      );

      writeSection('Motifs selectionnes', selectedReasons || '- Aucun motif selectionne');
      writeSection('Motif principal', this.htmlToPlainText(this.consultationMotifMainHtml()));
      writeSection('Tests', this.htmlToPlainText(this.consultationTestsHtml()));
      writeSection('Schema', this.htmlToPlainText(this.consultationSchemaHtml()));
      writeSection('Traitements proposes', this.htmlToPlainText(this.consultationTreatmentsHtml()));
      writeSection('Remarques', this.htmlToPlainText(this.consultationRemarksHtml()));

      const filename = `${this.toFileSlug(fullName)}_consultation_${this.toFileSlug(consultationDate) || 'date'}.pdf`;

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
  private async loadConsultationPdfDisplayMode(): Promise<void> {
    try {
      const preferences = await this.api.getMyAgendaPreferences();
      this.consultationPdfDisplayMode.set(preferences.pdfDisplayMode === 'download' ? 'download' : 'browser');
    } catch {
      this.consultationPdfDisplayMode.set('browser');
    }
  }

  private populateConsultationBillingForm(): void {
    this.consultationBillingForm.patchValue({
      sex: this.form.controls.sex.value,
      lastName: this.form.controls.lastName.value,
      firstName: this.form.controls.firstName.value,
      mobilePhone: this.form.controls.mobilePhone.value,
      email: this.form.controls.email.value,
      birthDate: this.form.controls.birthDate.value,
      address1: this.form.controls.address1.value,
      address2: this.form.controls.address2.value,
      postalCode: this.form.controls.postalCode.value,
      city: this.form.controls.city.value,
      country: this.form.controls.country.value || 'France',
      socialSecurityNumber: this.form.controls.socialSecurityNumber.value,
      insurance: '',
      documentName: 'Facture acquittee',
      internalComment: '',
      paymentMethod: PAYMENT_PENDING_LABEL,
      amountHt: this.consultationBillingForm.controls.amountHt.value || 55,
      quantity: this.consultationBillingForm.controls.quantity.value || 1,
      tvaRate: this.consultationBillingForm.controls.tvaRate.value || 0
    });

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

  ngAfterViewInit(): void {
    this.isViewReady = true;

    const el = this.birthDateInputRef().nativeElement;
    $(el).datepicker({
      language: 'fr',
      format: 'dd/mm/yyyy',
      container: 'body',
      autoclose: true,
      todayHighlight: true,
      weekStart: 1,
      startView: 2,
      endDate: new Date()
    }).on('changeDate', (e: any) => {
      const d: Date = e.date;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      this.form.controls.birthDate.setValue(iso);
      this.form.controls.birthDate.markAsTouched();
      this.birthDateIso.set(iso);
    });

    if (this.pendingBirthDateIso) {
      this.applyBirthDateToPicker(this.pendingBirthDateIso);
    }
  }

  ngOnDestroy(): void {
    this.consultationOfficeContextEffect.destroy();

    if (this.relatedSearchDebounceId !== null) {
      clearTimeout(this.relatedSearchDebounceId);
    }

    if (this.autosaveTimer !== null) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }

    if (this.primaryDoctorSearchDebounceId !== null) {
      clearTimeout(this.primaryDoctorSearchDebounceId);
      this.primaryDoctorSearchDebounceId = null;
    }

    if (this.referredBySearchDebounceId !== null) {
      clearTimeout(this.referredBySearchDebounceId);
      this.referredBySearchDebounceId = null;
    }

    if (this.draftStatusTimer !== null) {
      clearInterval(this.draftStatusTimer);
      this.draftStatusTimer = null;
    }

    this.destroyAntecedentDatepicker();

    const el = this.birthDateInputRef().nativeElement;
    $(el).datepicker('destroy');
  }

  async skipAndSave(): Promise<void> {
    this.clearConsultationData();
    await this.submit();
  }

  async submit(): Promise<void> {
    this.syncConsultationNoteFromState();
    if (this.form.invalid || this.isSaving()) {
      this.form.markAllAsTouched();
      return;
    }

    if (this.hasConsultationContent() && !this.pendingConsultationLinkStrategy) {
      this.isConsultationLinkStrategyModalOpen.set(true);
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');

    try {
      const payload = this.buildPatientPayload(
        this.hasConsultationContent() && this.pendingConsultationLinkStrategy
          ? this.pendingConsultationLinkStrategy
          : undefined
      );
      await this.api.createPatient(payload);
      this.pendingConsultationLinkStrategy = null;
      this.isConsultationLinkStrategyModalOpen.set(false);
      this.clearLocalDraft();
      await this.router.navigateByUrl('/patients');
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 403) {
        this.errorMessage.set('Droit insuffisant pour creer un patient.');
      } else {
        this.errorMessage.set("Impossible d'enregistrer le patient. Verifie les champs et reessaie.");
      }
      this.isSaving.set(false);
    }
  }

  closeConsultationLinkStrategyModal(): void {
    if (this.isSaving()) {
      return;
    }
    this.isConsultationLinkStrategyModalOpen.set(false);
  }

  chooseConsultationLinkStrategy(attachExisting: boolean): void {
    this.pendingConsultationLinkStrategy = attachExisting ? 'attach-existing' : 'create-new';
    this.isConsultationLinkStrategyModalOpen.set(false);
    void this.submit();
  }

  async cancelCreation(): Promise<void> {
    this.clearLocalDraft();
    try {
      await this.api.deleteNewPatientDraft();
    } catch {
      // Ignore remote cleanup failures; local draft is already cleared.
    }
    await this.router.navigateByUrl('/patients');
  }

  private async searchRelatedPatients(term: string): Promise<void> {
    const requestId = ++this.relatedSearchRequestId;

    try {
      const patients = await this.api.getPatients(term);
      if (requestId !== this.relatedSearchRequestId) {
        return;
      }

      const selectedIds = new Set(this.selectedRelatedPatients().map((item) => item.id));
      this.relatedSearchResults.set(patients.filter((item) => !selectedIds.has(item.id)).slice(0, 8));
    } catch {
      if (requestId !== this.relatedSearchRequestId) {
        return;
      }
      this.relatedSearchResults.set([]);
    } finally {
      if (requestId === this.relatedSearchRequestId) {
        this.isSearchingRelated.set(false);
      }
    }
  }

  private async refreshRelatedContactCards(): Promise<void> {
    const related = this.selectedRelatedPatients();
    if (related.length === 0) {
      this.relatedContactCards.set([]);
      return;
    }

    const candidates = await this.loadParentPrefillCandidates(related);
    const cards = candidates.filter((candidate) =>
      this.parentPrefillFields.some((field) => candidate.contacts[field].trim().length > 0)
    );
    this.relatedContactCards.set(cards);
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

  private async searchReferredBySuggestions(term: string): Promise<void> {
    const requestId = ++this.referredBySearchRequestId;
    try {
      const referrals = await this.api.getPatientReferralSuggestions(term);
      if (requestId !== this.referredBySearchRequestId) {
        return;
      }

      this.referredBySuggestions.set(referrals.slice(0, 8));
    } catch {
      if (requestId !== this.referredBySearchRequestId) {
        return;
      }
      this.referredBySuggestions.set([]);
    } finally {
      if (requestId === this.referredBySearchRequestId) {
        this.isSearchingReferredBy.set(false);
      }
    }
  }

  private syncRelatedPeopleField(): void {
    const value = this.selectedRelatedPatients().map((item) => item.fullName).join(', ');
    this.form.controls.relatedPeople.setValue(value);
  }

  private async prefillCoordinatesFromRelatedParentsIfNeeded(): Promise<void> {
    if (!this.isMinorPatient() || this.selectedRelatedPatients().length === 0) {
      return;
    }

    const candidates = await this.loadParentPrefillCandidates(this.selectedRelatedPatients());
    if (candidates.length === 0) {
      return;
    }

    if (candidates.length === 1) {
      this.applyParentCandidateCoordinates(candidates[0], true);
      return;
    }

    this.parentPrefillCandidates.set(candidates);
    this.parentPrefillSelections.set(this.buildDefaultParentPrefillSelections(candidates));
    this.isParentPrefillModalOpen.set(true);
  }

  private async loadParentPrefillCandidates(relatedPatients: Patient[]): Promise<ParentPrefillCandidate[]> {
    const candidates: ParentPrefillCandidate[] = [];

    for (const relatedPatient of relatedPatients) {
      try {
        const detail = await this.api.getPatientDetail(relatedPatient.id);
        candidates.push(this.mapParentPrefillCandidate(detail));
      } catch {
        // Ignore unavailable related profile details.
      }
    }

    return candidates;
  }

  private mapParentPrefillCandidate(detail: PatientDetail): ParentPrefillCandidate {
    return {
      id: detail.id,
      fullName: detail.fullName,
      contacts: {
        mobilePhone: String(detail.mobilePhone ?? '').trim(),
        landlinePhone: String(detail.landlinePhone ?? '').trim(),
        email: String(detail.email ?? '').trim(),
        address1: String(detail.address1 ?? '').trim(),
        address2: String(detail.address2 ?? '').trim(),
        postalCode: String(detail.postalCode ?? '').trim(),
        city: String(detail.city ?? '').trim(),
        country: String(detail.country ?? '').trim()
      }
    };
  }

  private applyParentCandidateCoordinates(candidate: ParentPrefillCandidate, onlyIfCurrentFieldEmpty: boolean): void {
    for (const field of parentContactFields) {
      const current = String(this.form.controls[field].value ?? '').trim();
      if (onlyIfCurrentFieldEmpty && current) {
        continue;
      }

      const next = candidate.contacts[field].trim();
      if (!next) {
        continue;
      }

      this.form.controls[field].setValue(next);
    }
  }

  private buildDefaultParentPrefillSelections(candidates: ParentPrefillCandidate[]): Record<ParentContactField, string> {
    const selections = this.createEmptyParentPrefillSelections();

    for (const field of parentContactFields) {
      const fromFirst = candidates[0]?.contacts[field].trim() ?? '';
      if (fromFirst) {
        selections[field] = fromFirst;
        continue;
      }

      const fromAny = candidates.find((candidate) => candidate.contacts[field].trim())?.contacts[field].trim() ?? '';
      selections[field] = fromAny;
    }

    return selections;
  }

  private createEmptyParentPrefillSelections(): Record<ParentContactField, string> {
    return {
      mobilePhone: '',
      landlinePhone: '',
      email: '',
      address1: '',
      address2: '',
      postalCode: '',
      city: '',
      country: ''
    };
  }

  private computeAgeFromIsoDate(isoDate: string): number | null {
    if (!isoDate) {
      return null;
    }

    const birth = new Date(isoDate);
    if (Number.isNaN(birth.getTime())) {
      return null;
    }

    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
      age -= 1;
    }

    return age >= 0 ? age : null;
  }

  private initAntecedentDatepicker(): void {
    if (!this.isAntecedentModalOpen()) {
      return;
    }

    const ref = this.antecedentDateInputRef();
    if (!ref) {
      return;
    }

    const el = ref.nativeElement;
    this.destroyAntecedentDatepicker();

    const precision = this.antecedentDatePrecision();
    const config =
      precision === 'year'
        ? { format: 'yyyy', minViewMode: 2, startView: 2 }
        : precision === 'month'
          ? { format: 'mm/yyyy', minViewMode: 1, startView: 1 }
          : { format: 'dd/mm/yyyy', minViewMode: 0, startView: 0 };

    $(el)
      .datepicker({
        language: 'fr',
        autoclose: true,
        todayHighlight: true,
        weekStart: 1,
        endDate: new Date(),
        ...config
      })
      .on('changeDate', (e: any) => {
        const picked = e?.format ? e.format(0, config.format) : '';
        this.antecedentDateDisplay.set(picked);
      });
  }

  private destroyAntecedentDatepicker(): void {
    const ref = this.antecedentDateInputRef();
    if (!ref) {
      return;
    }
    $(ref.nativeElement).datepicker('destroy');
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

  private syncMedicalHistoryFromAntecedents(): void {
    const serialized = this.antecedentItems().map((item) => ({
      datePrecision: item.precision,
      date: item.dateDisplay,
      category: item.category,
      description: item.description,
      important: item.important
    }));

    this.form.controls.medicalHistory.setValue(JSON.stringify(serialized));
  }

  private async loadDraft(): Promise<void> {
    let loadedFromApi = false;

    try {
      const draft = await this.api.getNewPatientDraft();
      if (!draft) {
        throw new Error('no-remote-draft');
      }

      loadedFromApi = true;

      const safeStep = draft.step >= 1 && draft.step <= 5 ? draft.step : 1;
      this.currentStep.set(safeStep as 1 | 2 | 3 | 4 | 5);
      this.form.patchValue({ ...draft.payload, isDeceased: false });
      this.primaryDoctorSearch.set(String(draft.payload.primaryDoctor ?? ''));
      this.updateLocationSuggestions(
        String(draft.payload.postalCode ?? ''),
        String(draft.payload.city ?? '')
      );

      const birthDate = draft.payload.birthDate?.trim() ?? '';
      if (birthDate) {
        this.birthDateIso.set(birthDate);
        if (this.isViewReady) {
          this.applyBirthDateToPicker(birthDate);
        } else {
          this.pendingBirthDateIso = birthDate;
        }
      }

      this.restoreAntecedentsFromMedicalHistory(draft.payload.medicalHistory);
      this.restoreConsultationFromNote(draft.payload.consultationNote);
      this.restoreConsultationDocumentsFromPayload(draft.payload.consultationDocuments);

      const updatedAtMs = Number(new Date(draft.updatedAt));
      if (!Number.isNaN(updatedAtMs)) {
        this.lastDraftSavedAt.set(updatedAtMs);
        this.draftSaveState.set('saved');
      }
    } catch {
      if (!loadedFromApi) {
        this.loadLocalDraft();
      }
    }
  }

  private applyBirthDateToPicker(isoDate: string): void {
    const [yearStr, monthStr, dayStr] = isoDate.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);

    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      return;
    }

    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) {
      return;
    }

    const el = this.birthDateInputRef().nativeElement;
    $(el).datepicker('setDate', date);
    this.pendingBirthDateIso = '';
  }

  private restoreAntecedentsFromMedicalHistory(raw: string): void {
    const text = String(raw ?? '').trim();
    if (!text) {
      return;
    }

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        return;
      }

      const items: AntecedentItem[] = [];
      for (const entry of parsed) {
        const precision =
          entry?.datePrecision === 'year' || entry?.datePrecision === 'month' || entry?.datePrecision === 'date'
            ? (entry.datePrecision as AntecedentPrecision)
            : 'date';

        const dateDisplay = typeof entry?.date === 'string' ? entry.date.trim() : '';
        const category = typeof entry?.category === 'string' ? entry.category.trim() : '';
        const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
        const important = Boolean(entry?.important);

        if (!dateDisplay || !category) {
          continue;
        }

        const sortKey = this.buildAntecedentSortKey(precision, dateDisplay);
        if (sortKey === null) {
          continue;
        }

        items.push({
          id: this.antecedentIdSequence++,
          precision,
          dateDisplay,
          sortKey,
          category,
          description,
          important
        });

        this.ensureAntecedentOption(category);
      }

      if (items.length) {
        this.antecedentItems.set(items.sort((a, b) => b.sortKey - a.sortKey));
      }
    } catch {
      // Keep legacy text value if not JSON.
    }
  }

  private async persistDraft(): Promise<void> {
    if (this.isPersistingDraft) {
      this.pendingDraftSave = true;
      return;
    }

    this.isPersistingDraft = true;
    this.draftSaveState.set('saving');
    try {
      this.syncConsultationNoteFromState();
      const payload = this.buildPatientPayload();
      await this.api.saveNewPatientDraft(this.currentStep(), payload);
      this.saveLocalDraft(this.currentStep(), payload);
      this.lastDraftSavedAt.set(Date.now());
      this.draftSaveState.set('saved');
    } catch {
      const payload = this.buildPatientPayload();
      const localSaved = this.saveLocalDraft(this.currentStep(), payload);
      if (localSaved) {
        this.lastDraftSavedAt.set(Date.now());
        this.draftSaveState.set('saved');
      } else {
        this.draftSaveState.set('error');
      }
    } finally {
      this.isPersistingDraft = false;
      if (this.pendingDraftSave) {
        this.pendingDraftSave = false;
        void this.persistDraft();
      }
    }
  }

  private loadLocalDraft(): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(LOCAL_DRAFT_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        step?: number;
        payload?: Record<string, unknown>;
        updatedAt?: number;
      };

      if (!parsed.payload) {
        return;
      }

      const safeStep = (parsed.step ?? 1) >= 1 && (parsed.step ?? 1) <= 5 ? (parsed.step as number) : 1;
      const payload = parsed.payload as typeof this.form.value;

      this.currentStep.set(safeStep as 1 | 2 | 3 | 4 | 5);
      this.form.patchValue({ ...payload, isDeceased: false });
      this.primaryDoctorSearch.set(String(payload.primaryDoctor ?? ''));
      this.updateLocationSuggestions(String(payload.postalCode ?? ''), String(payload.city ?? ''));

      const birthDate = String(payload.birthDate ?? '').trim();
      if (birthDate) {
        this.birthDateIso.set(birthDate);
        if (this.isViewReady) {
          this.applyBirthDateToPicker(birthDate);
        } else {
          this.pendingBirthDateIso = birthDate;
        }
      }

      this.restoreAntecedentsFromMedicalHistory(String(payload.medicalHistory ?? ''));
      this.restoreConsultationFromNote(String(payload.consultationNote ?? ''));
      this.restoreConsultationDocumentsFromPayload((payload as { consultationDocuments?: unknown }).consultationDocuments);

      if (typeof parsed.updatedAt === 'number') {
        this.lastDraftSavedAt.set(parsed.updatedAt);
        this.draftSaveState.set('saved');
      }
    } catch {
      // Ignore malformed local draft.
    }
  }

  private saveLocalDraft(step: number, payload: object): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      window.localStorage.setItem(
        LOCAL_DRAFT_KEY,
        JSON.stringify({
          step,
          payload,
          updatedAt: Date.now()
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  private clearLocalDraft(): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.removeItem(LOCAL_DRAFT_KEY);
    } catch {
      // Ignore storage failures.
    }
  }

  private buildPatientPayload(linkStrategy?: 'attach-existing' | 'create-new'): CreatePatientPayload {
    const raw = this.form.getRawValue();
    const documents = this.serializeConsultationDocumentsForPayload();

    return {
      ...raw,
      isDeceased: false,
      consultationDocuments: documents.length > 0 ? documents : undefined,
      ...(linkStrategy ? { consultationLinkStrategy: linkStrategy } : {})
    };
  }

  private serializeConsultationDocumentsForPayload(): ConsultationDocumentUploadPayload[] {
    return this.consultationDocuments()
      .map((item) => ({
        documentRef: item.documentRef,
        fileName: item.fileName.trim(),
        mimeType: item.mimeType.trim() || 'application/octet-stream',
        sizeBytes: Math.max(0, Number(item.sizeBytes) || 0),
        title: item.title.trim() || item.fileName.trim(),
        comment: item.comment.trim(),
        contentBase64: item.contentBase64.trim()
      }))
      .filter((item) => item.fileName && item.contentBase64);
  }

  private restoreConsultationDocumentsFromPayload(raw: unknown): void {
    if (!Array.isArray(raw) || raw.length === 0) {
      return;
    }

    const restored: ConsultationUploadDocument[] = raw
      .map((item) => {
        const fileName = String((item as { fileName?: unknown }).fileName ?? '').trim();
        const contentBase64 = String((item as { contentBase64?: unknown }).contentBase64 ?? '').trim();
        if (!fileName || !contentBase64) {
          return null;
        }

        return {
          tempKey: this.createTempKey('doc'),
          documentRef: String((item as { documentRef?: unknown }).documentRef ?? '').trim() || this.createDocumentRef(),
          fileName,
          mimeType: String((item as { mimeType?: unknown }).mimeType ?? '').trim() || 'application/octet-stream',
          sizeBytes: Math.max(0, Number((item as { sizeBytes?: unknown }).sizeBytes) || 0),
          title: String((item as { title?: unknown }).title ?? '').trim() || fileName,
          comment: String((item as { comment?: unknown }).comment ?? '').trim(),
          contentBase64
        } satisfies ConsultationUploadDocument;
      })
      .filter((item): item is ConsultationUploadDocument => item !== null);

    if (restored.length > 0) {
      this.consultationDocuments.set(restored);
    }
  }

  private async addConsultationDocuments(files: File[]): Promise<void> {
    const documentsToAdd: ConsultationUploadDocument[] = [];

    for (const file of files) {
      const normalizedName = file.name.trim();
      if (!normalizedName) {
        continue;
      }

      const dataUrl = await this.readFileAsDataUrl(file);
      const base64Payload = this.extractBase64Payload(dataUrl);
      if (!base64Payload) {
        continue;
      }

      documentsToAdd.push({
        tempKey: this.createTempKey('doc'),
        documentRef: this.createDocumentRef(),
        fileName: normalizedName,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: Number(file.size) || 0,
        title: normalizedName,
        comment: '',
        contentBase64: base64Payload
      });
    }

    if (documentsToAdd.length > 0) {
      this.consultationDocuments.update((items) => [...items, ...documentsToAdd]);
      this.syncConsultationNoteFromState();
    }
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }

        reject(new Error('INVALID_FILE_RESULT'));
      };

      reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_ERROR'));
      reader.readAsDataURL(file);
    });
  }

  private extractBase64Payload(dataUrl: string): string {
    const raw = String(dataUrl ?? '').trim();
    const commaIndex = raw.indexOf(',');
    if (commaIndex < 0) {
      return '';
    }

    return raw.slice(commaIndex + 1).trim();
  }

  private createDocumentRef(): string {
    const random = Math.random().toString(36).slice(2, 10);
    return `doc_${Date.now().toString(36)}_${random}`;
  }

  private createTempKey(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private parseNullableNumber(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed > 0 ? parsed : null;
  }

  private getEditorElement(field: 'motifMain' | 'tests' | 'schema' | 'treatments' | 'remarks'): HTMLDivElement | null {
    if (field === 'motifMain') return this.motifMainEditorRef()?.nativeElement ?? null;
    if (field === 'tests') return this.testsEditorRef()?.nativeElement ?? null;
    if (field === 'schema') return this.schemaEditorRef()?.nativeElement ?? null;
    if (field === 'treatments') return this.treatmentsEditorRef()?.nativeElement ?? null;
    return this.remarksEditorRef()?.nativeElement ?? null;
  }

  private buildConsultationDraft(): ConsultationDraft {
    return {
      startedAt: this.consultationStartedAtIso(),
      officeId: this.consultationOfficeId(),
      officeName: this.consultationOfficeName(),
      practitioner: this.consultationPractitioner(),
      practitionerUsername: this.consultationPractitionerUsername() || undefined,
      title: this.consultationTitle(),
      important: this.consultationImportant(),
      heightCm: this.consultationHeightCm(),
      weightKg: this.consultationWeightKg(),
      evaBefore: this.consultationEvaBefore(),
      evaAfter: this.consultationEvaAfter(),
      profile: this.consultationProfile(),
      selectedReasons: this.consultationSelectedReasonItems().map((item) => item.label),
      reasonItems: this.consultationSelectedReasonItems(),
      documentRefs: this.consultationDocuments().map((item) => item.documentRef),
      motifMainHtml: this.consultationMotifMainHtml(),
      testsHtml: this.consultationTestsHtml(),
      schemaHtml: this.consultationSchemaHtml(),
      treatmentsHtml: this.consultationTreatmentsHtml(),
      remarksHtml: this.consultationRemarksHtml()
    };
  }

  private syncConsultationNoteFromState(): void {
    this.form.controls.consultationNote.setValue(JSON.stringify(this.buildConsultationDraft()));
  }

  private hasConsultationContent(): boolean {
    return Boolean(
      this.consultationTitle().trim() ||
      this.consultationSelectedReasonItems().length > 0 ||
      this.consultationDocuments().length > 0 ||
      this.consultationMotifMainHtml().trim() ||
      this.consultationTestsHtml().trim() ||
      this.consultationSchemaHtml().trim() ||
      this.consultationTreatmentsHtml().trim() ||
      this.consultationRemarksHtml().trim()
    );
  }

  private restoreConsultationFromNote(raw: string): void {
    const text = String(raw ?? '').trim();
    if (!text) {
      return;
    }

    try {
      const parsed = JSON.parse(text) as Partial<ConsultationDraft>;

      if (typeof parsed.startedAt === 'string' && parsed.startedAt.trim()) {
        this.consultationStartedAtIso.set(parsed.startedAt);
      }

      if (typeof parsed.officeName === 'string') {
        this.consultationOfficeName.set(parsed.officeName.trim() || null);
      }

      if (Number.isInteger(parsed.officeId) && Number(parsed.officeId) > 0) {
        this.consultationOfficeId.set(Number(parsed.officeId));
      }

      if (typeof parsed.practitioner === 'string') {
        this.consultationPractitioner.set(parsed.practitioner.trim());
      }

      if (typeof parsed.practitionerUsername === 'string') {
        this.consultationPractitionerUsername.set(parsed.practitionerUsername.trim());
      }

      if (typeof parsed.title === 'string') {
        this.consultationTitle.set(parsed.title);
      }

      this.consultationImportant.set(Boolean(parsed.important));
      this.consultationHeightCm.set(typeof parsed.heightCm === 'number' ? parsed.heightCm : null);
      this.consultationWeightKg.set(typeof parsed.weightKg === 'number' ? parsed.weightKg : null);
      this.consultationEvaBefore.set(typeof parsed.evaBefore === 'number' ? parsed.evaBefore : 0);
      this.consultationEvaAfter.set(typeof parsed.evaAfter === 'number' ? parsed.evaAfter : 0);

      if (typeof parsed.profile === 'string') {
        this.consultationProfile.set(parsed.profile.trim());
      }

      if (Array.isArray(parsed.reasonItems)) {
        const fromItems: Record<string, ConsultationReasonSelection> = {};
        for (const item of parsed.reasonItems) {
          const label = String(item?.label ?? '').trim();
          if (!label) {
            continue;
          }

          fromItems[label] = {
            checked: true,
            value: String(item?.value ?? ''),
            important: Boolean(item?.important)
          };
        }
        this.consultationReasonSelections.set(fromItems);
      } else if (Array.isArray(parsed.selectedReasons)) {
        const fromLegacy: Record<string, ConsultationReasonSelection> = {};
        for (const item of parsed.selectedReasons) {
          const label = String(item ?? '').trim();
          if (!label) {
            continue;
          }
          fromLegacy[label] = { checked: true, value: '', important: false };
        }
        this.consultationReasonSelections.set(fromLegacy);
      }

      this.consultationMotifMainHtml.set(typeof parsed.motifMainHtml === 'string' ? parsed.motifMainHtml : '');
      this.consultationTestsHtml.set(typeof parsed.testsHtml === 'string' ? parsed.testsHtml : '');
      this.consultationSchemaHtml.set(typeof parsed.schemaHtml === 'string' ? parsed.schemaHtml : '');
      this.consultationTreatmentsHtml.set(typeof parsed.treatmentsHtml === 'string' ? parsed.treatmentsHtml : '');
      this.consultationRemarksHtml.set(typeof parsed.remarksHtml === 'string' ? parsed.remarksHtml : '');

      this.syncConsultationNoteFromState();
    } catch {
      this.consultationRemarksHtml.set(text);
      this.syncConsultationNoteFromState();
    }
  }

  private clearConsultationData(): void {
    this.consultationStartedAtIso.set(new Date().toISOString());
    this.consultationPractitioner.set('');
    this.consultationPractitionerUsername.set('');
    this.consultationTitle.set('');
    this.consultationImportant.set(false);
    this.consultationHeightCm.set(null);
    this.consultationWeightKg.set(null);
    this.consultationEvaBefore.set(0);
    this.consultationEvaAfter.set(0);
    this.consultationProfile.set(this.consultationProfileOptions()[0] ?? '');
    this.consultationReasonSelections.set({});
    this.consultationDocuments.set([]);
    this.consultationMotifMainHtml.set('');
    this.consultationTestsHtml.set('');
    this.consultationSchemaHtml.set('');
    this.consultationTreatmentsHtml.set('');
    this.consultationRemarksHtml.set('');
    this.syncConsultationNoteFromState();
  }

  private async loadConsultationContext(activeOfficeId: number | null | undefined): Promise<void> {
    try {
      const officeId = Number.isInteger(activeOfficeId) && Number(activeOfficeId) > 0
        ? Number(activeOfficeId)
        : null;

      const context = await this.api.getConsultationContext(officeId);
      this.consultationOfficeId.set(context.officeId ?? null);
      this.consultationOfficeName.set(context.officeName ?? null);

      const practitioners = Array.isArray(context.practitioners) ? context.practitioners : [];
      this.practitioners.set(practitioners);

      const officeProfiles = Array.isArray(context.profiles) ? context.profiles : [];
      this.consultationOfficeProfiles.set(officeProfiles);

      await this.loadConsultationBillingCatalog(context.officeId ?? officeId);

      const profileNames = officeProfiles
        .map((item) => String(item.name ?? '').trim())
        .filter((name, index, all) => Boolean(name) && all.indexOf(name) === index);
      this.consultationProfileOptions.set(profileNames);

      if (!profileNames.includes(this.consultationProfile())) {
        this.consultationProfile.set(profileNames[0] ?? '');
      }

      const availableReasons = new Set(this.consultationProfileReasons());
      this.consultationReasonSelections.update((items) => {
        const next: Record<string, ConsultationReasonSelection> = {};
        for (const reason of availableReasons) {
          next[reason] = items[reason] ?? { checked: false, value: '', important: false };
        }
        return next;
      });

      if (!this.consultationPractitioner()) {
        const sessionPractitioner = this.authService.username().trim();
        const match = practitioners.find((item) => item.username === sessionPractitioner);
        if (match) {
          const displayName = String(match.displayName ?? '').trim() || match.username;
          this.consultationPractitioner.set(displayName);
          this.consultationPractitionerUsername.set(match.username);
        } else if (practitioners[0]) {
          const displayName = String(practitioners[0].displayName ?? '').trim() || practitioners[0].username;
          this.consultationPractitioner.set(displayName);
          this.consultationPractitionerUsername.set(practitioners[0].username);
        }
        this.syncConsultationNoteFromState();
      }
    } catch {
      this.consultationOfficeId.set(null);
      this.consultationOfficeName.set(null);
      this.practitioners.set([]);
      this.consultationOfficeProfiles.set([]);
      this.consultationProfileOptions.set([]);
      this.consultationProfile.set('');
      this.consultationReasonSelections.set({});
      this.consultationBillingServiceOptions.set([]);
      this.consultationBillingPaymentMethodOptions.set([]);
      this.applyConsultationBillingDefaults();
    }
  }

  private async loadConsultationBillingCatalog(activeOfficeId: number | null): Promise<void> {
    try {
      const offices = await this.api.getOffices();
      const officeId = Number.isInteger(activeOfficeId) && Number(activeOfficeId) > 0
        ? Number(activeOfficeId)
        : null;

      const office = (officeId !== null
        ? offices.find((item) => item.id === officeId)
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

  private interpolateColor(startHex: string, endHex: string, ratio: number): string {
    const clamp = Math.max(0, Math.min(1, ratio));
    const start = this.hexToRgb(startHex);
    const end = this.hexToRgb(endHex);

    const r = Math.round(start.r + ((end.r - start.r) * clamp));
    const g = Math.round(start.g + ((end.g - start.g) * clamp));
    const b = Math.round(start.b + ((end.b - start.b) * clamp));

    return `rgb(${r}, ${g}, ${b})`;
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const normalized = hex.replace('#', '').trim();
    if (normalized.length !== 6) {
      return { r: 0, g: 0, b: 0 };
    }

    const value = Number.parseInt(normalized, 16);
    if (!Number.isFinite(value)) {
      return { r: 0, g: 0, b: 0 };
    }

    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255
    };
  }

  private toDateTimeLocalValue(iso: string): string {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }

    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    const hour = String(parsed.getHours()).padStart(2, '0');
    const minute = String(parsed.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  }

  private formatConsultationDate(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(parsed);
  }

  private fromDateTimeLocalValue(value: string): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
      return null;
    }

    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString();
  }

  private async loadAntecedentTypes(): Promise<void> {
    try {
      const fromApi = await this.api.getAntecedentTypes();
      if (!fromApi.length) {
        return;
      }

      this.antecedentCategoryOptions.set(
        [...new Set(fromApi.map((item) => item.trim()).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b, 'fr', { sensitivity: 'base' })
        )
      );
    } catch {
      // Keep default options if endpoint fails.
    }
  }

  private ensureAntecedentOption(value: string): void {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }

    this.antecedentCategoryOptions.update((items) => {
      if (items.some((item) => item.localeCompare(normalized, 'fr', { sensitivity: 'base' }) === 0)) {
        return items;
      }

      return [...items, normalized].sort((a, b) =>
        a.localeCompare(b, 'fr', { sensitivity: 'base' })
      );
    });
  }

  private async loadLocationPairs(): Promise<void> {
    try {
      const pairs = await this.api.getPatientLocations();
      this.locationPairs.set(pairs);
      this.updateLocationSuggestions(this.form.controls.postalCode.value, this.form.controls.city.value);
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
      const postal = pair.postalCode.toLowerCase();
      const cityName = pair.city.toLowerCase();
      return (!postalQuery || postal.includes(postalQuery)) && (!cityQuery || cityName.includes(cityQuery));
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

    const currentCity = this.form.controls.city.value.trim().toLowerCase();
    if (exactMatches.some((pair) => pair.city.toLowerCase() === currentCity)) {
      return;
    }

    this.isSynchronizingLocationFields = true;
    this.form.controls.city.setValue(exactMatches[0].city);
    this.isSynchronizingLocationFields = false;
    this.updateLocationSuggestions(this.form.controls.postalCode.value, this.form.controls.city.value);
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

    const currentPostalCode = this.form.controls.postalCode.value.trim().toLowerCase();
    if (exactMatches.some((pair) => pair.postalCode.toLowerCase() === currentPostalCode)) {
      return;
    }

    this.isSynchronizingLocationFields = true;
    this.form.controls.postalCode.setValue(exactMatches[0].postalCode);
    this.isSynchronizingLocationFields = false;
    this.updateLocationSuggestions(this.form.controls.postalCode.value, this.form.controls.city.value);
  }
}
