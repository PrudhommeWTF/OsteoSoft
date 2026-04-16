import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { LocationPair, Patient, PatientDetail, PeoplePickerContact, Practitioner } from '../../core/api.types';

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

type DraftSaveState = 'idle' | 'saving' | 'saved' | 'error';

type ConsultationTab = 'consultation' | 'documents' | 'courriers' | 'paiement';
type PatientProfile = 'Adulte' | 'Femme enceinte' | 'Nourrisson' | 'Enfant';

type ConsultationDraft = {
  startedAt: string;
  practitioner: string;
  title: string;
  important: boolean;
  heightCm: number | null;
  weightKg: number | null;
  evaBefore: number;
  evaAfter: number;
  profile: PatientProfile;
  motifMainHtml: string;
  testsHtml: string;
  schemaHtml: string;
  treatmentsHtml: string;
  remarksHtml: string;
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
  readonly consultationPractitioner = signal('');
  readonly practitioners = signal<Practitioner[]>([]);
  readonly consultationTitle = signal('');
  readonly consultationImportant = signal(false);
  readonly consultationHeightCm = signal<number | null>(null);
  readonly consultationWeightKg = signal<number | null>(null);
  readonly consultationEvaBefore = signal(0);
  readonly consultationEvaAfter = signal(0);
  readonly consultationProfile = signal<PatientProfile>('Adulte');
  readonly consultationMotifMainHtml = signal('');
  readonly consultationTestsHtml = signal('');
  readonly consultationSchemaHtml = signal('');
  readonly consultationTreatmentsHtml = signal('');
  readonly consultationRemarksHtml = signal('');
  readonly isConsultationLinkStrategyModalOpen = signal(false);

  readonly consultationProfileOptions: PatientProfile[] = ['Adulte', 'Femme enceinte', 'Nourrisson', 'Enfant'];

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
    this.consultationPractitioner.set(value.trim());
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
    if (value === 'Adulte' || value === 'Femme enceinte' || value === 'Nourrisson' || value === 'Enfant') {
      this.consultationProfile.set(value);
      this.syncConsultationNoteFromState();
    }
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
    void this.loadPractitioners();
    void this.loadLocationPairs();

    const sessionPractitioner = this.authService.username().trim();
    if (sessionPractitioner) {
      this.consultationPractitioner.set(sessionPractitioner);
    }

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
      const payload = {
        ...this.form.getRawValue(),
        isDeceased: false,
        ...(this.hasConsultationContent() && this.pendingConsultationLinkStrategy
          ? { consultationLinkStrategy: this.pendingConsultationLinkStrategy }
          : {})
      };
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
      const payload = { ...this.form.getRawValue(), isDeceased: false };
      await this.api.saveNewPatientDraft(this.currentStep(), payload);
      this.saveLocalDraft(this.currentStep(), payload);
      this.lastDraftSavedAt.set(Date.now());
      this.draftSaveState.set('saved');
    } catch {
      const payload = { ...this.form.getRawValue(), isDeceased: false };
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
      practitioner: this.consultationPractitioner(),
      title: this.consultationTitle(),
      important: this.consultationImportant(),
      heightCm: this.consultationHeightCm(),
      weightKg: this.consultationWeightKg(),
      evaBefore: this.consultationEvaBefore(),
      evaAfter: this.consultationEvaAfter(),
      profile: this.consultationProfile(),
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

      if (typeof parsed.practitioner === 'string') {
        this.consultationPractitioner.set(parsed.practitioner.trim());
      }

      if (typeof parsed.title === 'string') {
        this.consultationTitle.set(parsed.title);
      }

      this.consultationImportant.set(Boolean(parsed.important));
      this.consultationHeightCm.set(typeof parsed.heightCm === 'number' ? parsed.heightCm : null);
      this.consultationWeightKg.set(typeof parsed.weightKg === 'number' ? parsed.weightKg : null);
      this.consultationEvaBefore.set(typeof parsed.evaBefore === 'number' ? parsed.evaBefore : 0);
      this.consultationEvaAfter.set(typeof parsed.evaAfter === 'number' ? parsed.evaAfter : 0);

      if (
        parsed.profile === 'Adulte' ||
        parsed.profile === 'Femme enceinte' ||
        parsed.profile === 'Nourrisson' ||
        parsed.profile === 'Enfant'
      ) {
        this.consultationProfile.set(parsed.profile);
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
    this.consultationTitle.set('');
    this.consultationImportant.set(false);
    this.consultationHeightCm.set(null);
    this.consultationWeightKg.set(null);
    this.consultationEvaBefore.set(0);
    this.consultationEvaAfter.set(0);
    this.consultationProfile.set('Adulte');
    this.consultationMotifMainHtml.set('');
    this.consultationTestsHtml.set('');
    this.consultationSchemaHtml.set('');
    this.consultationTreatmentsHtml.set('');
    this.consultationRemarksHtml.set('');
    this.syncConsultationNoteFromState();
  }

  private async loadPractitioners(): Promise<void> {
    try {
      const practitioners = await this.api.getPractitioners();
      this.practitioners.set(practitioners);

      if (!this.consultationPractitioner()) {
        const sessionPractitioner = this.authService.username().trim();
        const match = practitioners.find((item) => item.username === sessionPractitioner);
        if (match) {
          this.consultationPractitioner.set(match.username);
        } else if (practitioners[0]) {
          this.consultationPractitioner.set(practitioners[0].username);
        }
        this.syncConsultationNoteFromState();
      }
    } catch {
      this.practitioners.set([]);
    }
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
