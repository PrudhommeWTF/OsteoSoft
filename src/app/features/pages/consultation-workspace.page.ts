import {
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
import { SlicePipe } from '@angular/common';
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
  OfficeConsultationProfile,
  PatientDetail,
  PatientDocumentSummary,
  MyUserProfile,
  Office,
  Practitioner,
  UserAgendaPreferences
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { HtmlSanitizerService } from '../../core/html-sanitizer.service';
import { TopbarService } from '../../core/topbar.service';
import { BsTooltipDirective } from '../../core/bs-tooltip.directive';
import { PdfBuilderService, PAYMENT_PENDING_LABEL } from '../../core/pdf-builder.service';
import { ConsultationCanvasComponent } from '../consultation-canvas/consultation-canvas.component';
import { DatePickerComponent } from '../../shared/date-picker/date-picker.component';

type ConsultationEditorSection = 'motifMainHtml' | 'testsHtml' | 'schemaHtml' | 'treatmentsHtml' | 'remarksHtml';
type WorkspaceTab = 'consultation' | 'documents' | 'courriers' | 'paiement';
type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'disabled';

type ConsultationReasonSelection = {
  checked: boolean;
  value: string;
  important: boolean;
};

type ConsultationUploadDocument = Omit<ConsultationDocumentUploadPayload, 'documentRef'> & {
  documentRef: string;
  tempKey: string;
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

type OfficePatientLetterTemplate = {
  kind: 'payment-reminder' | 'patient-template';
  title: string;
  content: string;
};

const CONSULTATION_BILLING_STORAGE_KEY = 'osteosoft:consultation-billing:v1';

@Component({
  selector: 'app-consultation-workspace-page',
  imports: [RouterLink, ReactiveFormsModule, SlicePipe, BsTooltipDirective, ConsultationCanvasComponent, DatePickerComponent],
  templateUrl: './consultation-workspace.page.html',
  styleUrl: './consultation-workspace.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsultationWorkspacePage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);
  private readonly htmlSanitizer = inject(HtmlSanitizerService);
  private readonly pdfBuilder = inject(PdfBuilderService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly topbar = inject(TopbarService);
  private readonly cdr = inject(ChangeDetectorRef);
  readonly Math = Math;

  private readonly amountFormatter = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  private readonly motifMainEditorRef = viewChild<ElementRef<HTMLDivElement>>('motifMainEditor');
  private readonly testsEditorRef = viewChild<ElementRef<HTMLDivElement>>('testsEditor');
  private readonly treatmentsEditorRef = viewChild<ElementRef<HTMLDivElement>>('treatmentsEditor');
  private readonly remarksEditorRef = viewChild<ElementRef<HTMLDivElement>>('remarksEditor');

  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private autosaveStatusTimer: ReturnType<typeof setInterval> | null = null;
  private autosaveToastHideTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveToastLastShownAt = 0;
  private isPersistingDraft = false;
  private pendingDraftSave = false;
  private loadContextPromise: Promise<void> | null = null;

  // Route params
  readonly patientId = signal<number | null>(null);
  readonly consultationId = signal<number | null>(null);
  readonly mode = computed<'create' | 'edit'>(() => this.consultationId() !== null ? 'edit' : 'create');

  // Loaded data
  readonly patient = signal<PatientDetail | null>(null);
  readonly consultation = signal<ConsultationRecord | null>(null);
  readonly patientDocuments = signal<PatientDocumentSummary[]>([]);
  readonly preferences = signal<UserAgendaPreferences | null>(null);
  readonly isLoading = signal(true);
  readonly loadError = signal('');

  // Context
  readonly practitioners = signal<Practitioner[]>([]);
  readonly officeProfiles = signal<OfficeConsultationProfile[]>([]);
  readonly officeId = signal<number | null>(null);
  readonly officeName = signal<string | null>(null);
  readonly billingServiceOptions = signal<Array<{ label: string; amountHt: number; tvaRate: number }>>([]);
  readonly billingPaymentMethodOptions = signal<string[]>([]);
  readonly letterTemplates = signal<OfficePatientLetterTemplate[]>([]);
  readonly isLoadingContext = signal(false);

  // UI state
  readonly activeTab = signal<WorkspaceTab>('consultation');
  readonly isSchemaExpanded = signal(false);
  readonly autosaveState = signal<AutoSaveState>('idle');
  readonly lastSavedAt = signal<number | null>(null);
  readonly autosaveNowTick = signal(Date.now());
  readonly autosaveToastVisible = signal(false);
  readonly autosaveToastMessage = signal('');
  readonly isSaving = signal(false);
  readonly isCreating = signal(false);
  readonly saveError = signal('');
  readonly isGeneratingPdf = signal(false);
  readonly pdfError = signal('');
  readonly documentActionError = signal('');
  readonly isUploadingDocuments = signal(false);
  readonly isDocumentDragOver = signal(false);
  readonly isSavingDocumentMeta = signal<Record<string, boolean>>({});

  // Rich text content signals
  readonly motifMainHtml = signal('');
  readonly testsHtml = signal('');
  readonly schemaHtml = signal('');
  readonly treatmentsHtml = signal('');
  readonly remarksHtml = signal('');

  // Pending documents (create mode)
  readonly pendingDocuments = signal<ConsultationUploadDocument[]>([]);

  // Reason selections
  readonly reasonSelections = signal<Record<string, ConsultationReasonSelection>>({});

  // Billing state for the active consultation
  readonly billingState = signal<ConsultationBillingState | null>(null);
  readonly billingChoice = signal<'bill' | 'free' | null>(null);
  readonly paymentSplits = signal<Array<{ id: string; method: string; amount: string }>>([]);
  readonly isBillingModalOpen = signal(false);
  readonly isGeneratingInvoice = signal(false);
  readonly isSavingPayment = signal(false);
  readonly editingPaymentId = signal<string | null>(null);
  readonly isPaymentModalOpen = signal(false);
  readonly isLetterComposeOpen = signal(false);
  readonly isSavingLetterPdf = signal(false);
  readonly letterComposeError = signal('');

  // Edit form
  readonly editForm = this.fb.nonNullable.group({
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

  // Billing form
  readonly billingForm = this.fb.nonNullable.group({
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

  // Payment edit form
  readonly paymentForm = this.fb.nonNullable.group({
    amount: ['0'],
    method: [''],
    bankName: [''],
    chequeNumber: [''],
    comment: [''],
    paidAtLocal: ['']
  });

  // Letter compose form
  readonly letterForm = this.fb.nonNullable.group({
    date: [''],
    templateIndex: [''],
    subject: ['', [Validators.maxLength(200)]],
    recipient: ['', [Validators.maxLength(1000)]],
    content: ['', [Validators.maxLength(20000)]]
  });

  // Signals derived from form changes
  private readonly profileValue = toSignal(
    this.editForm.controls.profile.valueChanges,
    { initialValue: this.editForm.controls.profile.value }
  );
  private readonly heightValue = toSignal(
    this.editForm.controls.heightCm.valueChanges,
    { initialValue: this.editForm.controls.heightCm.value }
  );
  private readonly weightValue = toSignal(
    this.editForm.controls.weightKg.valueChanges,
    { initialValue: this.editForm.controls.weightKg.value }
  );

  // Computed
  readonly canCreateConsultation = computed(() => this.authService.hasPermission('create-consultation'));
  readonly canInvoiceConsultation = computed(() => this.authService.hasPermission('invoice-consultation'));
  readonly canCancelInvoice = computed(() => this.authService.hasPermission('cancel-invoice'));
  readonly canManagePayments = computed(() => this.authService.hasPermission('mark-payment'));

  readonly patientInitials = computed(() => {
    const name = this.patient()?.fullName ?? '';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  });

  readonly sexIcon = computed(() => {
    const sex = this.patient()?.sex;
    if (sex === 'Femme') return 'fa-solid fa-venus';
    if (sex === 'Homme') return 'fa-solid fa-mars';
    return '';
  });

  readonly sexColorClass = computed(() => {
    const sex = this.patient()?.sex;
    if (sex === 'Femme') return 'text-danger';
    if (sex === 'Homme') return 'text-primary';
    return 'text-secondary';
  });

  readonly pageTitle = computed(() =>
    this.mode() === 'create' ? 'Nouvelle consultation' : 'Modifier la consultation'
  );

  readonly profileOptions = computed(() => this.officeProfiles().map((p) => p.name));

  readonly profileReasons = computed(() => {
    const selectedProfile = String(this.profileValue() ?? '').trim();
    if (!selectedProfile) return [];
    const profile = this.officeProfiles().find((item) => item.name === selectedProfile);
    if (!profile) return [];
    return profile.reasons
      .map((r) => String(r ?? '').trim())
      .filter((r, i, all) => Boolean(r) && all.indexOf(r) === i);
  });

  readonly reasonItems = computed(() =>
    this.profileReasons().map((reason) => {
      const sel = this.reasonSelections()[reason] ?? { checked: false, value: '', important: false };
      return { reason, checked: sel.checked, value: sel.value, important: sel.important };
    })
  );

  readonly selectedReasonItems = computed((): ConsultationReasonItem[] =>
    this.reasonItems()
      .filter((item) => item.checked)
      .map((item) => ({ label: item.reason, value: item.value.trim(), important: item.important }))
  );

  readonly formBmi = computed(() => {
    const height = this.parseNullableNumber(this.heightValue() ?? '');
    const weight = this.parseNullableNumber(this.weightValue() ?? '');
    if (!height || !weight || height <= 0 || weight <= 0) return null;
    const value = weight / ((height / 100) ** 2);
    return Number.isFinite(value) ? value.toFixed(1) : null;
  });

  readonly billingTotalTtc = computed(() => {
    const quantity = Math.max(0, Number(this.billingForm.controls.quantity.value) || 0);
    const amountHt = Math.max(0, Number(this.billingForm.controls.amountHt.value) || 0);
    const tvaRate = Math.max(0, Number(this.billingForm.controls.tvaRate.value) || 0);
    const total = quantity * amountHt * (1 + tvaRate / 100);
    return Number.isFinite(total) ? Number(total.toFixed(2)) : 0;
  });

  readonly paymentSplitsTotal = computed(() =>
    this.paymentSplits().reduce((sum, s) => sum + (parseFloat(String(s.amount).replace(',', '.')) || 0), 0)
  );

  readonly paymentSplitsRemaining = computed(() =>
    Math.max(0, Math.round((this.billingTotalTtc() - this.paymentSplitsTotal()) * 100) / 100)
  );

  readonly isBillingPaymentPending = computed(() => {
    const value = String(this.billingForm.controls.paymentMethod.value ?? '').trim();
    return !value || value === PAYMENT_PENDING_LABEL;
  });

  readonly practitionerOptions = computed(() =>
    this.practitioners().map((p) => {
      const displayName = String(p.displayName ?? '').trim() || p.username;
      return { username: p.username, displayName, label: `${displayName} - ${p.role}` };
    })
  );

  readonly activeConsultationDocuments = computed(() => {
    const consultationId = this.consultation()?.id;
    if (!consultationId) return [];
    return this.patientDocuments().filter((d) => d.consultationId === consultationId);
  });

  readonly activeConsultationLetters = computed(() => {
    const consultationId = this.consultation()?.id;
    if (!consultationId) return [];
    return this.patientDocuments().filter((d) => d.consultationId === consultationId && d.documentType === 'letter');
  });

  readonly pendingLetters = computed(() => this.pendingDocuments().filter((d) => d.documentType === 'letter'));
  readonly pendingNonLetterDocuments = computed(() => this.pendingDocuments().filter((d) => d.documentType !== 'letter'));

  readonly autosaveStatusText = computed(() => {
    const frequency = this.preferences()?.patientAutoSaveFrequency ?? 'Jamais';
    if (this.mode() === 'create') {
      if (frequency === 'Jamais') return 'Sauvegarde automatique désactivée';
      const state = this.autosaveState();
      if (state === 'saving') return 'Sauvegarde du brouillon…';
      if (state === 'error') return 'Échec de la sauvegarde du brouillon';
      const savedAt = this.lastSavedAt();
      if (!savedAt) return 'Brouillon auto activé';
      const elapsed = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
      if (elapsed < 5) return 'Brouillon sauvegardé';
      if (elapsed < 60) return `Brouillon il y a ${elapsed}s`;
      return `Brouillon il y a ${Math.floor(elapsed / 60)} min`;
    }

    this.autosaveNowTick();
    const state = this.autosaveState();
    if (frequency === 'Jamais') return 'Autosave désactivé';
    if (state === 'saving') return 'Sauvegarde en cours…';
    if (state === 'error') return 'Échec de la sauvegarde';
    const savedAt = this.lastSavedAt();
    if (!savedAt) return 'Sauvegarde auto active';
    const elapsed = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
    if (elapsed < 5) return 'Sauvegardé';
    if (elapsed < 60) return `Sauvegardé il y a ${elapsed}s`;
    return `Sauvegardé il y a ${Math.floor(elapsed / 60)} min`;
  });

  readonly isPaymentMethodChequeSelected = computed(() =>
    this.isChequeMethod(String(this.paymentForm.controls.method.value ?? '').trim())
  );

  ngOnInit(): void {
    const patientIdRaw = Number(this.route.snapshot.paramMap.get('patientId'));
    const consultationIdRaw = this.route.snapshot.paramMap.get('consultationId');
    const consultationId = consultationIdRaw ? Number(consultationIdRaw) : null;

    this.patientId.set(patientIdRaw > 0 ? patientIdRaw : null);
    this.consultationId.set(consultationId && consultationId > 0 ? consultationId : null);

    this.topbar.set([]);
    void this.load();
  }

  ngOnDestroy(): void {
    this.stopAutosave();
    this.clearToastTimer();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  goBack(): void {
    const id = this.patientId();
    void this.router.navigate(id ? ['/patients', id] : ['/patients']);
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────

  setTab(tab: WorkspaceTab): void {
    this.activeTab.set(tab);
    if (tab === 'consultation') {
      this.cdr.detectChanges();
      queueMicrotask(() => this.hydrateEditors());
    }
  }

  // ── Profile & reasons ──────────────────────────────────────────────────────

  setProfile(value: string): void {
    const selected = value.trim();
    this.editForm.controls.profile.setValue(selected);
    const available = new Set(this.profileReasons());
    this.reasonSelections.update((items) => {
      const next: Record<string, ConsultationReasonSelection> = {};
      for (const reason of available) {
        next[reason] = items[reason] ?? { checked: false, value: '', important: false };
      }
      return next;
    });
  }

  setReasonChecked(reason: string, checked: boolean): void {
    const key = reason.trim();
    if (!key) return;
    this.reasonSelections.update((items) => ({
      ...items,
      [key]: { ...items[key] ?? { checked: false, value: '', important: false }, checked, value: checked ? (items[key]?.value ?? '') : '' }
    }));
  }

  setReasonValue(reason: string, value: string): void {
    const key = reason.trim();
    if (!key) return;
    this.reasonSelections.update((items) => ({
      ...items,
      [key]: { ...items[key] ?? { checked: false, value: '', important: false }, checked: value.trim().length > 0 || (items[key]?.checked ?? false), value }
    }));
  }

  setReasonImportant(reason: string, important: boolean): void {
    const key = reason.trim();
    if (!key) return;
    this.reasonSelections.update((items) => ({
      ...items,
      [key]: { ...items[key] ?? { checked: false, value: '', important: false }, checked: (items[key]?.checked ?? false) || important, important }
    }));
  }

  // ── Rich text editors ──────────────────────────────────────────────────────

  applyEditorCommand(
    section: ConsultationEditorSection,
    command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList'
  ): void {
    const el = this.getEditorElement(section);
    if (!el) return;
    el.focus();
    document.execCommand(command, false);
  }

  onRichTextInput(section: ConsultationEditorSection, event: Event): void {
    const html = (event.target as HTMLDivElement).innerHTML;
    if (section === 'motifMainHtml') this.motifMainHtml.set(html);
    else if (section === 'testsHtml') this.testsHtml.set(html);
    else if (section === 'schemaHtml') this.schemaHtml.set(html);
    else if (section === 'treatmentsHtml') this.treatmentsHtml.set(html);
    else this.remarksHtml.set(html);
  }

  // ── EVA ───────────────────────────────────────────────────────────────────

  getEvaBackground(value: number): string {
    const n = Math.max(0, Math.min(10, Number(value) || 0));
    const progress = n * 10;
    let color = '#28a745';
    if (n <= 5) {
      color = this.interpolateColor('#28a745', '#fd7e14', n / 5);
    } else {
      color = this.interpolateColor('#fd7e14', '#dc3545', (n - 5) / 5);
    }
    return `linear-gradient(to right, ${color} 0%, ${color} ${progress}%, #e9ecef ${progress}%, #e9ecef 100%)`;
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async save(options: { close?: boolean; isAutoSave?: boolean } = {}): Promise<void> {
    const close = options.close ?? true;
    const isAutoSave = options.isAutoSave ?? false;

    if (!this.canCreateConsultation()) return;

    if (this.mode() === 'create') {
      if (isAutoSave) {
        await this.persistDraft();
      } else {
        await this.createConsultation(close);
      }
      return;
    }

    const active = this.consultation();
    if (!active || this.editForm.invalid || this.isSaving()) return;

    if (isAutoSave && !this.hasChanges(active)) return;

    this.isSaving.set(true);
    if (!isAutoSave) this.saveError.set('');
    this.autosaveState.set(isAutoSave ? 'saving' : 'idle');

    try {
      const payload = this.buildUpdatePayload(active);
      const updated = await this.api.updateConsultation(active.id, payload);
      this.consultation.set(updated);
      this.lastSavedAt.set(Date.now());
      this.autosaveState.set('saved');
      if (isAutoSave) this.showToast('Consultation sauvegardée automatiquement');
      else if (!close) this.showToast('Consultation sauvegardée');
      if (close) this.goBack();
    } catch {
      if (!isAutoSave) this.saveError.set('Impossible d\'enregistrer la consultation.');
      this.autosaveState.set('error');
    } finally {
      this.isSaving.set(false);
    }
  }

  async saveDraftNow(): Promise<void> {
    if (this.mode() !== 'create') return;
    await this.persistDraft({ manual: true });
  }

  // ── PDF ───────────────────────────────────────────────────────────────────

  async generatePdf(): Promise<void> {
    const patient = this.patient();
    if (!patient || this.isGeneratingPdf()) return;

    const preferDownload = this.preferences()?.pdfDisplayMode === 'download';
    const previewWindow = !preferDownload ? window.open('about:blank', '_blank') : null;

    this.pdfError.set('');
    this.isGeneratingPdf.set(true);

    try {
      const [profile, offices] = await Promise.all([
        this.api.getMyUserProfile(),
        this.api.getOffices().catch(() => [] as Office[])
      ]);
      const office = this.resolveOffice(offices);
      const raw = this.editForm.getRawValue();
      const startedAtIso = this.fromDateTimeLocal(raw.startedAtLocal) ?? new Date().toISOString();
      const consultationDate = this.formatConsultationDate(startedAtIso);

      const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 14;
      const contentWidth = pageWidth - margin * 2;

      let y = this.pdfBuilder.writeUnifiedHeader(pdf, { office, profile, officeFallbackName: this.officeName() });

      const ensureSpace = (h: number): void => {
        if (y + h > pageHeight - margin) { pdf.addPage(); y = margin; }
      };

      const writeParagraph = (text: string, fontSize = 10.8, after = 4): void => {
        const normalized = this.normalizeText(text);
        if (!normalized) return;
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(fontSize);
        const lines = pdf.splitTextToSize(normalized, contentWidth - 2) as string[];
        ensureSpace(lines.length * 5 + after);
        pdf.text(lines, margin + 2, y);
        y += lines.length * 5 + after;
      };

      const writeSection = (title: string, body: string): void => {
        if (!body?.trim()) return;
        ensureSpace(14);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(11.5);
        pdf.text(title, margin + 2, y);
        y += 6;
        writeParagraph(body);
        y += 2;
      };

      // Patient header
      y += 6;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(14);
      pdf.text(patient.fullName, margin + 2, y);
      y += 7;
      writeParagraph(`Date : ${consultationDate} · Praticien : ${raw.practitioner || '-'}`);
      if (raw.title?.trim()) { pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.text(raw.title, margin + 2, y); y += 7; }

      const selectedReasons = this.selectedReasonItems()
        .map((item) => `${item.label}${item.value ? ` : ${item.value}` : ''}${item.important ? ' ⚠' : ''}`)
        .join('\n');

      writeSection('Informations cliniques', [
        `Profil : ${raw.profile || '-'}`,
        `Taille : ${raw.heightCm || '-'}`,
        `Poids : ${raw.weightKg || '-'}`,
        `EVA début : ${Number(raw.evaBefore) || 0}/10`,
        `EVA fin : ${Number(raw.evaAfter) || 0}/10`
      ].join('\n'));
      writeSection('Motifs sélectionnés', selectedReasons || 'Aucun motif sélectionné');
      writeSection('Motif principal', this.htmlToPlain(this.motifMainHtml()));
      writeSection('Tests', this.htmlToPlain(this.testsHtml()));
      const schemaText = this.schemaToPlain(this.schemaHtml());
      if (schemaText) writeSection('Schéma', schemaText);
      writeSection('Traitements proposés', this.htmlToPlain(this.treatmentsHtml()));
      writeSection('Remarques', this.htmlToPlain(this.remarksHtml()));

      const filename = `${this.toSlug(patient.fullName)}_consultation_${this.toSlug(consultationDate) || 'date'}.pdf`;
      this.pdfBuilder.writeUnifiedFooter(pdf, { margin, pageWidth, pageHeight, profile, office });

      if (preferDownload) {
        pdf.save(filename);
      } else {
        const blob = pdf.output('blob');
        const url = URL.createObjectURL(blob);
        if (previewWindow) {
          previewWindow.location.href = url;
        } else {
          window.open(url, '_blank');
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch {
      if (previewWindow && !previewWindow.closed) previewWindow.close();
      this.pdfError.set('Impossible de générer le PDF.');
    } finally {
      this.isGeneratingPdf.set(false);
    }
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async onDocumentFilesSelected(event: Event): Promise<void> {
    const files = Array.from((event.target as HTMLInputElement).files ?? []);
    (event.target as HTMLInputElement).value = '';
    if (!files.length) return;
    await this.addDocuments(files);
  }

  async onDocumentDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isDocumentDragOver.set(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    await this.addDocuments(files);
  }

  onDocumentDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDocumentDragOver.set(true);
  }

  onDocumentDragLeave(): void {
    this.isDocumentDragOver.set(false);
  }

  removePendingDocument(tempKey: string): void {
    this.pendingDocuments.update((items) => items.filter((d) => d.tempKey !== tempKey));
  }

  async saveDocumentMeta(documentRef: string, title: string, comment: string): Promise<void> {
    this.isSavingDocumentMeta.update((s) => ({ ...s, [documentRef]: true }));
    try {
      const updated = await this.api.updatePatientDocument(documentRef, { title, comment });
      this.patientDocuments.update((items) => items.map((d) => d.documentRef === documentRef ? updated : d));
    } catch {
      this.documentActionError.set('Impossible de sauvegarder les métadonnées du document.');
    } finally {
      this.isSavingDocumentMeta.update((s) => { const next = { ...s }; delete next[documentRef]; return next; });
    }
  }

  async openDocument(doc: PatientDocumentSummary): Promise<void> {
    try {
      const detail = await this.api.getPatientDocument(doc.documentRef);
      const byteChars = atob(detail.contentBase64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: detail.mimeType });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      this.documentActionError.set('Impossible d\'ouvrir le document.');
    }
  }

  async downloadDocument(doc: PatientDocumentSummary): Promise<void> {
    try {
      const detail = await this.api.getPatientDocument(doc.documentRef);
      const byteChars = atob(detail.contentBase64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: detail.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      this.documentActionError.set('Impossible de télécharger le document.');
    }
  }

  async deleteDocument(documentRef: string): Promise<void> {
    try {
      await this.api.deletePatientDocument(documentRef);
      this.patientDocuments.update((items) => items.filter((d) => d.documentRef !== documentRef));
    } catch {
      this.documentActionError.set('Impossible de supprimer le document.');
    }
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  // ── Letters ───────────────────────────────────────────────────────────────

  openLetterCompose(): void {
    const todayIso = new Date().toISOString().slice(0, 10);
    this.letterForm.reset({ date: todayIso, templateIndex: '', subject: '', recipient: '', content: '' });
    this.letterComposeError.set('');
    this.isLetterComposeOpen.set(true);
  }

  closeLetterCompose(): void {
    this.isLetterComposeOpen.set(false);
  }

  onLetterTemplateChange(index: string): void {
    const idx = Number(index);
    if (!Number.isFinite(idx)) return;
    const template = this.letterTemplates()[idx];
    if (!template) return;
    this.letterForm.patchValue({ subject: template.title, content: template.content });
  }

  async saveLetterAsPdf(): Promise<void> {
    const patientId = this.patientId();
    if (!patientId || this.isSavingLetterPdf()) return;

    this.isSavingLetterPdf.set(true);
    this.letterComposeError.set('');

    try {
      const [profile, offices] = await Promise.all([
        this.api.getMyUserProfile(),
        this.api.getOffices().catch(() => [] as Office[])
      ]);
      const office = this.resolveOffice(offices);
      const pdfBlob = this.buildLetterPdf(office, profile);
      const base64 = await this.blobToBase64(pdfBlob);
      const raw = this.letterForm.getRawValue();
      const subject = String(raw.subject ?? '').trim() || 'Courrier';
      const fileName = `${this.toSlug(this.patient()?.fullName ?? '')}_courrier_${this.toSlug(subject) || 'patient'}.pdf`;

      const consultationId = this.mode() === 'edit' ? (this.consultation()?.id ?? null) : null;
      const created = await this.api.createPatientDocument(patientId, {
        consultationId,
        officeId: this.officeId(),
        fileName,
        mimeType: 'application/pdf',
        sizeBytes: pdfBlob.size,
        title: subject,
        comment: `Courrier patient du ${this.formatShortDate(new Date().toISOString())}`,
        contentBase64: base64,
        documentType: 'letter'
      });

      this.patientDocuments.update((items) => [created, ...items]);
      this.isLetterComposeOpen.set(false);
    } catch {
      this.letterComposeError.set('Impossible de générer le PDF du courrier.');
    } finally {
      this.isSavingLetterPdf.set(false);
    }
  }

  // ── Billing ───────────────────────────────────────────────────────────────

  async prepareBilling(): Promise<void> {
    await this.loadContext();
    if (!this.billingState()) {
      this.populateBillingForm();
    }
    this.billingChoice.set('bill');
    this.isBillingModalOpen.set(true);
  }

  closeBillingModal(): void {
    this.isBillingModalOpen.set(false);
  }

  markAsFreeAct(): void {
    this.billingChoice.set('free');
    this.isBillingModalOpen.set(false);
  }

  selectBillingChoice(choice: 'bill' | 'free'): void {
    this.billingChoice.set(choice);
    if (choice === 'bill') {
      if (this.paymentSplits().length === 0) this.addPaymentSplit();
    } else {
      this.paymentSplits.set([]);
    }
  }

  addPaymentSplit(): void {
    this.paymentSplits.update(splits => [
      ...splits,
      { id: this.createTempKey('split'), method: '', amount: '' }
    ]);
  }

  removePaymentSplit(id: string): void {
    this.paymentSplits.update(splits => splits.filter(s => s.id !== id));
  }

  updatePaymentSplitMethod(id: string, method: string): void {
    this.paymentSplits.update(splits => splits.map(s => s.id === id ? { ...s, method } : s));
  }

  updatePaymentSplitAmount(id: string, amount: string): void {
    this.paymentSplits.update(splits => splits.map(s => s.id === id ? { ...s, amount } : s));
  }

  onBillingServiceChange(serviceLabel: string): void {
    this.billingForm.controls.serviceLabel.setValue(serviceLabel.trim());
    const selected = this.billingServiceOptions().find((item) => item.label === serviceLabel.trim());
    if (selected) {
      this.billingForm.patchValue({ amountHt: selected.amountHt, tvaRate: selected.tvaRate });
    }
  }

  async generateInvoice(): Promise<void> {
    if (!this.canInvoiceConsultation()) return;

    const patientId = this.patientId();
    if (!patientId || this.isGeneratingInvoice()) return;

    // In create mode, save the consultation first to get an ID
    if (this.mode() === 'create') {
      await this.createConsultation(false);
      if (!this.consultation()?.id) return;
    }

    this.isGeneratingInvoice.set(true);
    this.documentActionError.set('');

    try {
      const offices = await this.api.getOffices();
      const office = this.resolveOffice(offices);
      if (!office) {
        this.documentActionError.set('Aucun cabinet actif trouvé pour appliquer le template de facture.');
        return;
      }
      const profile = await this.api.getMyUserProfile();
      const nowIso = new Date().toISOString();

      const raw = this.billingForm.getRawValue();
      const rawName = String(raw.documentName ?? '').trim() || 'Facture acquittee';
      const fileName = rawName.toLowerCase().endsWith('.pdf') ? rawName : `${rawName}.pdf`;
      const currency = String(office.devise ?? 'EUR').trim() || 'EUR';
      const totalAmount = this.billingTotalTtc();
      const serviceLabel = String(raw.serviceLabel ?? '').trim() || 'Consultation';
      const quantity = Number(raw.quantity ?? 1);
      const amountHt = Number(raw.amountHt ?? 0);
      const tvaRate = Number(raw.tvaRate ?? 0);
      const paymentComment = String(raw.internalComment ?? '').trim() || 'Paiement enregistré lors de la facturation';
      const payments: ConsultationPaymentEntry[] = this.paymentSplits()
        .filter(s => s.method && (parseFloat(String(s.amount).replace(',', '.')) || 0) > 0)
        .map(s => ({
          id: this.createTempKey('pay'),
          amount: parseFloat(String(s.amount).replace(',', '.')) || 0,
          currency,
          method: s.method,
          bankName: '',
          chequeNumber: '',
          comment: paymentComment,
          paidAt: nowIso
        }));
      const status = this.computePaymentStatus(totalAmount, payments);
      const primaryMethod = payments[0]?.method ?? PAYMENT_PENDING_LABEL;
      const consultationId = this.consultation()?.id ?? null;

      // Facture enregistrée d'abord : le serveur attribue le numéro (séquentiel,
      // sans trou), puis le PDF est construit avec ce même numéro.
      const { invoiceId, invoiceNumber } = await this.api.createBillingInvoice({
        patientId,
        consultationId,
        officeId: office.id,
        amountCents: Math.round(totalAmount * 100),
        status: status === 'paid' ? 'payee' : 'impayee',
        paymentMethod: primaryMethod,
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
        payments: payments.map((p) => ({
          paidAt: p.paidAt, amountCents: Math.max(0, Math.round(p.amount * 100)), currency: p.currency,
          paymentMethod: p.method, bankName: p.bankName, chequeNumber: p.chequeNumber, notes: p.comment
        }))
      });

      const pdfBlob = this.pdfBuilder.buildConsultationInvoicePdf(
        raw,
        office,
        profile,
        nowIso,
        invoiceNumber,
        this.officeName()
      );
      const base64 = await this.blobToBase64(pdfBlob);

      const created = await this.api.createPatientDocument(patientId, {
        consultationId,
        officeId: office.id,
        fileName,
        mimeType: 'application/pdf',
        sizeBytes: pdfBlob.size,
        title: rawName,
        comment: String(raw.internalComment ?? '').trim(),
        contentBase64: base64,
        documentType: 'invoice'
      });

      this.patientDocuments.update((items) => [created, ...items]);
      if (consultationId) {
        const practitionerName = String(this.editForm.controls.practitioner.value ?? '').trim() || '-';
        const newState: ConsultationBillingState = {
          consultationId,
          billingInvoiceId: invoiceId,
          invoiceNumber,
          totalAmount,
          currency,
          issuedAt: nowIso,
          internalComment: String(raw.internalComment ?? '').trim(),
          practitionerName,
          invoiceDocumentRef: created.documentRef,
          paymentStatus: status,
          payments
        };
        this.billingState.set(newState);
        this.persistBillingState(newState);
      }
      this.isBillingModalOpen.set(false);
    } catch {
      this.documentActionError.set('Impossible de générer la facture PDF.');
    } finally {
      this.isGeneratingInvoice.set(false);
    }
  }

  async cancelInvoice(): Promise<void> {
    if (!this.canCancelInvoice()) return;
    const billing = this.billingState();
    if (!billing) return;

    this.documentActionError.set('');
    const documentRef = String(billing.invoiceDocumentRef ?? '').trim();
    if (documentRef) {
      try {
        await this.api.deletePatientDocument(documentRef);
        this.patientDocuments.update((items) => items.filter((d) => d.documentRef !== documentRef));
      } catch {
        this.documentActionError.set('Impossible d\'annuler la facture.');
        return;
      }
    }

    if (billing.billingInvoiceId != null) {
      try {
        await this.api.deleteBillingInvoice(billing.billingInvoiceId);
      } catch { /* best-effort */ }
    }

    this.billingState.set(null);
    this.billingChoice.set(null);
    this.paymentSplits.set([]);
    this.clearPersistedBillingState();
  }

  async downloadInvoice(): Promise<void> {
    const billing = this.billingState();
    if (!billing) return;
    const doc = this.patientDocuments().find((d) => d.documentRef === billing.invoiceDocumentRef);
    if (!doc) {
      this.documentActionError.set('Facture introuvable dans les documents.');
      return;
    }
    await this.openDocument(doc);
  }

  isPaymentPending(): boolean {
    if (this.billingChoice() === 'free') return false;
    const billing = this.billingState();
    if (!billing) return true;
    return billing.paymentStatus !== 'paid';
  }

  formatAmount(amount: number): string {
    return this.formatAmountFr(amount);
  }

  // ── Payment ───────────────────────────────────────────────────────────────

  async openPaymentModal(paymentId: string | null = null): Promise<void> {
    const billing = this.billingState();
    if (!billing) return;
    this.editingPaymentId.set(paymentId);
    if (paymentId) {
      const payment = billing.payments.find((p) => p.id === paymentId);
      if (payment) {
        this.paymentForm.reset({
          amount: String(payment.amount),
          method: payment.method,
          bankName: payment.bankName,
          chequeNumber: payment.chequeNumber,
          comment: payment.comment,
          paidAtLocal: this.toDateTimeLocal(payment.paidAt)
        });
      }
    } else {
      this.paymentForm.reset({ amount: '', method: '', bankName: '', chequeNumber: '', comment: '', paidAtLocal: this.toDateTimeLocal(new Date().toISOString()) });
    }
    this.documentActionError.set('');
    this.isPaymentModalOpen.set(true);
  }

  closePaymentModal(): void {
    this.isPaymentModalOpen.set(false);
  }

  async savePayment(): Promise<void> {
    if (!this.canManagePayments()) return;
    const billing = this.billingState();
    const paymentId = this.editingPaymentId();
    if (!billing || this.isSavingPayment()) return;

    const raw = this.paymentForm.getRawValue();
    const amount = this.parsePaymentAmount(raw.amount);
    const method = String(raw.method ?? '').trim();
    const bankName = String(raw.bankName ?? '').trim();
    const chequeNumber = String(raw.chequeNumber ?? '').trim();
    const comment = String(raw.comment ?? '').trim();
    const isCheque = this.isChequeMethod(method);
    const paidAt = this.fromDateTimeLocal(raw.paidAtLocal);

    if (!method || amount <= 0 || !paidAt || (isCheque && (!bankName || !chequeNumber))) return;

    const nextPayments = paymentId
      ? billing.payments.map((e) => e.id === paymentId
          ? { ...e, amount, method, bankName: isCheque ? bankName : '', chequeNumber: isCheque ? chequeNumber : '', comment, paidAt }
          : e)
      : [...billing.payments, { id: this.createTempKey('pay'), amount, currency: billing.currency, method, bankName: isCheque ? bankName : '', chequeNumber: isCheque ? chequeNumber : '', comment, paidAt }];

    this.isSavingPayment.set(true);
    this.documentActionError.set('');

    try {
      const invoiceId = Number(billing.billingInvoiceId);
      if (Number.isInteger(invoiceId) && invoiceId > 0) {
        const invoice = await this.api.updateBillingInvoicePayments(invoiceId, {
          payments: nextPayments.map((e) => ({
            paidAt: e.paidAt, amountCents: Math.max(0, Math.round(e.amount * 100)),
            currency: e.currency, paymentMethod: e.method, bankName: e.bankName, chequeNumber: e.chequeNumber, notes: String(e.comment ?? '').trim()
          }))
        });
        const updatedState = this.mapInvoiceToState(billing.consultationId, billing.practitionerName, billing.invoiceDocumentRef, invoice);
        this.billingState.set(updatedState);
        this.persistBillingState(updatedState);
      } else {
        const updatedState = { ...billing, payments: nextPayments, paymentStatus: this.computePaymentStatus(billing.totalAmount, nextPayments) };
        this.billingState.set(updatedState);
        this.persistBillingState(updatedState);
      }
      this.closePaymentModal();
    } catch {
      this.documentActionError.set('Impossible de mettre à jour le paiement.');
    } finally {
      this.isSavingPayment.set(false);
    }
  }

  async deletePayment(paymentId: string): Promise<void> {
    if (!this.canManagePayments()) return;
    const billing = this.billingState();
    if (!billing || this.isSavingPayment()) return;

    const nextPayments = billing.payments.filter((p) => p.id !== paymentId);
    this.isSavingPayment.set(true);
    try {
      const invoiceId = Number(billing.billingInvoiceId);
      if (Number.isInteger(invoiceId) && invoiceId > 0) {
        const invoice = await this.api.updateBillingInvoicePayments(invoiceId, {
          payments: nextPayments.map((e) => ({
            paidAt: e.paidAt, amountCents: Math.max(0, Math.round(e.amount * 100)),
            currency: e.currency, paymentMethod: e.method, bankName: e.bankName, chequeNumber: e.chequeNumber, notes: String(e.comment ?? '').trim()
          }))
        });
        const updated = this.mapInvoiceToState(billing.consultationId, billing.practitionerName, billing.invoiceDocumentRef, invoice);
        this.billingState.set(updated);
        this.persistBillingState(updated);
      } else {
        const updated = { ...billing, payments: nextPayments, paymentStatus: this.computePaymentStatus(billing.totalAmount, nextPayments) };
        this.billingState.set(updated);
        this.persistBillingState(updated);
      }
    } catch {
      this.documentActionError.set('Impossible de supprimer le paiement.');
    } finally {
      this.isSavingPayment.set(false);
    }
  }

  isChequeSelected(): boolean {
    return this.isChequeMethod(String(this.paymentForm.controls.method.value ?? '').trim());
  }

  // ── Private: Load ─────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const patientId = this.patientId();
    if (!patientId) {
      this.loadError.set('Patient introuvable.');
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    this.loadError.set('');

    try {
      const [patient, consultations, documents, preferences] = await Promise.all([
        this.api.getPatientDetail(patientId),
        this.api.getPatientConsultations(patientId),
        this.api.getPatientDocuments(patientId),
        this.api.getMyAgendaPreferences()
      ]);

      this.patient.set(patient);
      this.patientDocuments.set(documents);
      this.preferences.set(preferences);

      await this.loadContext();

      if (this.mode() === 'edit') {
        const consultationId = this.consultationId();
        const consultation = consultations.find((c) => c.id === consultationId) ?? null;
        if (!consultation) throw new Error('Consultation introuvable.');
        this.hydrateFromRecord(consultation);
        void this.hydrateFromBillingState(consultation);
      } else {
        await this.hydrateCreateMode();
      }
    } catch {
      this.loadError.set('Impossible de charger les données de la consultation.');
    } finally {
      this.isLoading.set(false);
      this.cdr.detectChanges();
      if (!this.loadError()) {
        queueMicrotask(() => {
          this.hydrateEditors();
          this.startAutosave();
        });
      }
    }
  }

  private async loadContext(): Promise<void> {
    if (this.loadContextPromise) return this.loadContextPromise;

    this.isLoadingContext.set(true);
    this.loadContextPromise = (async () => {
      try {
        const preferredOfficeId = this.resolvePreferredOfficeId();
        const context: ConsultationContextPayload = await this.api.getConsultationContext(preferredOfficeId);
        this.officeId.set(context.officeId ?? null);
        this.officeName.set(context.officeName ?? null);
        this.practitioners.set(Array.isArray(context.practitioners) ? context.practitioners : []);
        this.officeProfiles.set(Array.isArray(context.profiles) ? context.profiles : []);
        if (this.mode() === 'create') this.applyDefaultPractitioner();
        if (Array.isArray(context.paymentMethods)) {
          const serviceOptions = (context.serviceTypes ?? [])
            .map((item) => ({ label: String(item.label ?? '').trim(), amountHt: Number(item.amountHt) || 0, tvaRate: Number(item.vatRate) || 0 }))
            .filter((item) => Boolean(item.label));
          this.billingServiceOptions.set(serviceOptions);
          this.billingPaymentMethodOptions.set(context.paymentMethods.map((m) => String(m ?? '').trim()).filter(Boolean));
          this.applyBillingDefaults();
        } else {
          await this.loadBillingCatalog(context.officeId ?? preferredOfficeId ?? null);
        }
        await this.loadLetterTemplates(context.officeId ?? preferredOfficeId ?? null);
      } catch {
        // Non-fatal: workspace still functional without full context.
      } finally {
        this.isLoadingContext.set(false);
        this.loadContextPromise = null;
      }
    })();
    return this.loadContextPromise;
  }

  private async loadBillingCatalog(contextOfficeId: number | null): Promise<void> {
    try {
      const offices = await this.api.getOffices();
      const office = offices.find((o) => o.id === contextOfficeId) ?? offices[0] ?? null;
      if (!office) return;
      const serviceOptions = (office.serviceTypes ?? [])
        .map((item) => ({ label: String(item.label ?? '').trim(), amountHt: Number(item.amountHt) || 0, tvaRate: Number(item.vatRate) || 0 }))
        .filter((item) => Boolean(item.label));
      const paymentMethods = (office.paymentMethods ?? [])
        .filter((m) => m.isActive)
        .map((m) => String(m.label ?? '').trim())
        .filter(Boolean);
      this.billingServiceOptions.set(serviceOptions);
      this.billingPaymentMethodOptions.set(paymentMethods);
      this.applyBillingDefaults();
    } catch {
      // Ignore — billing catalog not critical.
    }
  }

  private async loadLetterTemplates(contextOfficeId: number | null): Promise<void> {
    try {
      const offices = await this.api.getOffices();
      const office = offices.find((o) => o.id === contextOfficeId) ?? null;
      const patientTemplates = (office?.patientLetterTemplates ?? [])
        .filter((t) => Boolean(String(t?.title ?? '').trim()))
        .map((t): OfficePatientLetterTemplate => ({ kind: 'patient-template', title: String(t.title ?? '').trim(), content: String(t.content ?? '').trim() }));
      this.letterTemplates.set(patientTemplates);
    } catch { /* non-fatal */ }
  }

  private hydrateFromRecord(consultation: ConsultationRecord): void {
    this.consultation.set(consultation);
    this.autosaveState.set('idle');
    this.lastSavedAt.set(null);
    this.reasonSelections.set({});
    this.pendingDocuments.set([]);
    this.motifMainHtml.set(consultation.motifMainHtml);
    this.testsHtml.set(consultation.testsHtml);
    this.schemaHtml.set(consultation.schemaHtml);
    this.treatmentsHtml.set(consultation.treatmentsHtml);
    this.remarksHtml.set(consultation.remarksHtml);
    this.editForm.reset({
      startedAtLocal: this.toDateTimeLocal(consultation.startedAt),
      practitioner: consultation.practitioner,
      title: consultation.title,
      important: consultation.important,
      heightCm: consultation.heightCm != null ? String(consultation.heightCm) : '',
      weightKg: consultation.weightKg != null ? String(consultation.weightKg) : '',
      evaBefore: consultation.evaBefore,
      evaAfter: consultation.evaAfter,
      profile: consultation.profile || 'Adulte'
    });
    this.hydrateReasonsFromRecord(consultation.reasonItems);
    if (this.schemaHtml().startsWith('{')) this.isSchemaExpanded.set(true);
  }

  private async hydrateCreateMode(): Promise<void> {
    const patientId = this.patientId();
    if (!patientId) return;

    const defaultProfile = this.profileOptions()[0] ?? '';
    const nowIso = new Date().toISOString();
    const defaultPractitioner = this.getDefaultPractitioner();
    this.editForm.reset({
      startedAtLocal: this.toDateTimeLocal(nowIso),
      practitioner: defaultPractitioner?.displayName ?? defaultPractitioner?.username ?? '',
      title: '',
      important: false,
      heightCm: '',
      weightKg: '',
      evaBefore: 0,
      evaAfter: 0,
      profile: defaultProfile
    });
    this.setProfile(defaultProfile);

    try {
      const draft = await this.api.getNewConsultationDraft(patientId);
      if (draft?.payload) {
        const payload = draft.payload;
        const draftStartedAt = this.fromDateTimeLocal(this.toDateTimeLocal(payload.startedAt)) ?? payload.startedAt;
        this.editForm.reset({
          startedAtLocal: this.toDateTimeLocal(draftStartedAt),
          practitioner: payload.practitioner,
          title: payload.title,
          important: payload.important,
          heightCm: payload.heightCm != null ? String(payload.heightCm) : '',
          weightKg: payload.weightKg != null ? String(payload.weightKg) : '',
          evaBefore: payload.evaBefore,
          evaAfter: payload.evaAfter,
          profile: payload.profile || defaultProfile
        });
        this.officeId.set(payload.officeId ?? this.officeId());
        this.setProfile(payload.profile || defaultProfile);
        this.hydrateReasonsFromRecord(payload.reasonItems ?? []);
        this.motifMainHtml.set(payload.motifMainHtml ?? '');
        this.testsHtml.set(payload.testsHtml ?? '');
        this.schemaHtml.set(payload.schemaHtml ?? '');
        this.treatmentsHtml.set(payload.treatmentsHtml ?? '');
        this.remarksHtml.set(payload.remarksHtml ?? '');
        this.pendingDocuments.set(
          (payload.consultationDocuments ?? []).map((doc) => ({
            tempKey: this.createTempKey('draft-doc'),
            documentRef: doc.documentRef || this.createDocumentRef(),
            fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes,
            title: doc.title, comment: doc.comment, contentBase64: doc.contentBase64, documentType: doc.documentType
          }))
        );
        const updatedAtMs = Number(new Date(draft.updatedAt));
        if (!Number.isNaN(updatedAtMs)) {
          this.lastSavedAt.set(updatedAtMs);
          this.autosaveState.set('saved');
        }
      }
    } catch { /* Draft loading is non-blocking */ }
  }

  private async hydrateFromBillingState(consultation: ConsultationRecord): Promise<void> {
    const consultationId = Number(consultation.id);
    if (!Number.isInteger(consultationId) || consultationId <= 0) return;

    const billingInvoiceId = Number(consultation.billingInvoiceId);
    const hasInvoice = Number.isInteger(billingInvoiceId) && billingInvoiceId > 0;

    if (hasInvoice) {
      try {
        const invoice = await this.api.getBillingInvoice(billingInvoiceId);
        const invoiceDocumentRef = this.resolveInvoiceDocumentRef(consultationId, invoice.issuedAt);
        const state = this.mapInvoiceToState(consultationId, consultation.practitioner || '-', invoiceDocumentRef, invoice);
        this.billingState.set(state);
        this.billingChoice.set('bill');
        return;
      } catch { /* fallback to localStorage */ }
    }

    const persisted = this.readPersistedBillingState();
    if (persisted) {
      this.billingState.set(persisted);
      this.billingChoice.set('bill');
    }
  }

  // ── Private: Create/Save consultation ─────────────────────────────────────

  private async createConsultation(navigateOnSuccess: boolean): Promise<void> {
    const patientId = this.patientId();
    if (!patientId || this.editForm.invalid || this.isSaving()) return;

    this.isSaving.set(true);
    this.isCreating.set(true);
    this.saveError.set('');
    this.autosaveState.set('idle');

    try {
      const created = await this.api.createPatientConsultation(patientId, this.buildCreatePayload());
      this.consultation.set(created);
      this.lastSavedAt.set(Date.now());
      this.autosaveState.set('saved');
      this.pendingDocuments.set([]);

      const [docs] = await Promise.all([
        this.api.getPatientDocuments(patientId),
        this.api.deleteNewConsultationDraft(patientId).catch(() => { /* non-blocking */ })
      ]);
      this.patientDocuments.set(docs);

      if (navigateOnSuccess) this.goBack();
    } catch {
      this.autosaveState.set('idle');
      this.saveError.set('Impossible de créer la consultation.');
    } finally {
      this.isCreating.set(false);
      this.isSaving.set(false);
    }
  }

  private async persistDraft(options?: { manual?: boolean }): Promise<void> {
    const isManual = options?.manual === true;
    if (this.mode() !== 'create') return;
    const patientId = this.patientId();
    if (!patientId || this.editForm.invalid) return;
    if (!this.hasDraftChanges()) return;
    if (this.isPersistingDraft) { this.pendingDraftSave = true; return; }

    this.isPersistingDraft = true;
    this.autosaveState.set('saving');
    try {
      await this.api.saveNewConsultationDraft(patientId, this.buildCreatePayload());
      this.lastSavedAt.set(Date.now());
      this.autosaveState.set('saved');
      if (isManual) {
        this.showToast('Brouillon sauvegardé', { force: true });
      } else {
        this.showToast('Brouillon sauvegardé automatiquement');
      }
    } catch {
      this.autosaveState.set('error');
    } finally {
      this.isPersistingDraft = false;
      if (this.pendingDraftSave) {
        this.pendingDraftSave = false;
        void this.persistDraft();
      }
    }
  }

  // ── Private: Build payloads ───────────────────────────────────────────────

  private buildCreatePayload(): CreatePatientConsultationPayload {
    const raw = this.editForm.getRawValue();
    return {
      startedAt: this.fromDateTimeLocal(raw.startedAtLocal) ?? new Date().toISOString(),
      practitioner: raw.practitioner,
      title: raw.title,
      important: raw.important,
      heightCm: this.parseNullableNumber(raw.heightCm),
      weightKg: this.parseNullableNumber(raw.weightKg),
      evaBefore: Number(raw.evaBefore) || 0,
      evaAfter: Number(raw.evaAfter) || 0,
      profile: raw.profile,
      reasonItems: this.selectedReasonItems(),
      motifMainHtml: this.motifMainHtml(),
      testsHtml: this.testsHtml(),
      schemaHtml: this.schemaHtml(),
      treatmentsHtml: this.treatmentsHtml(),
      remarksHtml: this.remarksHtml(),
      officeId: this.officeId(),
      consultationDocuments: this.pendingDocuments().map((doc) => ({
        documentRef: doc.documentRef,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        title: doc.title,
        comment: doc.comment,
        contentBase64: doc.contentBase64,
        documentType: doc.documentType
      }))
    };
  }

  private buildUpdatePayload(active: ConsultationRecord): ConsultationUpdatePayload {
    const raw = this.editForm.getRawValue();
    return {
      startedAt: this.fromDateTimeLocal(raw.startedAtLocal) ?? active.startedAt,
      practitioner: raw.practitioner,
      title: raw.title,
      important: raw.important,
      heightCm: this.parseNullableNumber(raw.heightCm),
      weightKg: this.parseNullableNumber(raw.weightKg),
      evaBefore: Number(raw.evaBefore) || 0,
      evaAfter: Number(raw.evaAfter) || 0,
      profile: raw.profile,
      reasonItems: this.selectedReasonItems(),
      motifMainHtml: this.motifMainHtml(),
      testsHtml: this.testsHtml(),
      schemaHtml: this.schemaHtml(),
      treatmentsHtml: this.treatmentsHtml(),
      remarksHtml: this.remarksHtml()
    };
  }

  private hasDraftChanges(): boolean {
    return this.editForm.dirty
      || Boolean(this.motifMainHtml().trim())
      || Boolean(this.testsHtml().trim())
      || Boolean(this.schemaHtml().trim())
      || Boolean(this.treatmentsHtml().trim())
      || Boolean(this.remarksHtml().trim())
      || this.pendingDocuments().length > 0
      || this.selectedReasonItems().length > 0;
  }

  private hasChanges(active: ConsultationRecord): boolean {
    return JSON.stringify(this.buildUpdatePayload(active)) !== JSON.stringify({
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
    } satisfies ConsultationUpdatePayload);
  }

  // ── Private: Editors ───────────────────────────────────────────────────────

  private getEditorElement(section: ConsultationEditorSection): HTMLDivElement | null {
    if (section === 'motifMainHtml') return this.motifMainEditorRef()?.nativeElement ?? null;
    if (section === 'testsHtml') return this.testsEditorRef()?.nativeElement ?? null;
    if (section === 'treatmentsHtml') return this.treatmentsEditorRef()?.nativeElement ?? null;
    if (section === 'remarksHtml') return this.remarksEditorRef()?.nativeElement ?? null;
    return null;
  }

  private hydrateEditors(): void {
    const set = (section: ConsultationEditorSection, html: string) => {
      const el = this.getEditorElement(section);
      if (el) el.innerHTML = this.htmlSanitizer.sanitize(html || '');
    };
    set('motifMainHtml', this.motifMainHtml());
    set('testsHtml', this.testsHtml());
    set('treatmentsHtml', this.treatmentsHtml());
    set('remarksHtml', this.remarksHtml());
  }

  // ── Private: Autosave ─────────────────────────────────────────────────────

  private startAutosave(): void {
    this.stopAutosave();
    this.autosaveNowTick.set(Date.now());
    const intervalMs = this.getAutosaveIntervalMs();
    if (intervalMs === null) {
      this.autosaveState.set('disabled');
      return;
    }
    this.autosaveState.set('idle');
    this.autosaveStatusTimer = setInterval(() => this.autosaveNowTick.set(Date.now()), 1000);
    this.autosaveTimer = setInterval(() => {
      if (this.mode() === 'edit' && !this.consultation()) return;
      void this.save({ close: false, isAutoSave: true });
    }, intervalMs);
  }

  private stopAutosave(): void {
    if (this.autosaveTimer !== null) { clearInterval(this.autosaveTimer); this.autosaveTimer = null; }
    if (this.autosaveStatusTimer !== null) { clearInterval(this.autosaveStatusTimer); this.autosaveStatusTimer = null; }
  }

  private getAutosaveIntervalMs(): number | null {
    const freq = this.preferences()?.patientAutoSaveFrequency ?? 'Jamais';
    if (freq === 'Toutes les 2 minutes') return 2 * 60 * 1000;
    if (freq === 'Toutes les 5 minutes') return 5 * 60 * 1000;
    if (freq === 'Toutes les 10 minutes') return 10 * 60 * 1000;
    return null;
  }

  // ── Private: Hydration helpers ────────────────────────────────────────────

  private hydrateReasonsFromRecord(reasonItems: ConsultationReasonItem[]): void {
    const next: Record<string, ConsultationReasonSelection> = {};
    for (const item of reasonItems ?? []) {
      const label = String(item?.label ?? '').trim();
      if (!label) continue;
      next[label] = { checked: true, value: String(item?.value ?? ''), important: Boolean(item?.important) };
    }
    this.reasonSelections.set(next);
  }

  private applyDefaultPractitioner(force = false): void {
    const current = String(this.editForm.controls.practitioner.value ?? '').trim();
    if (!force && current) return;
    const practitioner = this.getDefaultPractitioner();
    this.editForm.controls.practitioner.setValue(practitioner?.displayName ?? '');
  }

  private getDefaultPractitioner(): { username: string; displayName: string } | null {
    const sessionUsername = this.authService.username().trim().toLowerCase();
    const practitioners = this.practitioners();
    if (sessionUsername) {
      const match = practitioners.find((p) => p.username.trim().toLowerCase() === sessionUsername);
      if (match) {
        const displayName = String(match.displayName ?? '').trim() || match.username;
        return { username: match.username, displayName };
      }
      return { username: this.authService.username().trim(), displayName: this.authService.username().trim() };
    }
    if (practitioners[0]) {
      const displayName = String(practitioners[0].displayName ?? '').trim() || practitioners[0].username;
      return { username: practitioners[0].username, displayName };
    }
    return null;
  }

  private applyBillingDefaults(): void {
    const options = this.billingServiceOptions();
    if (options.length > 0 && !this.billingForm.controls.serviceLabel.dirty) {
      this.billingForm.patchValue({ serviceLabel: options[0].label, amountHt: options[0].amountHt, tvaRate: options[0].tvaRate });
    }
  }

  private populateBillingForm(): void {
    const patient = this.patient();
    this.billingForm.patchValue({
      sex: patient?.sex ?? 'Non renseigne',
      lastName: patient?.lastName ?? '',
      firstName: patient?.firstName ?? '',
      mobilePhone: patient?.mobilePhone ?? '',
      email: patient?.email ?? '',
      birthDate: patient?.birthDate ?? '',
      address1: patient?.address1 ?? '',
      address2: patient?.address2 ?? '',
      postalCode: patient?.postalCode ?? '',
      city: patient?.city ?? '',
      country: patient?.country || 'France',
      socialSecurityNumber: patient?.socialSecurityNumber ?? '',
      documentName: 'Facture acquittee',
      internalComment: '',
      paymentMethod: PAYMENT_PENDING_LABEL,
      amountHt: this.billingForm.controls.amountHt.value || 55,
      quantity: this.billingForm.controls.quantity.value || 1,
      tvaRate: this.billingForm.controls.tvaRate.value || 0
    });
    this.applyBillingDefaults();
  }

  // ── Private: Billing state persistence ───────────────────────────────────

  private persistBillingState(state: ConsultationBillingState): void {
    const patientId = this.patientId();
    if (!patientId || typeof window === 'undefined') return;
    try {
      const key = `${CONSULTATION_BILLING_STORAGE_KEY}:${patientId}`;
      const existing = (() => { try { return JSON.parse(window.localStorage.getItem(key) ?? '{}'); } catch { return {}; } })();
      existing[state.consultationId] = state;
      window.localStorage.setItem(key, JSON.stringify(existing));
    } catch { /* ignore */ }
  }

  private clearPersistedBillingState(): void {
    const patientId = this.patientId();
    const consultationId = this.consultation()?.id;
    if (!patientId || !consultationId || typeof window === 'undefined') return;
    try {
      const key = `${CONSULTATION_BILLING_STORAGE_KEY}:${patientId}`;
      const existing = (() => { try { return JSON.parse(window.localStorage.getItem(key) ?? '{}'); } catch { return {}; } })();
      delete existing[consultationId];
      window.localStorage.setItem(key, JSON.stringify(existing));
    } catch { /* ignore */ }
  }

  private readPersistedBillingState(): ConsultationBillingState | null {
    const patientId = this.patientId();
    const consultationId = this.consultationId();
    if (!patientId || !consultationId || typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(`${CONSULTATION_BILLING_STORAGE_KEY}:${patientId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed[consultationId] ?? null;
    } catch { return null; }
  }

  // ── Private: Mapping & utilities ──────────────────────────────────────────

  private mapInvoiceToState(
    consultationId: number,
    practitionerName: string,
    invoiceDocumentRef: string,
    invoice: Awaited<ReturnType<ApiService['getBillingInvoice']>>
  ): ConsultationBillingState {
    const payments = invoice.payments.map((e) => ({
      id: `db-pay-${e.id}`,
      amount: Number((e.amountCents / 100).toFixed(2)),
      currency: e.currency,
      method: e.paymentMethod,
      bankName: String(e.bankName ?? '').trim(),
      chequeNumber: String(e.chequeNumber ?? '').trim(),
      comment: String(e.notes ?? '').trim(),
      paidAt: e.paidAt
    }));
    const totalAmount = Number((invoice.amountCents / 100).toFixed(2));
    return {
      consultationId,
      billingInvoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount,
      currency: payments[0]?.currency || 'EUR',
      issuedAt: invoice.issuedAt,
      internalComment: invoice.notes,
      practitionerName,
      invoiceDocumentRef,
      paymentStatus: this.computePaymentStatus(totalAmount, payments),
      payments
    };
  }

  private computePaymentStatus(totalAmount: number, payments: ConsultationPaymentEntry[]): ConsultationPaymentStatus {
    const paid = payments.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const effective = Math.max(0, Number(totalAmount) || 0);
    if (paid <= 0) return 'pending';
    if (paid >= effective) return 'paid';
    return 'partial';
  }

  private resolveInvoiceDocumentRef(consultationId: number, issuedAtIso: string): string {
    const docs = this.patientDocuments().filter((d) =>
      Number(d.consultationId) === consultationId && String(d.mimeType ?? '').toLowerCase() === 'application/pdf'
    );
    if (!docs.length) return '';
    const typed = docs.filter((d) => d.documentType === 'invoice');
    const candidates = typed.length > 0 ? typed : docs.filter((d) => String(d.title ?? '').toLowerCase().includes('facture') || String(d.fileName ?? '').toLowerCase().includes('facture'));
    const final = candidates.length > 0 ? candidates : docs;
    const issuedAtMs = new Date(issuedAtIso).getTime();
    if (!Number.isFinite(issuedAtMs)) return String(final[0]?.documentRef ?? '');
    const best = [...final].sort((a, b) => {
      const aMs = new Date(a.createdAt).getTime();
      const bMs = new Date(b.createdAt).getTime();
      return Math.abs((Number.isFinite(aMs) ? aMs : issuedAtMs) - issuedAtMs) - Math.abs((Number.isFinite(bMs) ? bMs : issuedAtMs) - issuedAtMs);
    })[0];
    return String(best?.documentRef ?? '');
  }

  private resolvePreferredOfficeId(): number | null {
    const active = this.authService.activeOfficeId();
    if (Number.isInteger(active) && Number(active) > 0) return Number(active);
    const ctx = this.officeId();
    return Number.isInteger(ctx) && Number(ctx) > 0 ? Number(ctx) : null;
  }

  private resolveOffice(offices: Office[]): Office | null {
    const ctxId = this.officeId();
    if (Number.isInteger(ctxId) && Number(ctxId) > 0) {
      return offices.find((o) => o.id === Number(ctxId)) ?? null;
    }
    return null;
  }

  private parsePaymentAmount(raw: unknown): number {
    const normalized = String(raw ?? '').replace(/\s+/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : 0;
  }

  private isChequeMethod(method: string): boolean {
    const normalized = String(method ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return normalized.includes('cheque') || normalized.includes('chq') || normalized.includes('check');
  }

  // ── Private: Document upload ───────────────────────────────────────────────

  private async addDocuments(files: File[]): Promise<void> {
    const consultationId = this.consultation()?.id;
    const patientId = this.patientId();
    if (!patientId || this.isUploadingDocuments()) return;

    this.documentActionError.set('');
    this.isUploadingDocuments.set(true);

    try {
      if (consultationId) {
        // Edit mode: upload directly
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
      } else {
        // Create mode: stage for upload on save
        const created: ConsultationUploadDocument[] = [];
        for (const file of files) {
          const contentBase64 = await this.fileToBase64(file);
          created.push({
            tempKey: this.createTempKey('doc'),
            documentRef: this.createDocumentRef(),
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            title: file.name,
            comment: '',
            contentBase64
          });
        }
        this.pendingDocuments.update((items) => [...items, ...created]);
      }
    } catch {
      this.documentActionError.set('Impossible d\'ajouter le document.');
    } finally {
      this.isUploadingDocuments.set(false);
    }
  }

  // ── Private: Letter PDF ───────────────────────────────────────────────────

  private buildLetterPdf(office: Office | null, profile: MyUserProfile | null): Blob {
    const raw = this.letterForm.getRawValue();
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const margin = 14;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const contentWidth = pageWidth - margin * 2;

    const dateIso = (raw.date ? new Date(`${raw.date}T00:00:00`).toISOString() : null) ?? new Date().toISOString();
    const subject = this.normalizeText(String(raw.subject ?? '').trim() || 'Courrier patient');
    const content = this.normalizeText(String(raw.content ?? '').trim());

    let y = this.pdfBuilder.writeUnifiedHeader(pdf, { office, profile, officeFallbackName: this.officeName() });
    y += 20;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.text(`Date : ${this.formatShortDate(dateIso)}`, margin + 2, y);
    y += 8;
    pdf.setFont('helvetica', 'bold');
    pdf.text(subject, margin + 2, y);
    y += 8;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10.8);
    const lines = pdf.splitTextToSize(content, contentWidth - 4) as string[];
    pdf.text(lines, margin + 2, y);

    this.pdfBuilder.writeUnifiedFooter(pdf, { margin, pageWidth, pageHeight, profile, office });
    return pdf.output('blob');
  }

  // ── Private: Autosave toast ───────────────────────────────────────────────

  private showToast(message: string, options?: { force?: boolean }): void {
    const now = Date.now();
    if (!options?.force && now - this.autosaveToastLastShownAt < 15000) return;
    this.autosaveToastLastShownAt = now;
    this.autosaveToastMessage.set(message);
    this.autosaveToastVisible.set(true);
    this.clearToastTimer();
    this.autosaveToastHideTimer = setTimeout(() => {
      this.autosaveToastVisible.set(false);
      this.autosaveToastHideTimer = null;
    }, 2600);
  }

  private clearToastTimer(): void {
    if (this.autosaveToastHideTimer !== null) { clearTimeout(this.autosaveToastHideTimer); this.autosaveToastHideTimer = null; }
  }

  // ── Private: Text utilities ───────────────────────────────────────────────

  private parseNullableNumber(value: string): number | null {
    const normalized = String(value ?? '').trim();
    if (!normalized) return null;
    const parsed = Number(normalized.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private formatAmountFr(amount: number): string {
    return this.amountFormatter.format(Number.isFinite(Number(amount)) ? Number(amount) : 0);
  }

  private formatShortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  }

  private formatConsultationDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  private toDateTimeLocal(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private fromDateTimeLocal(value: string): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private interpolateColor(startHex: string, endHex: string, ratio: number): string {
    const clamp = Math.max(0, Math.min(1, ratio));
    const parse = (hex: string) => {
      const n = hex.replace('#', '');
      const [r, g, b] = n.length === 3
        ? n.split('').map((c) => parseInt(c + c, 16))
        : [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
      return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
    };
    const s = parse(startHex);
    const e = parse(endHex);
    return `rgb(${Math.round(s.r + (e.r - s.r) * clamp)}, ${Math.round(s.g + (e.g - s.g) * clamp)}, ${Math.round(s.b + (e.b - s.b) * clamp)})`;
  }

  private htmlToPlain(html: string): string {
    const withBreaks = String(html ?? '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/p\s*>/gi, '\n\n')
      .replace(/<\s*li\s*>/gi, '- ')
      .replace(/<\s*\/li\s*>/gi, '\n');
    const div = document.createElement('div');
    div.innerHTML = this.htmlSanitizer.sanitize(withBreaks);
    return this.normalizeText(div.textContent ?? '');
  }

  private schemaToPlain(value: string): string {
    if (!value?.trim()) return '';
    if (value.startsWith('{')) return '[Schéma dessiné]';
    return this.htmlToPlain(value);
  }

  private normalizeText(value: string): string {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  private toSlug(value: string): string {
    return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const idx = result.indexOf('base64,');
        resolve(idx >= 0 ? result.slice(idx + 7) : result);
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const idx = result.indexOf('base64,');
        resolve(idx >= 0 ? result.slice(idx + 7) : result);
      };
      reader.onerror = () => reject(new Error('Blob read failed'));
      reader.readAsDataURL(blob);
    });
  }

  private createDocumentRef(): string {
    return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private createTempKey(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
