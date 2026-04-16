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
import { NgTemplateOutlet } from '@angular/common';

import { ApiService } from '../../core/api.service';
import { ConsultationRecord, LocationPair, Patient, PatientAuditLog, PatientDetail } from '../../core/api.types';
import { TopbarService } from '../../core/topbar.service';

declare const $: any;

type AccordionSection = 'informations' | 'antecedents' | 'documents' | 'consultations';

type ConsultationGroup =
  | { type: 'recent'; consultations: ConsultationRecord[] }
  | { type: 'year'; year: number; consultations: ConsultationRecord[] };

type Antecedent = { category: string; label: string; date?: string };

@Component({
  selector: 'app-patient-detail-page',
  imports: [RouterLink, ReactiveFormsModule, NgTemplateOutlet],
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
  private isViewReady = false;
  private isDatepickerInitialized = false;
  private pendingBirthDateIso = '';
  private relatedSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private relatedSearchRequestId = 0;

  readonly isLoading = signal(true);
  readonly patient = signal<PatientDetail | null>(null);
  readonly consultations = signal<ConsultationRecord[]>([]);
  readonly expandedSections = signal<Set<AccordionSection>>(new Set(['informations']));
  readonly isSaving = signal(false);
  readonly saveError = signal('');
  readonly expandedConsultations = signal(new Set<number>());
  readonly expandedYears = signal(new Set<number>());

  // Related people picker
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
  readonly showAuditModal = signal(false);
  readonly isLoadingAuditLogs = signal(false);
  readonly auditLoadError = signal('');
  readonly auditLogs = signal<PatientAuditLog[]>([]);

  // Internal birthDate ISO (driven by datepicker)
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
    generalRemarks: ['', Validators.maxLength(5000)],
    relatedPeople: ['', Validators.maxLength(500)],
    medicalHistory: ['', Validators.maxLength(5000)]
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

  readonly birthDateLabel = computed(() => {
    const bd = this.patient()?.birthDate;
    if (!bd) return '';
    const date = new Date(bd);
    if (Number.isNaN(date.getTime())) return bd;
    return new Intl.DateTimeFormat('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  });

  readonly editSexValue = this.editSex.asReadonly();

  readonly editAgeText = computed(() => {
    const bd = this.birthDateIso();
    if (!bd) return '';
    const date = new Date(bd);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    let age = now.getFullYear() - date.getFullYear();
    const beforeBirthday =
      now.getMonth() < date.getMonth() ||
      (now.getMonth() === date.getMonth() && now.getDate() < date.getDate());
    if (beforeBirthday) age--;
    if (age < 0) return '';
    return `${age} ans`;
  });

  readonly antecedents = computed((): Antecedent[] => {
    const mh = this.patient()?.medicalHistory ?? '';
    if (!mh) return [];
    try { return JSON.parse(mh) as Antecedent[]; } catch { return []; }
  });

  readonly antecedentGroups = computed(() => {
    const groups = new Map<string, Antecedent[]>();
    for (const a of this.antecedents()) {
      if (!groups.has(a.category)) groups.set(a.category, []);
      groups.get(a.category)!.push(a);
    }
    return [...groups.entries()].map(([category, items]) => ({ category, items }));
  });

  readonly groupedConsultations = computed((): ConsultationGroup[] => {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const recent: ConsultationRecord[] = [];
    const byYear = new Map<number, ConsultationRecord[]>();

    for (const c of this.consultations()) {
      const date = new Date(c.startedAt);
      if (date >= oneYearAgo) {
        recent.push(c);
      } else {
        const year = date.getFullYear();
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year)!.push(c);
      }
    }

    const groups: ConsultationGroup[] = [];
    if (recent.length) groups.push({ type: 'recent', consultations: recent });
    for (const [year, cons] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
      groups.push({ type: 'year', year, consultations: cons });
    }
    return groups;
  });

  readonly totalConsultationCount = computed(() => this.consultations().length);

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

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    void this.loadLocationPairs();
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
    void this.load(id);
  }

  ngAfterViewInit(): void {
    this.isViewReady = true;
    // The input is rendered only after patient load; init once the view has painted.
    queueMicrotask(() => this.initDatepicker());
  }

  ngOnDestroy(): void {
    this.topbar.clear();
    const el = this.birthDateInputRef()?.nativeElement;
    if (el) {
      try { $(el).datepicker('destroy'); } catch { /* ignore */ }
    }
    this.isDatepickerInitialized = false;
    if (this.relatedSearchDebounceId !== null) {
      clearTimeout(this.relatedSearchDebounceId);
    }
  }

  private initDatepicker(): void {
    const el = this.birthDateInputRef()?.nativeElement;
    if (!el) return;
    if (this.isDatepickerInitialized) return;
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
    const el = this.birthDateInputRef()?.nativeElement;
    if (!el || !iso) return;
    const [year, month, day] = iso.split('-').map(Number);
    if (!year || !month || !day) return;
    try {
      $(el).datepicker('setDate', new Date(year, month - 1, day));
    } catch { /* ignore */ }
  }

  private async load(id: number): Promise<void> {
    this.isLoading.set(true);
    try {
      const [patient, consultations] = await Promise.all([
        this.api.getPatientDetail(id),
        this.api.getPatientConsultations(id)
      ]);
      this.patient.set(patient);
      this.consultations.set(consultations);
      this.startEdit();
    } catch {
      this.patient.set(null);
    } finally {
      this.isLoading.set(false);
    }
  }

  toggleSection(section: AccordionSection): void {
    this.expandedSections.update((s) => {
      const next = new Set(s);
      next.has(section) ? next.delete(section) : next.add(section);
      return next;
    });
  }

  startEdit(): void {
    const p = this.patient();
    if (!p) return;
    this.editForm.reset({
      lastName: p.lastName,
      firstName: p.firstName,
      sex: p.sex,
      birthDate: p.birthDate,
      mobilePhone: p.mobilePhone,
      landlinePhone: p.landlinePhone,
      email: p.email,
      address1: p.address1,
      address2: p.address2,
      postalCode: p.postalCode,
      city: p.city,
      country: p.country,
      generalRemarks: p.generalRemarks,
      relatedPeople: p.relatedPeople,
      medicalHistory: p.medicalHistory
    });
    this.editSex.set(p.sex);
    this.birthDateIso.set(p.birthDate ?? '');
    this.saveError.set('');
    this.updateLocationSuggestions(p.postalCode, p.city);

    if (this.isViewReady) {
      queueMicrotask(() => {
        this.initDatepicker();
        if (p.birthDate) {
          this.applyBirthDateToPicker(p.birthDate);
        }
      });
    } else if (p.birthDate) {
      this.pendingBirthDateIso = p.birthDate;
    }
  }

  setEditSex(value: PatientDetail['sex']): void {
    this.editForm.controls.sex.setValue(value);
    this.editSex.set(value);
    this.cdr.markForCheck();
  }

  // ── Related people picker ──────────────────────────────

  toggleRelatedPicker(): void {
    this.showRelatedPicker.update((v) => !v);
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

  private async searchRelatedPatients(term: string): Promise<void> {
    const requestId = ++this.relatedSearchRequestId;
    try {
      const results: Patient[] = await this.api.getPatients(term);
      if (requestId !== this.relatedSearchRequestId) return;
      const existingIds = new Set(this.selectedRelatedPatients().map((p) => p.id));
      const currentId = this.patient()?.id;
      this.relatedSearchResults.set(
        results.filter((p: Patient) => !existingIds.has(p.id) && p.id !== currentId)
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

  addRelatedPatient(patient: Patient): void {
    this.selectedRelatedPatients.update((items) => {
      if (items.some((item) => item.id === patient.id)) return items;
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

  private syncRelatedPeopleField(): void {
    const value = this.selectedRelatedPatients()
      .map((p) => p.fullName)
      .join(', ');
    this.editForm.controls.relatedPeople.setValue(value);
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

  // ── Save ──────────────────────────────────────────────

  async saveEdit(): Promise<void> {
    if (this.editForm.invalid || this.isSaving()) return;
    const id = this.patient()!.id;
    this.isSaving.set(true);
    this.saveError.set('');
    try {
      const { relatedPeople, ...rest } = this.editForm.getRawValue();
      await this.api.updatePatient(id, {
        ...rest,
        relatedPeople: this.editForm.controls.relatedPeople.value
      });
      await this.load(id);
    } catch {
      this.saveError.set('Une erreur est survenue lors de la sauvegarde.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async openAuditModal(): Promise<void> {
    const id = this.patient()?.id;
    if (!id) return;

    this.showAuditModal.set(true);
    this.isLoadingAuditLogs.set(true);
    this.auditLoadError.set('');

    try {
      const logs = await this.api.getPatientAuditLogs(id);
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

  // ── Consultations ─────────────────────────────────────

  toggleConsultation(id: number): void {
    this.expandedConsultations.update((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  toggleYear(year: number): void {
    this.expandedYears.update((s) => {
      const next = new Set(s);
      next.has(year) ? next.delete(year) : next.add(year);
      return next;
    });
  }

  consultationBmi(c: ConsultationRecord): string | null {
    if (!c.heightCm || !c.weightKg) return null;
    return (c.weightKg / ((c.heightCm / 100) ** 2)).toFixed(1);
  }

  formatConsultationDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    }).format(date);
  }

  formatShortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  }
}
