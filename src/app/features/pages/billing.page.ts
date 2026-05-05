import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import {
  BillingDepositCandidate,
  BillingDepositDetail,
  BillingDepositListItem,
  BillingForecastPayload,
  BillingInsightsPayload,
  BillingInvoiceDetail,
  BillingOperation,
  BillingOperationsPayload,
  BillingUserOption,
  InvoiceSummaryTile,
  InvoiceTemplateBlockId,
  InvoiceTemplateBlockLayout,
  InvoiceTemplateGlobalSettings,
  InvoiceTemplateLayout,
  MyUserProfile,
  Office,
  OfficeOption
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { BsTooltipDirective } from '../../core/bs-tooltip.directive';

type ExportHistoryItem = {
  id: string;
  sessionId: string;
  label: string;
  operationsFormat: 'json' | 'excel';
  status: 'success' | 'error';
  createdAt: string;
};

type TrashExportItem = ExportHistoryItem & {
  deletedAt: string;
};

type DepositCandidateGroup = {
  groupRef: string | null;
  paymentMethod: string;
  bankName: string;
  chequeNumber: string;
  paidAt: string | null;
  invoices: BillingDepositCandidate[];
  totalAmountCents: number;
};

@Component({
  selector: 'app-billing-page',
  imports: [DatePipe, RouterLink, BsTooltipDirective],
  templateUrl: './billing.page.html',
  styleUrl: './billing.page.scss',
  host: {
    '(document:click)': 'closeActionMenus()'
  },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BillingPage implements OnDestroy {
  private static readonly EXPORT_HISTORY_STORAGE_KEY = 'billing-export-history-v1';
  private static readonly EXPORT_HISTORY_EXPIRATION_DAYS = 30;
  private exportToastTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);

  readonly tiles = signal<InvoiceSummaryTile[]>([]);
  readonly operations = signal<BillingOperation[]>([]);
  readonly offices = signal<OfficeOption[]>([]);
  readonly users = signal<BillingUserOption[]>([]);
  readonly billingInsights = signal<BillingInsightsPayload | null>(null);
  readonly billingForecast = signal<BillingForecastPayload | null>(null);
  readonly debtorSearch = signal('');
  readonly debtorSort = signal<'name' | 'invoices' | 'outstanding'>('outstanding');
  readonly debtorSortDirection = signal<'asc' | 'desc'>('desc');
  readonly debtorPage = signal(1);
  readonly debtorPageSize = signal(5);
  readonly exportHistoryPage = signal(1);
  readonly exportHistoryPageSize = signal(10);

  readonly fromDate = signal('');
  readonly toDate = signal('');
  readonly selectedOfficeId = signal<number | null>(this.authService.activeOfficeId());
  readonly isAllOfficesOverride = signal(false);
  readonly selectedUserId = signal<number | null>(null);

  readonly selectedOperationIds = signal<string[]>([]);
  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly isSnapshotExporting = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly exportHistory = signal<ExportHistoryItem[]>([]);
  readonly exportHistoryFilter = signal<'all' | 'success' | 'error'>('all');
  readonly exportHistoryFormatFilter = signal<'all' | 'json' | 'excel'>('all');
  readonly exportHistorySort = signal<'date-desc' | 'date-asc' | 'status' | 'relevance'>('date-desc');
  readonly exportHistorySearch = signal('');
  readonly selectedExportIds = signal<Set<string>>(new Set());
  readonly exportToastMessage = signal('');
  readonly exportToastType = signal<'success' | 'error'>('success');
  readonly isExportToastVisible = signal(false);
  readonly isDeleteExportConfirmVisible = signal(false);
  readonly deleteExportConfirmCount = signal(0);
  readonly exportTrash = signal<TrashExportItem[]>([]);
  readonly showExportTrash = signal(false);
  readonly isTrashActionConfirmVisible = signal(false);
  readonly trashActionType = signal<'restore-all' | 'empty' | null>(null);
  readonly consultationSelectionModal = signal<'bulk-update' | 'payment' | null>(null);

  private readonly EXPORT_TRASH_STORAGE_KEY = 'osteo_export_trash';
  private readonly EXPORT_TRASH_EXPIRATION_DAYS = 7;

  readonly expenseOccurredAt = signal(this.defaultNowDateTimeLocal());
  readonly expenseTitle = signal('');
  readonly expenseAmount = signal('');
  readonly expensePaymentMethod = signal('');
  readonly expenseNotes = signal('');
  readonly isExpenseModalOpen = signal(false);

  readonly depositOccurredAt = signal(this.defaultNowDateTimeLocal());
  readonly depositType = signal<'cheque' | 'especes'>('cheque');
  readonly depositWizardStep = signal<1 | 2 | 3>(1);
  readonly depositTitle = signal('');
  readonly depositAmount = signal('');
  readonly depositNotes = signal('');
  readonly depositCode = signal('');
  readonly depositBankName = signal('');
  readonly depositAccountLabel = signal('');
  readonly isDepositModalOpen = signal(false);
  readonly isDepositListModalOpen = signal(false);
  readonly isDepositEditorModalOpen = signal(false);
  readonly depositModalType = signal<'cheque' | 'especes'>('cheque');
  readonly depositEditorCandidateIds = signal<string[]>([]);
  readonly editingDepositId = signal<number | null>(null);
  readonly deposits = signal<BillingDepositListItem[]>([]);
  readonly depositCandidates = signal<BillingDepositCandidate[]>([]);
  readonly depositCandidateSearch = signal('');
  readonly isLoadingDeposits = signal(false);
  readonly isLoadingDepositCandidates = signal(false);
  readonly isDepositMenuOpen = signal(false);
  readonly isExportMenuOpen = signal(false);
  readonly currentUserProfile = signal<MyUserProfile | null>(null);

  readonly bulkOwnerUserId = signal<number | null>(null);
  readonly bulkRetrocessionPercent = signal('');
  readonly bulkRetrocessionRecipient = signal('');

  readonly prototypePaymentOccurredAt = signal(this.defaultNowDateTimeLocal());
  readonly prototypePaymentAmount = signal('');
  readonly prototypePaymentMethod = signal('');
  readonly prototypePaymentBankName = signal('');
  readonly prototypePaymentChequeNumber = signal('');
  readonly prototypePaymentReference = signal('');
  readonly prototypePaymentNotes = signal('');

  readonly canExportBilling = computed(() => this.authService.hasPermission('export-billing'));
  readonly canManageBilling = computed(() => this.authService.hasPermission('mark-payment'));
  readonly canCustomizeInvoiceTemplate = computed(() =>
    this.authService.hasPermission('customize-invoice-template') ||
    this.authService.hasPermission('update-office-settings')
  );

  // Invoice template tab state
  readonly activeBillingTab = signal<'operations' | 'invoice-template'>('operations');
  readonly fullOfficesCache = signal<Office[]>([]);
  readonly isLoadingFullOffices = signal(false);
  readonly invoiceTemplateSelectedOfficeId = signal<number | null>(null);
  readonly invoiceTemplateLayout = signal<InvoiceTemplateLayout>(this.createDefaultInvoiceTemplateLayout());
  readonly isSavingInvoiceTemplate = signal(false);
  readonly invoiceTemplateSaveSuccess = signal('');
  readonly invoiceTemplateSaveError = signal('');
  readonly draggedInvoiceTemplateBlockId = signal<InvoiceTemplateBlockId | null>(null);
  readonly selectedInvoiceTemplateBlockId = signal<InvoiceTemplateBlockId | null>(null);
  readonly invoiceTemplatePreviewMode = signal<'labels' | 'sample-data'>('labels');
  private invoiceTemplateDragOffset: { x: number; y: number } | null = null;

  readonly invoiceTemplateSelectedOffice = computed(() => {
    const id = this.invoiceTemplateSelectedOfficeId();
    return this.fullOfficesCache().find((o) => o.id === id) ?? null;
  });

  readonly invoiceTemplateBlockOptions: Array<{ key: InvoiceTemplateBlockId; label: string }> = [
    { key: 'logo', label: 'Logo' },
    { key: 'practitioner', label: 'Infos praticien' },
    { key: 'patient', label: 'Infos patient' },
    { key: 'invoiceMeta', label: 'Métadonnées facture' },
    { key: 'lineItems', label: 'Lignes de facturation' },
    { key: 'totals', label: 'Totaux' },
    { key: 'payment', label: 'Paiement' },
    { key: 'mentions', label: 'Mentions légales' },
    { key: 'signature', label: 'Zone signature' }
  ];

  readonly officeLetterCommonVariables: Array<{ token: string; description: string }> = [
    { token: '{$DATE}', description: 'Date du jour' },
    { token: '{$NOM}', description: 'Nom du patient' },
    { token: '{$PRENOM}', description: 'Prénom du patient' },
    { token: '{$NOMPRATICIEN}', description: 'Nom du praticien' },
    { token: '{$PRENOMPRATICIEN}', description: 'Prénom du praticien' }
  ];
  private readonly activeOfficeSyncEffect = effect(() => {
    const activeOfficeId = this.authService.activeOfficeId();
    if (this.isAllOfficesOverride()) {
      return;
    }

    if (this.selectedOfficeId() === activeOfficeId) {
      return;
    }

    this.selectedOfficeId.set(activeOfficeId);
    this.selectedUserId.set(null);
    this.debtorPage.set(1);
    void this.load();
  });

  readonly selectedCount = computed(() => this.selectedOperationIds().length);

  readonly selectedInvoiceOperations = computed(() => {
    return this.selectedOperations().filter((operation) => {
      return operation.sourceType === 'invoice'
        && Number.isInteger(Number(operation.sourceId))
        && Number(operation.sourceId) > 0
        && Number(operation.creditCents ?? 0) > 0;
    });
  });

  readonly selectedInvoiceIds = computed(() => {
    return [...new Set(this.selectedInvoiceOperations().map((operation) => Number(operation.sourceId)))];
  });

  readonly selectedUnpaidInvoiceOperations = computed(() => {
    return this.selectedInvoiceOperations().filter((operation) => Number(operation.remainingAmountCents ?? 0) > 0);
  });

  readonly selectedUnpaidInvoiceIds = computed(() => {
    return [...new Set(this.selectedUnpaidInvoiceOperations().map((operation) => Number(operation.sourceId)))];
  });

  readonly selectedUnpaidAmountCents = computed(() => {
    return this.selectedUnpaidInvoiceOperations().reduce((sum, operation) => sum + Number(operation.remainingAmountCents ?? 0), 0);
  });

  readonly activeBillingOffice = computed(() => {
    const selectedOfficeId = this.selectedOfficeId();
    const offices = this.offices();
    if (selectedOfficeId != null) {
      return offices.find((office) => office.id === selectedOfficeId) ?? null;
    }
    return offices.length === 1 ? offices[0] : null;
  });

  readonly consultationPaymentMethodOptions = computed(() => {
    const officesById = new Map(this.offices().map((office) => [office.id, office]));
    const selectedOfficeIds = [...new Set(
      this.selectedUnpaidInvoiceOperations()
        .map((operation) => operation.officeId)
        .filter((officeId): officeId is number => Number.isInteger(officeId) && Number(officeId) > 0)
    )];

    const sourceOffices = selectedOfficeIds.length > 0
      ? selectedOfficeIds
        .map((officeId) => officesById.get(officeId) ?? null)
        .filter((office): office is OfficeOption => office !== null)
      : (this.activeBillingOffice() ? [this.activeBillingOffice()!] : []);

    const values = sourceOffices
      .flatMap((office) => office.paymentMethods ?? [])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);

    return [...new Set(values)];
  });

  readonly isPrototypeChequePayment = computed(() => {
    const normalized = this.normalizePaymentMethod(this.prototypePaymentMethod());
    return normalized.includes('cheque') || normalized.includes('chq') || normalized.includes('check');
  });

  readonly canRunPrototypeGroupedPayment = computed(() => {
    const amount = Number(this.prototypePaymentAmount());
    const hasChequeFields = !this.isPrototypeChequePayment()
      || (this.prototypePaymentBankName().trim().length > 0 && this.prototypePaymentChequeNumber().trim().length > 0);

    return this.selectedUnpaidInvoiceIds().length > 0
      && Number.isFinite(amount)
      && amount > 0
      && this.prototypePaymentMethod().trim().length > 0
      && hasChequeFields;
  });

  readonly selectedDepositCandidates = computed(() => {
    const selected = new Set(this.depositEditorCandidateIds());
    return this.depositCandidates().filter((item) => selected.has(item.operationId));
  });

  readonly compatibleDepositCandidates = computed(() => {
    const type = this.depositType();
    return this.depositCandidates().filter((item) => this.isCandidateCompatibleWithDepositType(item.paymentMethod, type));
  });

  readonly filteredDepositCandidates = computed(() => {
    const query = this.depositCandidateSearch().trim().toLowerCase();
    const rows = this.compatibleDepositCandidates();
    if (!query) {
      return rows;
    }

    return rows.filter((item) => {
      const patient = String(item.patientName ?? '').toLowerCase();
      const invoice = String(item.invoiceNumber ?? '').toLowerCase();
      const method = String(item.paymentMethod ?? '').toLowerCase();
      return patient.includes(query) || invoice.includes(query) || method.includes(query);
    });
  });

  readonly groupedDepositCandidates = computed(() => {
    const candidates = this.filteredDepositCandidates();
    const groups = new Map<string, DepositCandidateGroup>();

    for (const candidate of candidates) {
      // Use groupRef if available, otherwise use a unique key per invoice
      const key = candidate.groupRef ?? `ungrouped:${candidate.sourceId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          groupRef: candidate.groupRef,
          paymentMethod: candidate.paymentMethod,
          bankName: candidate.bankName,
          chequeNumber: candidate.chequeNumber,
          paidAt: candidate.paidAt,
          invoices: [],
          totalAmountCents: 0
        });
      }
      const group = groups.get(key)!;
      group.invoices.push(candidate);
      group.totalAmountCents += candidate.amountCents;
    }

    // Sort groups by paidAt descending, then by first invoice date
    return Array.from(groups.values()).sort((a, b) => {
      const aDate = new Date(a.paidAt || a.invoices[0]?.occurredAt || '');
      const bDate = new Date(b.paidAt || b.invoices[0]?.occurredAt || '');
      return bDate.getTime() - aDate.getTime();
    });
  });

  readonly selectedDepositCandidateCount = computed(() => this.selectedDepositCandidates().length);

  readonly incompatibleSelectedDepositCandidates = computed(() => {
    const type = this.depositType();
    return this.selectedDepositCandidates().filter((item) => !this.isCandidateCompatibleWithDepositType(item.paymentMethod, type));
  });

  readonly hasIncompatibleSelectedDepositCandidates = computed(() => {
    return this.incompatibleSelectedDepositCandidates().length > 0;
  });

  readonly canProceedToDepositPointage = computed(() => {
    return this.depositOccurredAt().trim().length > 0;
  });

  readonly canProceedToDepositRecap = computed(() => {
    return this.selectedDepositCandidateCount() > 0 && Number(this.depositAmount()) > 0;
  });

  readonly isAllFilteredDepositCandidatesSelected = computed(() => {
    const filtered = this.filteredDepositCandidates();
    if (filtered.length === 0) {
      return false;
    }
    const selected = new Set(this.depositEditorCandidateIds());
    return filtered.every((item) => selected.has(item.operationId));
  });

  readonly selectedDepositCandidateAmountCents = computed(() => {
    return this.selectedDepositCandidates().reduce((sum, item) => sum + item.amountCents, 0);
  });

  readonly selectedOperations = computed(() => {
    const selected = new Set(this.selectedOperationIds());
    return this.operations().filter((operation) => selected.has(operation.id));
  });

  readonly filteredTopDebtors = computed(() => {
    const topDebtors = this.billingInsights()?.receivables?.topDebtors ?? [];
    const query = this.debtorSearch().trim().toLowerCase();
    if (!query) {
      return topDebtors;
    }

    return topDebtors.filter((item) => String(item.patientName ?? '').toLowerCase().includes(query));
  });

  readonly sortedTopDebtors = computed(() => {
    const rows = [...this.filteredTopDebtors()];
    const direction = this.debtorSortDirection() === 'asc' ? 1 : -1;
    const sortBy = this.debtorSort();

    rows.sort((left, right) => {
      if (sortBy === 'name') {
        return direction * String(left.patientName ?? '').localeCompare(String(right.patientName ?? ''), 'fr');
      }
      if (sortBy === 'invoices') {
        return direction * ((Number(left.invoiceCount ?? 0) - Number(right.invoiceCount ?? 0)) || String(left.patientName ?? '').localeCompare(String(right.patientName ?? ''), 'fr'));
      }
      return direction * ((Number(left.totalOutstandingCents ?? 0) - Number(right.totalOutstandingCents ?? 0)) || String(left.patientName ?? '').localeCompare(String(right.patientName ?? ''), 'fr'));
    });

    return rows;
  });

  readonly debtorTotalPages = computed(() => {
    const pageSize = Math.max(1, Number(this.debtorPageSize() ?? 5));
    return Math.max(1, Math.ceil(this.sortedTopDebtors().length / pageSize));
  });

  readonly pagedTopDebtors = computed(() => {
    const pageSize = Math.max(1, Number(this.debtorPageSize() ?? 5));
    const page = Math.min(Math.max(1, this.debtorPage()), this.debtorTotalPages());
    const start = (page - 1) * pageSize;
    return this.sortedTopDebtors().slice(start, start + pageSize);
  });

  readonly filteredExportHistory = computed(() => {
    const statusFilter = this.exportHistoryFilter();
    const formatFilter = this.exportHistoryFormatFilter();

    const statusFiltered = statusFilter === 'all'
      ? this.exportHistory()
      : this.exportHistory().filter((item) => item.status === statusFilter);

    if (formatFilter === 'all') {
      return statusFiltered;
    }

    return statusFiltered.filter((item) =>
      item.operationsFormat === formatFilter
    );
  });

  readonly searchedExportHistory = computed(() => {
    const query = this.exportHistorySearch().trim().toLowerCase();
    const searched = query.length === 0
      ? this.filteredExportHistory()
      : this.filteredExportHistory().filter((item) => {
        const label = String(item.label ?? '').toLowerCase();
        const sessionId = String(item.sessionId ?? '').toLowerCase();
        return label.includes(query) || sessionId.includes(query);
      });

    const rows = [...searched];
    const sort = this.exportHistorySort();
    
    if (sort === 'relevance' && query.length > 0) {
      return rows.sort((left, right) => {
        const leftScore = this.calculateRelevanceScore(left, query);
        const rightScore = this.calculateRelevanceScore(right, query);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      });
    }
    
    if (sort === 'date-asc') {
      return rows.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    }
    if (sort === 'status') {
      return rows.sort((left, right) => {
        if (left.status === right.status) {
          return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        }
        return left.status === 'error' ? -1 : 1;
      });
    }
    return rows.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  });

  readonly totalExportHistoryPages = computed(() => {
    const total = this.searchedExportHistory().length;
    const pageSize = this.exportHistoryPageSize();
    return Math.max(1, Math.ceil(total / pageSize));
  });

  readonly displayedExportHistory = computed(() => {
    const searched = this.searchedExportHistory();
    const page = this.exportHistoryPage();
    const pageSize = this.exportHistoryPageSize();
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return searched.slice(start, end);
  });

  readonly visibleExportIds = computed(() => {
    return new Set(this.displayedExportHistory().map((item) => item.id));
  });

  readonly isAllVisibleSelected = computed(() => {
    const visible = this.visibleExportIds();
    if (visible.size === 0) {
      return false;
    }
    const selected = this.selectedExportIds();
    return Array.from(visible).every((id) => selected.has(id));
  });

  readonly hasAnyVisibleSelected = computed(() => {
    const visible = this.visibleExportIds();
    const selected = this.selectedExportIds();
    return Array.from(visible).some((id) => selected.has(id));
  });

  readonly selectedExportCount = computed(() => {
    return this.selectedExportIds().size;
  });

  readonly hasActiveExportSearch = computed(() => {
    return this.exportHistorySearch().trim().length > 0;
  });

  readonly exportHistoryStats = computed(() => {
    const items = this.exportHistory();
    const total = items.length;
    const successful = items.filter((item) => item.status === 'success').length;
    const failed = items.filter((item) => item.status === 'error').length;
    const successRate = total === 0 ? 0 : Math.round((successful / total) * 100);

    const excelCount = items.filter((item) =>
      item.operationsFormat === 'excel'
    ).length;
    const jsonCount = items.filter((item) =>
      item.operationsFormat === 'json'
    ).length;

    return {
      total,
      successful,
      failed,
      successRate,
      excelCount,
      jsonCount,
    };
  });

  readonly exportHistoryTrends = computed(() => {
    const rows = this.exportHistory();
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = todayStart - (6 * dayMs);

    let todayCount = 0;
    let last7DaysCount = 0;

    for (const item of rows) {
      const createdAt = new Date(item.createdAt).getTime();
      if (Number.isNaN(createdAt)) {
        continue;
      }
      if (createdAt >= todayStart) {
        todayCount += 1;
      }
      if (createdAt >= weekStart) {
        last7DaysCount += 1;
      }
    }

    const stats = this.exportHistoryStats();
    const dominantFormat = stats.excelCount === stats.jsonCount
      ? 'Mixte'
      : (stats.excelCount > stats.jsonCount ? 'CSV' : 'JSON');

    return {
      todayCount,
      last7DaysCount,
      trashCount: this.activeExportTrash().length,
      dominantFormat
    };
  });

  readonly activeExportTrash = computed(() => {
    const trash = this.exportTrash();
    const now = new Date();
    const expirationMs = this.EXPORT_TRASH_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;

    return trash.filter((item) => {
      const deletedTime = new Date(item.deletedAt).getTime();
      const ageMs = now.getTime() - deletedTime;
      return ageMs < expirationMs;
    });
  });

  constructor() {
    this.restoreExportHistory();
    this.restoreExportTrash();

    const now = new Date();
    this.fromDate.set(this.toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1)));
    this.toDate.set(this.toDateInputValue(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    void this.load();
  }

  ngOnDestroy(): void {
    if (this.exportToastTimeout != null) {
      clearTimeout(this.exportToastTimeout);
      this.exportToastTimeout = null;
    }
  }

  async applyPreset(preset: 'today' | 'yesterday' | 'month' | 'lastMonth' | 'year' | 'lastYear'): Promise<void> {
    const now = new Date();
    let from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let to = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (preset === 'yesterday') {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    }
    if (preset === 'month') {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }
    if (preset === 'lastMonth') {
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to = new Date(now.getFullYear(), now.getMonth(), 0);
    }
    if (preset === 'year') {
      from = new Date(now.getFullYear(), 0, 1);
      to = new Date(now.getFullYear(), 11, 31);
    }
    if (preset === 'lastYear') {
      from = new Date(now.getFullYear() - 1, 0, 1);
      to = new Date(now.getFullYear() - 1, 11, 31);
    }

    this.fromDate.set(this.toDateInputValue(from));
    this.toDate.set(this.toDateInputValue(to));
    this.debtorPage.set(1);
    await this.load();
  }

  async onDateRangeChange(): Promise<void> {
    this.debtorPage.set(1);
    await this.load();
  }

  async onOfficeChange(value: string): Promise<void> {
    const parsed = Number(value);
    const nextOfficeId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    if (nextOfficeId === null) {
      if (this.isAllOfficesOverride() && this.selectedOfficeId() === null) {
        return;
      }

      this.isAllOfficesOverride.set(true);
      this.selectedOfficeId.set(null);
      this.selectedUserId.set(null);
      this.debtorPage.set(1);
      await this.load();
      return;
    }

    this.isAllOfficesOverride.set(false);
    if (nextOfficeId === this.selectedOfficeId() && this.authService.activeOfficeId() === nextOfficeId) {
      return;
    }

    if (this.authService.activeOfficeId() === nextOfficeId) {
      this.selectedOfficeId.set(nextOfficeId);
      this.selectedUserId.set(null);
      this.debtorPage.set(1);
      await this.load();
      return;
    }

    this.authService.setActiveOfficeId(nextOfficeId);
  }

  async onUserChange(value: string): Promise<void> {
    const parsed = Number(value);
    this.selectedUserId.set(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
    this.debtorPage.set(1);
    await this.load();
  }

  onBulkOwnerChange(value: string): void {
    const parsed = Number(value);
    this.bulkOwnerUserId.set(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
  }

  isOperationSelected(operationId: string): boolean {
    return this.selectedOperationIds().includes(operationId);
  }

  toggleOperationSelection(operationId: string, checked: boolean): void {
    const current = this.selectedOperationIds();
    if (checked) {
      if (!current.includes(operationId)) {
        this.selectedOperationIds.set([...current, operationId]);
      }
      return;
    }
    this.selectedOperationIds.set(current.filter((id) => id !== operationId));
  }

  toggleSelectAll(checked: boolean): void {
    if (checked) {
      this.selectedOperationIds.set(this.operations().map((operation) => operation.id));
      return;
    }
    this.selectedOperationIds.set([]);
  }

  toggleDepositMenu(): void {
    const nextState = !this.isDepositMenuOpen();
    this.isDepositMenuOpen.set(nextState);
    if (nextState) {
      this.isExportMenuOpen.set(false);
    }
  }

  toggleExportMenu(): void {
    if (!this.canExportBilling()) {
      this.isExportMenuOpen.set(false);
      return;
    }

    const nextState = !this.isExportMenuOpen();
    this.isExportMenuOpen.set(nextState);
    if (nextState) {
      this.isDepositMenuOpen.set(false);
    }
  }

  closeActionMenus(): void {
    this.isDepositMenuOpen.set(false);
    this.isExportMenuOpen.set(false);
  }

  async switchBillingTab(tab: 'operations' | 'invoice-template'): Promise<void> {
    this.activeBillingTab.set(tab);
    if (tab === 'invoice-template' && this.fullOfficesCache().length === 0) {
      await this.loadFullOffices();
    }
  }

  async loadFullOffices(): Promise<void> {
    if (this.isLoadingFullOffices()) {
      return;
    }
    this.isLoadingFullOffices.set(true);
    try {
      const offices = await this.api.getOffices();
      this.fullOfficesCache.set(offices);
      if (this.invoiceTemplateSelectedOfficeId() === null && offices.length > 0) {
        const activeId = this.authService.activeOfficeId();
        const found = offices.find((o) => o.id === activeId) ?? offices[0];
        this.invoiceTemplateSelectedOfficeId.set(found.id);
        this.invoiceTemplateLayout.set(this.parseInvoiceTemplateLayout(found.invoiceTemplateLayoutJson));
      }
    } catch {
      // Non-blocking
    } finally {
      this.isLoadingFullOffices.set(false);
    }
  }

  onInvoiceTemplateOfficeChange(officeId: number): void {
    this.invoiceTemplateSelectedOfficeId.set(officeId);
    const office = this.fullOfficesCache().find((o) => o.id === officeId);
    if (office) {
      this.invoiceTemplateLayout.set(this.parseInvoiceTemplateLayout(office.invoiceTemplateLayoutJson));
    }
    this.selectedInvoiceTemplateBlockId.set(null);
    this.invoiceTemplateSaveSuccess.set('');
    this.invoiceTemplateSaveError.set('');
  }

  async saveInvoiceTemplate(): Promise<void> {
    const officeId = this.invoiceTemplateSelectedOfficeId();
    if (!officeId || !this.canCustomizeInvoiceTemplate()) {
      return;
    }
    this.isSavingInvoiceTemplate.set(true);
    this.invoiceTemplateSaveSuccess.set('');
    this.invoiceTemplateSaveError.set('');
    try {
      const json = JSON.stringify(this.invoiceTemplateLayout());
      const result = await this.api.updateOfficeInvoiceTemplate(officeId, json);
      // Update cache
      const cache = this.fullOfficesCache().map((o) =>
        o.id === officeId ? { ...o, invoiceTemplateLayoutJson: result.invoiceTemplateLayoutJson } : o
      );
      this.fullOfficesCache.set(cache);
      this.invoiceTemplateSaveSuccess.set('Template enregistré avec succès.');
      setTimeout(() => this.invoiceTemplateSaveSuccess.set(''), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la sauvegarde';
      this.invoiceTemplateSaveError.set(msg);
    } finally {
      this.isSavingInvoiceTemplate.set(false);
    }
  }

  resetInvoiceTemplateLayout(): void {
    this.invoiceTemplateLayout.set(this.createDefaultInvoiceTemplateLayout());
    this.selectedInvoiceTemplateBlockId.set(null);
  }

  invoiceTemplateBlockValue(blockId: InvoiceTemplateBlockId, field: 'x' | 'y' | 'w'): number {
    return this.invoiceTemplateLayout()[blockId][field];
  }

  updateInvoiceTemplateBlock(blockId: InvoiceTemplateBlockId, field: 'x' | 'y' | 'w', value: string): void {
    const nextValue = this.clampTemplateValue(field, Number(value));
    const nextLayout: InvoiceTemplateLayout = {
      ...this.invoiceTemplateLayout(),
      [blockId]: { ...this.invoiceTemplateLayout()[blockId], [field]: nextValue }
    };
    const block = nextLayout[blockId];
    if (block.x + block.w > 100) {
      block.x = Math.max(0, 100 - block.w);
    }
    this.invoiceTemplateLayout.set(nextLayout);
  }

  selectInvoiceTemplateBlock(blockId: InvoiceTemplateBlockId | null): void {
    this.selectedInvoiceTemplateBlockId.set(blockId);
  }

  toggleInvoiceTemplateBlockVisible(blockId: InvoiceTemplateBlockId): void {
    const layout = this.invoiceTemplateLayout();
    this.invoiceTemplateLayout.set({
      ...layout,
      [blockId]: { ...layout[blockId], visible: !layout[blockId].visible }
    });
  }

  updateInvoiceTemplateBlockStyle(
    blockId: InvoiceTemplateBlockId,
    field: 'fontSize' | 'color' | 'borderStyle' | 'customLabel' | 'content',
    value: string
  ): void {
    const layout = this.invoiceTemplateLayout();
    let parsed: string | number = value;
    if (field === 'fontSize') {
      parsed = this.clampTemplateValue('fontSize', Number(value));
    } else if (field === 'customLabel') {
      parsed = value.slice(0, 80);
    } else if (field === 'content') {
      parsed = value.slice(0, 5000);
    }
    this.invoiceTemplateLayout.set({
      ...layout,
      [blockId]: { ...layout[blockId], [field]: parsed }
    });
  }

  updateInvoiceTemplateGlobalSetting<K extends keyof InvoiceTemplateGlobalSettings>(key: K, value: string): void {
    const layout = this.invoiceTemplateLayout();
    const parsed: InvoiceTemplateGlobalSettings[K] = key === 'showPageNumber'
      ? (value === 'true') as InvoiceTemplateGlobalSettings[K]
      : value as InvoiceTemplateGlobalSettings[K];
    this.invoiceTemplateLayout.set({
      ...layout,
      _global: { ...layout._global, [key]: parsed }
    });
  }

  onInvoiceTemplateDragStart(event: DragEvent, blockId: InvoiceTemplateBlockId): void {
    const target = event.currentTarget as HTMLElement | null;
    const preview = target?.parentElement as HTMLElement | null;
    if (!target || !preview) return;
    const targetRect = target.getBoundingClientRect();
    const pointerX = Number.isFinite(event.clientX) ? event.clientX : targetRect.left;
    const pointerY = Number.isFinite(event.clientY) ? event.clientY : targetRect.top;
    this.invoiceTemplateDragOffset = {
      x: Math.max(0, pointerX - targetRect.left),
      y: Math.max(0, pointerY - targetRect.top)
    };
    this.draggedInvoiceTemplateBlockId.set(blockId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', blockId);
      event.dataTransfer.setData('application/x-osteo-invoice-block', blockId);
    }
  }

  onInvoiceTemplateDragEnd(): void {
    this.draggedInvoiceTemplateBlockId.set(null);
    this.invoiceTemplateDragOffset = null;
  }

  onInvoiceTemplatePreviewDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  onInvoiceTemplatePreviewDrop(event: DragEvent): void {
    event.preventDefault();
    const preview = event.currentTarget as HTMLElement | null;
    if (!preview) { this.onInvoiceTemplateDragEnd(); return; }
    const fromTransfer = event.dataTransfer?.getData('application/x-osteo-invoice-block') || event.dataTransfer?.getData('text/plain') || '';
    const blockId = this.toInvoiceTemplateBlockId(fromTransfer) ?? this.draggedInvoiceTemplateBlockId();
    if (!blockId) { this.onInvoiceTemplateDragEnd(); return; }
    const previewRect = preview.getBoundingClientRect();
    if (previewRect.width <= 0 || previewRect.height <= 0) { this.onInvoiceTemplateDragEnd(); return; }
    const offset = this.invoiceTemplateDragOffset ?? { x: 0, y: 0 };
    const rawLeft = event.clientX - previewRect.left - offset.x;
    const rawTop = event.clientY - previewRect.top - offset.y;
    const nextX = (rawLeft / previewRect.width) * 100;
    const nextY = (rawTop / previewRect.height) * 100;
    const layout = this.invoiceTemplateLayout();
    const nextLayout: InvoiceTemplateLayout = {
      ...layout,
      [blockId]: {
        ...layout[blockId],
        x: this.clampTemplateValue('x', nextX),
        y: this.clampTemplateValue('y', nextY)
      }
    };
    const block = nextLayout[blockId];
    if (block.x + block.w > 100) block.x = Math.max(0, 100 - block.w);
    this.invoiceTemplateLayout.set(nextLayout);
    this.onInvoiceTemplateDragEnd();
  }

  insertMentionsVariable(token: string, textareaEl: HTMLTextAreaElement | null): void {
    if (!textareaEl) return;
    const start = textareaEl.selectionStart ?? textareaEl.value.length;
    const end = textareaEl.selectionEnd ?? start;
    const next = textareaEl.value.slice(0, start) + token + textareaEl.value.slice(end);
    this.updateInvoiceTemplateBlockStyle('mentions', 'content', next);
    textareaEl.value = next;
    const cursor = start + token.length;
    setTimeout(() => { textareaEl.setSelectionRange(cursor, cursor); textareaEl.focus(); });
  }

  async previewInvoiceTemplatePdf(): Promise<void> {
    const JsPdf = await this.loadJsPdf();
    const pdf = this.buildSampleInvoicePdf(this.invoiceTemplateLayout(), JsPdf);
    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async downloadInvoicePdf(invoiceId: number, officeId: number | null): Promise<void> {
    try {
      const [invoice, offices] = await Promise.all([
        this.api.getBillingInvoice(invoiceId),
        this.fullOfficesCache().length > 0
          ? Promise.resolve(this.fullOfficesCache())
          : this.api.getOffices().then((os) => { this.fullOfficesCache.set(os); return os; })
      ]);
      const office = offices.find((o) => o.id === officeId) ?? null;
      const layout = office
        ? this.parseInvoiceTemplateLayout(office.invoiceTemplateLayoutJson)
        : this.createDefaultInvoiceTemplateLayout();
      const JsPdf = await this.loadJsPdf();
      const pdf = this.buildInvoicePdf(invoice, office, layout, JsPdf);
      pdf.save(`facture-${invoice.invoiceNumber || invoiceId}.pdf`);
    } catch (err) {
      console.error('Error generating invoice PDF:', err);
    }
  }

  openConsultationSelectionModal(mode: 'bulk-update' | 'payment'): void {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    this.closeActionMenus();
    this.errorMessage.set('');
    this.successMessage.set('');
    if (mode === 'payment' && this.selectedUnpaidInvoiceIds().length === 0) {
      return;
    }
    if (mode === 'payment') {
      this.prototypePaymentAmount.set((this.selectedUnpaidAmountCents() / 100).toFixed(2));
      const paymentMethods = this.consultationPaymentMethodOptions();
      if (!paymentMethods.includes(this.prototypePaymentMethod().trim())) {
        this.prototypePaymentMethod.set(paymentMethods[0] ?? '');
      }
    }
    this.consultationSelectionModal.set(mode);
  }

  closeConsultationSelectionModal(): void {
    this.consultationSelectionModal.set(null);
  }

  openExpenseModal(): void {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    this.closeActionMenus();
    this.expenseOccurredAt.set(this.defaultNowDateTimeLocal());
    this.expenseTitle.set('');
    this.expenseAmount.set('');
    this.expensePaymentMethod.set('');
    this.expenseNotes.set('');
    this.errorMessage.set('');
    this.successMessage.set('');
    this.isExpenseModalOpen.set(true);
  }

  closeExpenseModal(): void {
    this.isExpenseModalOpen.set(false);
  }

  async saveExpense(): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    const title = this.expenseTitle().trim();
    const amount = Number(this.expenseAmount());
    if (!title || !Number.isFinite(amount) || amount <= 0) {
      this.errorMessage.set('Saisissez un titre et un montant de depense valide.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      await this.api.createBillingExpense({
        occurredAt: this.fromDateTimeLocalValue(this.expenseOccurredAt()) ?? new Date().toISOString(),
        officeId: this.selectedOfficeId(),
        ownerUserId: this.selectedUserId(),
        title,
        amount,
        currency: 'EUR',
        paymentMethod: this.expensePaymentMethod().trim(),
        notes: this.expenseNotes().trim()
      });
      this.successMessage.set('Depense enregistree.');
      this.closeExpenseModal();
      await this.load();
    } catch {
      this.errorMessage.set('Impossible d\'enregistrer la depense.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async openDepositModal(type: 'cheque' | 'especes'): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    this.closeActionMenus();
    this.depositModalType.set(type);
    this.errorMessage.set('');
    this.successMessage.set('');
    this.isDepositListModalOpen.set(true);
    await this.loadDeposits(type);
  }

  closeDepositModal(): void {
    this.isDepositModalOpen.set(false);
  }

  closeDepositListModal(): void {
    this.isDepositListModalOpen.set(false);
  }

  async openDepositEditorModal(mode: 'create' | 'edit', deposit?: BillingDepositListItem): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    const type = this.depositModalType();
    this.editingDepositId.set(mode === 'edit' ? (deposit?.id ?? null) : null);

    if (mode === 'create') {
      await this.ensureCurrentUserProfile();
    }

    const now = this.defaultNowDateTimeLocal();
    const occurredAt = mode === 'edit' ? this.toDateTimeLocalValue(deposit?.occurredAt ?? '') || now : now;
    this.depositOccurredAt.set(occurredAt);
    this.depositType.set(type);
    this.depositWizardStep.set(1);
    this.depositTitle.set(mode === 'edit' ? String(deposit?.title ?? '') : (type === 'especes' ? 'Remise d\'especes' : 'Remise de cheques'));
    if (mode === 'edit') {
      this.depositCode.set(String(deposit?.code ?? ''));
      this.depositBankName.set(String(deposit?.bankName ?? ''));
      this.depositAccountLabel.set(String(deposit?.accountLabel ?? ''));
    } else {
      this.applyCreateDepositUserDefaults();
    }
    this.depositNotes.set(mode === 'edit' ? String(deposit?.notes ?? '') : '');
    this.depositAmount.set(mode === 'edit' ? (Number(deposit?.amountCents ?? 0) / 100).toFixed(2) : '0.00');
    this.depositEditorCandidateIds.set(mode === 'edit' ? [...(deposit?.operationIds ?? [])] : []);
    this.depositCandidateSearch.set('');

    this.isDepositEditorModalOpen.set(true);
    if (mode === 'create') {
      await this.loadDepositCandidates(type);
      const eligibleIds = new Set(this.depositCandidates().map((candidate) => candidate.operationId));
      const preselected = this.selectedOperations()
        .filter((operation) => operation.sourceType === 'invoice' && eligibleIds.has(operation.id))
        .map((operation) => operation.id);
      if (preselected.length > 0) {
        this.depositEditorCandidateIds.update((current) => [...new Set([...current, ...preselected])]);
      }
      this.pruneIncompatibleDepositSelections();
      this.syncDepositAmountFromCandidates();
    } else {
      await this.loadDepositCandidates(type, this.editingDepositId());
    }
  }

  closeDepositEditorModal(): void {
    this.isDepositEditorModalOpen.set(false);
    this.depositWizardStep.set(1);
  }

  async openDepositEditorById(depositId: number, depositType: 'cheque' | 'especes'): Promise<void> {
    this.depositModalType.set(depositType);
    const detail = await this.api.getBillingDepositDetail(depositId);
    await this.openDepositEditorModal('edit', detail.deposit);
  }

  goToDepositWizardStep(step: 1 | 2 | 3): void {
    if (this.editingDepositId() != null) {
      return;
    }
    if (step === 2 && !this.canProceedToDepositPointage()) {
      this.errorMessage.set('Renseignez la configuration du bordereau avant le pointage.');
      return;
    }
    if (step === 3 && !this.canProceedToDepositRecap()) {
      this.errorMessage.set('Sélectionnez au moins un paiement avant le récapitulatif.');
      return;
    }
    this.depositWizardStep.set(step);
    this.errorMessage.set('');
  }

  goToNextDepositWizardStep(): void {
    const current = this.depositWizardStep();
    if (current === 1) {
      this.goToDepositWizardStep(2);
      return;
    }
    if (current === 2) {
      this.goToDepositWizardStep(3);
    }
  }

  goToPreviousDepositWizardStep(): void {
    const current = this.depositWizardStep();
    if (current === 3) {
      this.depositWizardStep.set(2);
      return;
    }
    if (current === 2) {
      this.depositWizardStep.set(1);
    }
  }

  applyDepositTemplate(type: 'cheque' | 'especes'): void {
    this.depositType.set(type);
    if (type === 'especes') {
      this.depositTitle.set('Remise d\'especes');
      if (!this.editingDepositId()) {
        this.applyCreateDepositUserDefaults();
      }
      this.pruneIncompatibleDepositSelections();
      this.syncDepositAmountFromCandidates();
      return;
    }

    this.depositTitle.set('Remise de cheques');
    if (!this.editingDepositId()) {
      this.applyCreateDepositUserDefaults();
    }
    this.pruneIncompatibleDepositSelections();
    this.syncDepositAmountFromCandidates();
  }

  onDepositOccurredAtInput(value: string): void {
    const normalized = String(value ?? '');
    this.depositOccurredAt.set(normalized);
    if (this.editingDepositId() == null) {
      this.applyCreateDepositUserDefaults();
    }
  }

  toggleDepositCandidate(operationId: string, checked: boolean): void {
    const candidate = this.depositCandidates().find((item) => item.operationId === operationId);
    if (checked && candidate && !this.isCandidateCompatibleWithDepositType(candidate.paymentMethod, this.depositType())) {
      this.showExportToast('Moyen de paiement incompatible avec ce type de remise.', 'error');
      return;
    }

    const current = this.depositEditorCandidateIds();
    if (checked) {
      if (!current.includes(operationId)) {
        this.depositEditorCandidateIds.set([...current, operationId]);
      }
      this.syncDepositAmountFromCandidates();
      return;
    }
    this.depositEditorCandidateIds.set(current.filter((id) => id !== operationId));
    this.syncDepositAmountFromCandidates();
  }

  toggleDepositGroup(group: DepositCandidateGroup, checked: boolean): void {
    const groupIds = group.invoices.map((inv) => inv.operationId);
    const current = new Set(this.depositEditorCandidateIds());
    
    if (checked) {
      groupIds.forEach((id) => current.add(id));
    } else {
      groupIds.forEach((id) => current.delete(id));
    }
    
    this.depositEditorCandidateIds.set(Array.from(current));
    this.syncDepositAmountFromCandidates();
  }

  toggleSelectAllFilteredDepositCandidates(checked: boolean): void {
    const ids = this.filteredDepositCandidates().map((item) => item.operationId);
    const current = new Set(this.depositEditorCandidateIds());
    if (checked) {
      ids.forEach((id) => current.add(id));
    } else {
      ids.forEach((id) => current.delete(id));
    }
    this.depositEditorCandidateIds.set(Array.from(current));
    this.syncDepositAmountFromCandidates();
  }

  onDepositCandidateSearchInput(value: string): void {
    this.depositCandidateSearch.set(String(value ?? ''));
  }

  async saveDepositEditor(): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    const isEditing = this.editingDepositId() != null;
    if (!isEditing && this.depositEditorCandidateIds().length === 0) {
      this.errorMessage.set('Sélectionnez au moins un paiement à pointer.');
      return;
    }
    if (!isEditing && this.hasIncompatibleSelectedDepositCandidates()) {
      this.errorMessage.set('La selection contient des paiements incompatibles avec le type de remise.');
      return;
    }

    const amount = isEditing
      ? Number(this.depositAmount())
      : Number((this.selectedDepositCandidateAmountCents() / 100).toFixed(2));

    if (!Number.isFinite(amount) || amount <= 0) {
      this.errorMessage.set('Saisissez un montant de remise valide.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const editingId = this.editingDepositId();
      if (editingId) {
        await this.api.updateBillingDeposit(editingId, {
          occurredAt: this.fromDateTimeLocalValue(this.depositOccurredAt()) ?? new Date().toISOString(),
          code: this.depositCode().trim(),
          bankName: this.depositBankName().trim(),
          accountLabel: this.depositAccountLabel().trim(),
          title: this.depositTitle().trim(),
          notes: this.depositNotes().trim(),
          amount,
          operationIds: this.depositEditorCandidateIds()
        });
        this.successMessage.set('Bordereau mis à jour.');
      } else {
        await this.api.createBillingDeposit({
          occurredAt: this.fromDateTimeLocalValue(this.depositOccurredAt()) ?? new Date().toISOString(),
          officeId: this.selectedOfficeId(),
          ownerUserId: this.selectedUserId(),
          type: this.depositModalType(),
          depositCode: this.depositCode().trim(),
          bankName: this.depositBankName().trim(),
          accountLabel: this.depositAccountLabel().trim(),
          amount,
          currency: 'EUR',
          operationIds: this.depositEditorCandidateIds()
        });
        this.successMessage.set('Bordereau enregistre.');
      }

      this.closeDepositEditorModal();
      await this.loadDeposits(this.depositModalType());
      await this.load();
    } catch {
      this.errorMessage.set('Impossible d\'enregistrer le bordereau.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async deleteDeposit(depositId: number): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      await this.api.deleteBillingDeposit(depositId);
      this.successMessage.set('Bordereau supprime.');
      await this.loadDeposits(this.depositModalType());
      await this.load();
    } catch {
      this.errorMessage.set('Impossible de supprimer le bordereau.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async downloadDepositPdf(depositId: number): Promise<void> {
    this.errorMessage.set('');
    try {
      const detail = await this.api.getBillingDepositDetail(depositId);
      const fileName = `bordereau-${detail.deposit.code || detail.deposit.id}.pdf`;
      const JsPdf = await this.loadJsPdf();
      const pdf = this.buildDepositPdf(detail, JsPdf);
      pdf.save(fileName);
    } catch {
      this.errorMessage.set('Impossible de générer le PDF du bordereau.');
    }
  }

  async saveDeposit(): Promise<void> {
    await this.saveDepositEditor();
  }

  private async loadDeposits(type: 'cheque' | 'especes'): Promise<void> {
    this.isLoadingDeposits.set(true);
    try {
      const rows = await this.api.getBillingDeposits(type, this.selectedOfficeId());
      this.deposits.set(rows);
    } catch {
      this.errorMessage.set('Impossible de charger la liste des remises.');
    } finally {
      this.isLoadingDeposits.set(false);
    }
  }

  private async loadDepositCandidates(type: 'cheque' | 'especes', currentDepositId?: number | null): Promise<void> {
    this.isLoadingDepositCandidates.set(true);
    try {
      const rows = await this.api.getBillingDepositCandidates(type, this.selectedOfficeId(), currentDepositId);
      this.depositCandidates.set(rows);
    } catch {
      this.errorMessage.set('Impossible de charger les paiements eligibles.');
    } finally {
      this.isLoadingDepositCandidates.set(false);
    }
  }

  private syncDepositAmountFromCandidates(): void {
    if (this.editingDepositId() != null) {
      return;
    }
    const amount = this.selectedDepositCandidateAmountCents() / 100;
    this.depositAmount.set(amount.toFixed(2));
  }

  private pruneIncompatibleDepositSelections(): void {
    const type = this.depositType();
    const allowedIds = new Set(
      this.depositCandidates()
        .filter((item) => this.isCandidateCompatibleWithDepositType(item.paymentMethod, type))
        .map((item) => item.operationId)
    );

    const next = this.depositEditorCandidateIds().filter((id) => allowedIds.has(id));
    if (next.length !== this.depositEditorCandidateIds().length) {
      this.depositEditorCandidateIds.set(next);
    }
  }

  private isCandidateCompatibleWithDepositType(paymentMethod: string, type: 'cheque' | 'especes'): boolean {
    const normalized = this.normalizePaymentMethod(paymentMethod);
    if (!normalized) {
      return false;
    }

    if (type === 'cheque') {
      return normalized.includes('cheque') || normalized.includes('chq') || normalized.includes('check');
    }

    return normalized.includes('espece') || normalized.includes('cash') || normalized.includes('liquide');
  }

  private normalizePaymentMethod(value: string): string {
    const source = String(value ?? '').toLowerCase().trim();
    if (!source) {
      return '';
    }
    return source
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private toDateTimeLocalValue(value: string): string {
    const date = new Date(String(value ?? '').trim());
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

  private async loadJsPdf(): Promise<typeof import('jspdf').jsPDF> {
    const module = await import('jspdf');
    return module.jsPDF;
  }

  private buildDepositPdf(detail: BillingDepositDetail, JsPdf: typeof import('jspdf').jsPDF) {
    const pdf = new JsPdf({ unit: 'mm', format: 'a4' });
    const margin = 14;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    const writeLine = (text: string, fontSize = 10, spacing = 5, bold = false): void => {
      const normalized = String(text ?? '').trim();
      if (!normalized) {
        return;
      }
      pdf.setFont('helvetica', bold ? 'bold' : 'normal');
      pdf.setFontSize(fontSize);
      const lines = pdf.splitTextToSize(normalized, contentWidth) as string[];
      pdf.text(lines, margin, y);
      y += lines.length * spacing;
    };

    writeLine(detail.office.name || 'Cabinet', 14, 6, true);
    writeLine([detail.office.address1, detail.office.address2].filter(Boolean).join(' - '), 10, 5);
    writeLine(`${detail.office.postalCode} ${detail.office.city} ${detail.office.country}`.trim(), 10, 5);
    writeLine([detail.office.phone, detail.office.email].filter(Boolean).join(' - '), 10, 6);

    y += 3;
    pdf.setDrawColor(210, 219, 230);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 7;

    writeLine(`Bordereau ${detail.deposit.type === 'especes' ? 'd\'especes' : 'de cheques'}`, 13, 6, true);
    writeLine(`Code: ${detail.deposit.code || '-'}   Date: ${this.formatDateTime(detail.deposit.occurredAt)}`);
    writeLine(`Banque: ${detail.deposit.bankName || '-'}   Compte: ${detail.deposit.accountLabel || '-'}`);
    writeLine(`Montant: ${this.formatCurrency(detail.deposit.amountCents, detail.deposit.currency)}`, 10, 6, true);

    pdf.setFont('helvetica', 'bold');
    pdf.text('Consultations / paiements rattaches', margin, y);
    y += 6;

    for (const item of detail.items) {
      const line = `${this.formatDateTime(item.occurredAt)} | ${item.invoiceNumber || '-'} | ${item.patientName} | ${this.formatCurrency(item.amountCents, item.currency)}`;
      writeLine(line, 9, 4.5);
      if (y > 280) {
        pdf.addPage();
        y = margin;
      }
    }

    return pdf;
  }

  async applyBulkUpdate(): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    if (this.selectedOperationIds().length === 0) {
      this.errorMessage.set('Sélectionnez au moins une opération.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const retroPercent = this.bulkRetrocessionPercent().trim();
      await this.api.bulkUpdateBillingOperations({
        operationIds: this.selectedOperationIds(),
        ownerUserId: this.bulkOwnerUserId(),
        retrocessionPercent: retroPercent.length > 0 ? Number(retroPercent) : null,
        retrocessionRecipient: this.bulkRetrocessionRecipient().trim() || null
      });
      this.successMessage.set('Opérations mises à jour.');
      this.closeConsultationSelectionModal();
      await this.load();
    } catch {
      this.errorMessage.set('Impossible de mettre à jour les opérations.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async deleteSelectedOperations(): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    if (this.selectedOperationIds().length === 0) {
      this.errorMessage.set('Sélectionnez au moins une opération.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      await this.api.bulkUpdateBillingOperations({
        operationIds: this.selectedOperationIds(),
        delete: true
      });
      this.successMessage.set('Opérations supprimées.');
      this.selectedOperationIds.set([]);
      await this.load();
    } catch {
      this.errorMessage.set('Impossible de supprimer les opérations.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async applyPrototypeGroupedPayment(): Promise<void> {
    if (!this.canManageBilling()) {
      this.errorMessage.set('Vous ne disposez pas du droit de modifier la comptabilité.');
      return;
    }

    if (!this.canRunPrototypeGroupedPayment()) {
      this.errorMessage.set('Renseignez un paiement valide et sélectionnez des consultations impayées.');
      return;
    }

    const amountCents = Math.round(Number(this.prototypePaymentAmount()) * 100);
    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const result = await this.api.createGroupedInvoicePayment({
        invoiceIds: this.selectedUnpaidInvoiceIds(),
        payment: {
          paidAt: this.fromDateTimeLocalValue(this.prototypePaymentOccurredAt()) ?? new Date().toISOString(),
          amountCents,
          currency: 'EUR',
          paymentMethod: this.prototypePaymentMethod().trim(),
          bankName: this.prototypePaymentBankName().trim(),
          chequeNumber: this.prototypePaymentChequeNumber().trim(),
          reference: this.prototypePaymentReference().trim(),
          notes: this.prototypePaymentNotes().trim()
        }
      });

      this.successMessage.set(
        `Paiement ajoute: ${(result.allocatedAmountCents / 100).toFixed(2)} EUR repartis sur ${result.allocations.length} consultation(s).`
      );
      this.closeConsultationSelectionModal();
      await this.load();
    } catch {
      this.errorMessage.set('Impossible d\'appliquer le paiement groupé.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async exportOperations(format: 'json' | 'excel', mode: 'standard' | 'analytical' = 'standard'): Promise<void> {
    this.closeActionMenus();
    if (!this.canExportBilling()) {
      this.errorMessage.set('Vous n\'avez pas le droit d\'exporter la comptabilité.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const blob = await this.api.exportBillingOperations(format, {
        ...this.buildFilters(),
        mode
      });
      const extension = format === 'json' ? 'json' : 'csv';
      const fileName = `comptabilite-${mode}-${new Date().toISOString().slice(0, 10)}.${extension}`;
      this.downloadBlob(blob, fileName);
      this.successMessage.set('Export terminé.');
    } catch {
      this.errorMessage.set('Impossible d\'exporter la comptabilité.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async exportAlertsCsv(): Promise<void> {
    // removed
  }

  async exportAlertsJson(): Promise<void> {
    // removed
  }

  async exportSnapshotPack(format: 'json' | 'excel'): Promise<void> {
    this.closeActionMenus();
    if (!this.canExportBilling()) {
      this.errorMessage.set('Vous n\'avez pas le droit d\'exporter la comptabilité.');
      this.showExportToast('Export non autorise.', 'error');
      return;
    }
    if (this.isSnapshotExporting()) {
      this.errorMessage.set('Un pack export est déjà en cours.');
      this.showExportToast('Un pack est déjà en cours.', 'error');
      return;
    }

    const createdAt = new Date().toISOString();
    const sessionId = this.buildExportSessionId();
    const label = `Pack ${format === 'json' ? 'JSON' : 'CSV'}`;

    this.isSnapshotExporting.set(true);
    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const blob = await this.api.exportBillingOperations(format, {
        ...this.buildFilters(),
        mode: 'analytical'
      });

      const extension = format === 'json' ? 'json' : 'csv';
      const datePart = new Date().toISOString().slice(0, 10);
      this.downloadBlob(blob, `snapshot-comptabilite-analytical-${datePart}-${sessionId}.${extension}`);
      this.successMessage.set(`Pack export téléchargé (${label.toLowerCase()}).`);
      this.showExportToast('Pack export terminé.', 'success');
      this.pushExportHistory({
        id: `${createdAt}-success-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        label,
        operationsFormat: format,
        status: 'success',
        createdAt
      });
    } catch {
      this.errorMessage.set('Impossible d\'exporter le pack.');
      this.showExportToast('Échec du pack export.', 'error');
      this.pushExportHistory({
        id: `${createdAt}-error-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        label,
        operationsFormat: format,
        status: 'error',
        createdAt
      });
    } finally {
      this.isSnapshotExporting.set(false);
      this.isSaving.set(false);
    }
  }

  async exportSnapshotPackMixed(): Promise<void> {
    // removed - alerts no longer available
  }

  onDebtorSearchInput(value: string): void {
    this.debtorSearch.set(String(value ?? ''));
    this.debtorPage.set(1);
  }

  setDebtorSort(sortBy: 'name' | 'invoices' | 'outstanding'): void {
    if (this.debtorSort() === sortBy) {
      this.debtorSortDirection.set(this.debtorSortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.debtorSort.set(sortBy);
      this.debtorSortDirection.set(sortBy === 'name' ? 'asc' : 'desc');
    }
    this.debtorPage.set(1);
  }

  previousDebtorPage(): void {
    this.debtorPage.set(Math.max(1, this.debtorPage() - 1));
  }

  nextDebtorPage(): void {
    this.debtorPage.set(Math.min(this.debtorTotalPages(), this.debtorPage() + 1));
  }

  debtorSortIcon(sortBy: 'name' | 'invoices' | 'outstanding'): string {
    if (this.debtorSort() !== sortBy) {
      return 'fa-sort';
    }
    return this.debtorSortDirection() === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
  }

  formatDateTime(value: string): string {
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

  formatCurrency(cents: number, currency = 'EUR'): string {
    return `${(Number(cents ?? 0) / 100).toFixed(2)} ${currency}`;
  }

  formatPercent(value: number): string {
    const normalized = Number.isFinite(value) ? value : 0;
    return `${normalized >= 0 ? '+' : ''}${normalized.toFixed(2)}%`;
  }

  operationPaymentLabel(operation: BillingOperation): string {
    if (operation.paymentRef.type === 'patient') {
      return 'Fiche patient';
    }
    if (operation.paymentRef.type === 'expense') {
      return `Depense #${operation.paymentRef.expenseId}`;
    }
    return `Remise #${operation.paymentRef.depositId}`;
  }

  private async load(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const filters = this.buildFilters();
      const [operationsResult, insightsResult, forecastResult] = await Promise.allSettled([
        this.api.getBillingOperations(filters),
        this.api.getBillingInsights({
          from: filters.from,
          to: filters.to,
          officeId: filters.officeId
        }),
        this.api.getBillingForecast(filters.officeId)
      ]);

      if (operationsResult.status === 'fulfilled') {
        this.applyPayload(operationsResult.value);
      } else {
        throw operationsResult.reason;
      }

      this.billingInsights.set(insightsResult.status === 'fulfilled' ? insightsResult.value : null);
      this.billingForecast.set(forecastResult.status === 'fulfilled' ? forecastResult.value : null);
    } catch {
      this.errorMessage.set('Impossible de charger les operations comptables.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private pushExportHistory(item: ExportHistoryItem): void {
    const next = [item, ...this.exportHistory()].slice(0, 100);
    this.exportHistory.set(next);
    this.persistExportHistory(next);
  }

  setExportHistoryFilter(filter: 'all' | 'success' | 'error'): void {
    this.exportHistoryFilter.set(filter);
    this.exportHistoryPage.set(1);
  }

  setExportHistoryFormatFilter(format: 'all' | 'json' | 'excel'): void {
    this.exportHistoryFormatFilter.set(format);
    this.exportHistoryPage.set(1);
  }

  setExportHistorySort(sort: 'date-desc' | 'date-asc' | 'status' | 'relevance'): void {
    this.exportHistorySort.set(sort);
    this.exportHistoryPage.set(1);
  }

  onExportHistorySearchInput(value: string): void {
    this.exportHistorySearch.set(String(value ?? ''));
    this.exportHistoryPage.set(1);
  }

  goToExportHistoryPage(page: number): void {
    const total = this.totalExportHistoryPages();
    if (page >= 1 && page <= total) {
      this.exportHistoryPage.set(page);
    }
  }

  nextExportHistoryPage(): void {
    const current = this.exportHistoryPage();
    const total = this.totalExportHistoryPages();
    if (current < total) {
      this.exportHistoryPage.set(current + 1);
    }
  }

  prevExportHistoryPage(): void {
    const current = this.exportHistoryPage();
    if (current > 1) {
      this.exportHistoryPage.set(current - 1);
    }
  }

  clearExportHistory(): void {
    this.exportHistory.set([]);
    this.persistExportHistory([]);
  }

  cleanupOldExportHistory(): void {
    const current = this.exportHistory();
    const cleaned = this.cleanupExpiredExportHistory(current);
    const removed = current.length - cleaned.length;
    
    if (removed > 0) {
      this.exportHistory.set(cleaned);
      this.persistExportHistory(cleaned);
      this.showExportToast(`${removed} ancien(s) export(s) supprime(s).`, 'success');
    } else {
      this.showExportToast('Aucun export ancien à nettoyer.', 'success');
    }
  }

  async copyExportSessionId(sessionId: string): Promise<void> {
    const normalized = String(sessionId ?? '').trim();
    if (!normalized) {
      this.showExportToast('Session invalide.', 'error');
      return;
    }

    try {
      await navigator.clipboard.writeText(normalized);
      this.showExportToast(`Session ${normalized} copiée.`, 'success');
    } catch {
      this.showExportToast('Impossible de copier la session.', 'error');
    }
  }

  toggleExportIdSelection(id: string): void {
    const next = new Set(this.selectedExportIds());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.selectedExportIds.set(next);
  }

  selectAllVisibleExportIds(): void {
    const visible = this.visibleExportIds();
    const next = new Set(this.selectedExportIds());
    visible.forEach((id) => next.add(id));
    this.selectedExportIds.set(next);
  }

  deselectAllVisibleExportIds(): void {
    const visible = this.visibleExportIds();
    const next = new Set(this.selectedExportIds());
    visible.forEach((id) => next.delete(id));
    this.selectedExportIds.set(next);
  }

  async copySelectedExportSessionIds(): Promise<void> {
    const selected = this.selectedExportIds();
    if (selected.size === 0) {
      this.showExportToast('Aucun export sélectionné.', 'error');
      return;
    }

    const allExports = this.exportHistory();
    const sessionIds = Array.from(selected)
      .map((id) => allExports.find((item) => item.id === id))
      .filter((item) => item != null)
      .map((item) => item!.sessionId)
      .join('\n');

    try {
      await navigator.clipboard.writeText(sessionIds);
      this.showExportToast(`${selected.size} session(s) copiée(s).`, 'success');
    } catch {
      this.showExportToast('Impossible de copier les sessions.', 'error');
    }
  }

  showDeleteExportConfirm(): void {
    const count = this.selectedExportIds().size;
    if (count === 0) {
      this.showExportToast('Aucun export sélectionné.', 'error');
      return;
    }
    this.deleteExportConfirmCount.set(count);
    this.isDeleteExportConfirmVisible.set(true);
  }

  cancelDeleteExportConfirm(): void {
    this.isDeleteExportConfirmVisible.set(false);
    this.deleteExportConfirmCount.set(0);
  }

  confirmDeleteSelectedExports(): void {
    const selected = this.selectedExportIds();
    if (selected.size === 0) {
      this.cancelDeleteExportConfirm();
      return;
    }

    const allExports = this.exportHistory();
    const toDelete = allExports.filter((item) => selected.has(item.id));
    const remaining = allExports.filter((item) => !selected.has(item.id));
    const removed = toDelete.length;

    const now = new Date().toISOString();
    const trashItems = toDelete.map((item) => ({
      ...item,
      deletedAt: now
    }));
    const currentTrash = this.exportTrash();
    this.exportTrash.set([...trashItems, ...currentTrash]);
    this.persistExportTrash([...trashItems, ...currentTrash]);

    this.exportHistory.set(remaining);
    this.persistExportHistory(remaining);
    this.selectedExportIds.set(new Set());
    this.cancelDeleteExportConfirm();
    this.showExportToast(`${removed} export(s) dans la corbeille. Récupérables pendant 7 jours.`, 'success');
  }

  toggleExportTrash(): void {
    this.showExportTrash.set(!this.showExportTrash());
  }

  showTrashActionConfirm(action: 'restore-all' | 'empty'): void {
    if (this.activeExportTrash().length === 0) {
      this.showExportToast('Aucun export dans la corbeille.', 'error');
      return;
    }
    this.trashActionType.set(action);
    this.isTrashActionConfirmVisible.set(true);
  }

  cancelTrashActionConfirm(): void {
    this.isTrashActionConfirmVisible.set(false);
    this.trashActionType.set(null);
  }

  confirmTrashAction(): void {
    const action = this.trashActionType();
    this.cancelTrashActionConfirm();
    if (action === 'restore-all') {
      this.restoreAllFromTrashNow();
      return;
    }
    if (action === 'empty') {
      this.emptyTrashNow();
    }
  }

  restoreFromTrash(trashItem: TrashExportItem): void {
    const restored: ExportHistoryItem = {
      id: trashItem.id,
      sessionId: trashItem.sessionId,
      label: trashItem.label,
      operationsFormat: trashItem.operationsFormat,
      status: trashItem.status,
      createdAt: trashItem.createdAt
    };

    const currentHistory = this.exportHistory();
    this.exportHistory.set([restored, ...currentHistory]);
    this.persistExportHistory([restored, ...currentHistory]);

    const currentTrash = this.exportTrash();
    const filtered = currentTrash.filter((item) => item.id !== trashItem.id);
    this.exportTrash.set(filtered);
    this.persistExportTrash(filtered);

    this.showExportToast('1 export restaure de la corbeille.', 'success');
  }

  restoreAllFromTrash(): void {
    this.showTrashActionConfirm('restore-all');
  }

  emptyTrash(): void {
    this.showTrashActionConfirm('empty');
  }

  private restoreAllFromTrashNow(): void {
    const trash = this.activeExportTrash();
    if (trash.length === 0) {
      this.showExportToast('Aucun export dans la corbeille.', 'error');
      return;
    }

    const restored = trash.map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      label: item.label,
      operationsFormat: item.operationsFormat,
      status: item.status,
      createdAt: item.createdAt
    }));

    const currentHistory = this.exportHistory();
    this.exportHistory.set([...restored, ...currentHistory]);
    this.persistExportHistory([...restored, ...currentHistory]);

    this.exportTrash.set([]);
    this.persistExportTrash([]);

    this.showExportToast(`${trash.length} export(s) restaure(s) de la corbeille.`, 'success');
  }

  private emptyTrashNow(): void {
    this.exportTrash.set([]);
    this.persistExportTrash([]);
    this.showExportToast('Corbeille vidée définitivement.', 'success');
  }

  private calculateRelevanceScore(item: ExportHistoryItem, query: string): number {
    const label = String(item.label ?? '').toLowerCase();
    const sessionId = String(item.sessionId ?? '').toLowerCase();

    if (sessionId.startsWith(query)) {
      return 50;
    }
    if (label.startsWith(query)) {
      return 40;
    }

    const labelWords = label.split(/\s+/);
    for (const word of labelWords) {
      if (word.startsWith(query)) {
        return 30;
      }
    }

    if (sessionId.includes(query)) {
      return 20;
    }
    if (label.includes(query)) {
      return 10;
    }

    return 0;
  }

  exportHistoryCsv(): void {
    const rows = this.searchedExportHistory();
    if (rows.length === 0) {
      this.showExportToast('Aucun élément à exporter.', 'error');
      return;
    }

    const header = ['Date', 'SessionId', 'Label', 'OperationsFormat', 'Status'];
    const csvRows = rows.map((item) => [
      item.createdAt,
      item.sessionId,
      item.label,
      item.operationsFormat,
      item.status
    ]);
    const csv = [header, ...csvRows]
      .map((line) => line.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';'))
      .join('\n');

    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    this.downloadBlob(blob, `export-history-${new Date().toISOString().slice(0, 10)}.csv`);
    this.showExportToast(`${rows.length} export(s) en CSV.`, 'success');
  }

  exportHistoryJson(): void {
    const rows = this.searchedExportHistory();
    if (rows.length === 0) {
      this.showExportToast('Aucun élément à exporter.', 'error');
      return;
    }

    const payload = rows.map((item) => ({
      createdAt: item.createdAt,
      sessionId: item.sessionId,
      label: item.label,
      operationsFormat: item.operationsFormat,
      status: item.status
    }));

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    this.downloadBlob(blob, `export-history-${new Date().toISOString().slice(0, 10)}.json`);
    this.showExportToast(`${rows.length} export(s) en JSON.`, 'success');
  }

  exportSelectedHistoryCsv(): void {
    const selected = this.selectedExportIds();
    if (selected.size === 0) {
      this.showExportToast('Aucun élément sélectionné.', 'error');
      return;
    }

    const rows = this.searchedExportHistory().filter((item) => selected.has(item.id));
    if (rows.length === 0) {
      this.showExportToast('Aucun élément à exporter.', 'error');
      return;
    }

    const header = ['Date', 'SessionId', 'Label', 'OperationsFormat', 'Status'];
    const csvRows = rows.map((item) => [
      item.createdAt,
      item.sessionId,
      item.label,
      item.operationsFormat,
      item.status
    ]);
    const csv = [header, ...csvRows]
      .map((line) => line.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';'))
      .join('\n');

    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    this.downloadBlob(blob, `export-history-selected-${new Date().toISOString().slice(0, 10)}.csv`);
    this.showExportToast(`${rows.length} export(s) sélectionné(s) en CSV.`, 'success');
  }

  exportSelectedHistoryJson(): void {
    const selected = this.selectedExportIds();
    if (selected.size === 0) {
      this.showExportToast('Aucun élément sélectionné.', 'error');
      return;
    }

    const rows = this.searchedExportHistory().filter((item) => selected.has(item.id));
    if (rows.length === 0) {
      this.showExportToast('Aucun élément à exporter.', 'error');
      return;
    }

    const payload = rows.map((item) => ({
      createdAt: item.createdAt,
      sessionId: item.sessionId,
      label: item.label,
      operationsFormat: item.operationsFormat,
      status: item.status
    }));

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    this.downloadBlob(blob, `export-history-selected-${new Date().toISOString().slice(0, 10)}.json`);
    this.showExportToast(`${rows.length} export(s) sélectionné(s) en JSON.`, 'success');
  }

  private showExportToast(message: string, type: 'success' | 'error'): void {
    this.exportToastMessage.set(message);
    this.exportToastType.set(type);
    this.isExportToastVisible.set(true);

    if (this.exportToastTimeout != null) {
      clearTimeout(this.exportToastTimeout);
      this.exportToastTimeout = null;
    }

    this.exportToastTimeout = setTimeout(() => {
      this.isExportToastVisible.set(false);
      this.exportToastTimeout = null;
    }, 3000);
  }

  private persistExportHistory(items: ExportHistoryItem[]): void {
    try {
      localStorage.setItem(BillingPage.EXPORT_HISTORY_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Ignore storage failures.
    }
  }

  private restoreExportHistory(): void {
    try {
      const raw = localStorage.getItem(BillingPage.EXPORT_HISTORY_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as ExportHistoryItem[];
      if (!Array.isArray(parsed)) {
        return;
      }
      const sanitized: ExportHistoryItem[] = parsed
        .filter((item) => item && typeof item === 'object')
        .slice(0, 100)
        .map((item) => ({
          id: String(item.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          sessionId: String(item.sessionId ?? this.buildExportSessionId()),
          label: String(item.label ?? 'Pack export'),
          operationsFormat: item.operationsFormat === 'json' ? 'json' as const : 'excel' as const,
          status: item.status === 'error' ? 'error' as const : 'success' as const,
          createdAt: String(item.createdAt ?? new Date().toISOString())
        }));
      
      const cleaned = this.cleanupExpiredExportHistory(sanitized);
      this.exportHistory.set(cleaned);
    } catch {
      this.exportHistory.set([]);
    }
  }

  private buildExportSessionId(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  private cleanupExpiredExportHistory(items: ExportHistoryItem[]): ExportHistoryItem[] {
    const now = new Date();
    const expirationMs = BillingPage.EXPORT_HISTORY_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
    
    return items.filter((item) => {
      try {
        const createdTime = new Date(item.createdAt).getTime();
        return now.getTime() - createdTime < expirationMs;
      } catch {
        return false;
      }
    });
  }

  private persistExportTrash(items: TrashExportItem[]): void {
    try {
      localStorage.setItem(this.EXPORT_TRASH_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Ignore storage failures.
    }
  }

  private restoreExportTrash(): void {
    try {
      const raw = localStorage.getItem(this.EXPORT_TRASH_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as TrashExportItem[];
      if (!Array.isArray(parsed)) {
        return;
      }
      const sanitized: TrashExportItem[] = parsed
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: String(item.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          sessionId: String(item.sessionId ?? this.buildExportSessionId()),
          label: String(item.label ?? 'Pack export'),
          operationsFormat: item.operationsFormat === 'json' ? 'json' as const : 'excel' as const,
          status: item.status === 'error' ? 'error' as const : 'success' as const,
          createdAt: String(item.createdAt ?? new Date().toISOString()),
          deletedAt: String(item.deletedAt ?? new Date().toISOString())
        }));

      const now = new Date();
      const expirationMs = this.EXPORT_TRASH_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
      const active = sanitized.filter((item) => {
        try {
          const deletedTime = new Date(item.deletedAt).getTime();
          return now.getTime() - deletedTime < expirationMs;
        } catch {
          return false;
        }
      });

      this.exportTrash.set(active);
    } catch {
      this.exportTrash.set([]);
    }
  }

  private applyPayload(payload: BillingOperationsPayload): void {
    this.closeActionMenus();
    this.tiles.set(payload.summary ?? []);
    this.operations.set((payload.operations ?? []).filter((op) => op.sourceType === 'invoice'));
    this.offices.set(payload.offices ?? []);
    this.users.set(payload.users ?? []);

    const officeIds = new Set((payload.offices ?? []).map((office) => office.id));
    if (this.selectedOfficeId() != null && !officeIds.has(this.selectedOfficeId()!)) {
      this.selectedOfficeId.set(null);
    }

    const userIds = new Set((payload.users ?? []).map((user) => user.id));
    if (this.selectedUserId() != null && !userIds.has(this.selectedUserId()!)) {
      this.selectedUserId.set(null);
    }

    this.selectedOperationIds.set([]);
  }

  private buildFilters(): { from: string; to: string; officeId: number | null; userId: number | null } {
    return {
      from: this.fromDate(),
      to: this.toDate(),
      officeId: this.selectedOfficeId(),
      userId: this.selectedUserId()
    };
  }

  private toDateInputValue(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async ensureCurrentUserProfile(): Promise<MyUserProfile | null> {
    const existing = this.currentUserProfile();
    if (existing) {
      return existing;
    }

    try {
      const profile = await this.api.getMyUserProfile();
      this.currentUserProfile.set(profile);
      return profile;
    } catch {
      return null;
    }
  }

  private applyCreateDepositUserDefaults(): void {
    if (this.editingDepositId() != null) {
      return;
    }

    const profile = this.currentUserProfile();
    const bankName = String(profile?.bankName ?? '').trim();
    const iban = String(profile?.iban ?? '').trim();
    const code = this.buildCreateDepositCode(profile, this.depositOccurredAt());

    this.depositCode.set(code);
    this.depositBankName.set(bankName);
    this.depositAccountLabel.set(iban);
  }

  private buildCreateDepositCode(profile: MyUserProfile | null, occurredAtLocal: string): string {
    const trigram = this.buildUserTrigram(profile);
    const dayToken = this.formatDepositDateToken(occurredAtLocal);
    return `${trigram}-${dayToken}`;
  }

  private buildUserTrigram(profile: MyUserProfile | null): string {
    const seed = [
      String(profile?.lastName ?? ''),
      String(profile?.firstName ?? ''),
      this.authService.username()
    ]
      .join('')
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]/g, '');

    if (seed.length >= 3) {
      return seed.slice(0, 3);
    }

    if (seed.length === 2) {
      return `${seed}X`;
    }

    if (seed.length === 1) {
      return `${seed}XX`;
    }

    return 'USR';
  }

  private formatDepositDateToken(localDateTimeValue: string): string {
    const date = new Date(String(localDateTimeValue ?? '').trim());
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const yyyy = String(safeDate.getFullYear());
    const mm = String(safeDate.getMonth() + 1).padStart(2, '0');
    const dd = String(safeDate.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  private defaultNowDateTimeLocal(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private fromDateTimeLocalValue(value: string): string | null {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      return null;
    }

    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  private createDefaultInvoiceTemplateLayout(): InvoiceTemplateLayout {
    const block = (x: number, y: number, w: number): InvoiceTemplateBlockLayout => ({
      x, y, w, visible: true, fontSize: 10, color: '#000000', borderStyle: 'none'
    });
    return {
      logo: block(4, 4, 24),
      practitioner: block(30, 4, 32),
      patient: block(64, 4, 32),
      invoiceMeta: block(64, 20, 32),
      lineItems: block(4, 32, 92),
      totals: block(56, 74, 40),
      payment: block(4, 74, 50),
      mentions: block(4, 86, 92),
      signature: block(60, 92, 36),
      _global: { primaryColor: '#4d92d1', fontFamily: 'helvetica', showPageNumber: false, footerText: '' }
    };
  }

  private parseInvoiceTemplateLayout(rawValue: string | undefined | null): InvoiceTemplateLayout {
    const fallback = this.createDefaultInvoiceTemplateLayout();
    if (!rawValue || !String(rawValue).trim()) return fallback;
    try {
      const parsed = JSON.parse(rawValue) as Partial<Record<string, unknown>>;
      const next: InvoiceTemplateLayout = this.createDefaultInvoiceTemplateLayout();
      for (const option of this.invoiceTemplateBlockOptions) {
        const candidate = parsed?.[option.key] as Partial<InvoiceTemplateBlockLayout> | undefined;
        if (!candidate || typeof candidate !== 'object') continue;
        const fallbackBlock = fallback[option.key];
        next[option.key] = {
          x: this.clampTemplateValue('x', Number(candidate.x)),
          y: this.clampTemplateValue('y', Number(candidate.y)),
          w: this.clampTemplateValue('w', Number(candidate.w)),
          visible: candidate.visible !== false,
          fontSize: this.clampTemplateValue('fontSize', Number(candidate.fontSize) || fallbackBlock.fontSize),
          color: typeof candidate.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate.color) ? candidate.color : '#000000',
          borderStyle: (['none', 'line', 'box'] as const).includes(candidate.borderStyle as 'none')
            ? candidate.borderStyle as 'none' | 'line' | 'box' : 'none',
          ...(typeof candidate.customLabel === 'string' ? { customLabel: candidate.customLabel.slice(0, 80) } : {}),
          ...(typeof candidate.content === 'string' ? { content: candidate.content.slice(0, 5000) } : {})
        };
        if (next[option.key].x + next[option.key].w > 100) {
          next[option.key].x = Math.max(0, 100 - next[option.key].w);
        }
      }
      const globalCandidate = parsed?.['_global'] as Partial<InvoiceTemplateGlobalSettings> | undefined;
      if (globalCandidate && typeof globalCandidate === 'object') {
        next._global = {
          primaryColor: typeof globalCandidate.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(globalCandidate.primaryColor)
            ? globalCandidate.primaryColor : '#4d92d1',
          fontFamily: (['helvetica', 'courier', 'times'] as const).includes(globalCandidate.fontFamily as 'helvetica')
            ? globalCandidate.fontFamily as 'helvetica' | 'courier' | 'times' : 'helvetica',
          showPageNumber: Boolean(globalCandidate.showPageNumber),
          footerText: String(globalCandidate.footerText ?? '').slice(0, 200)
        };
      }
      return next;
    } catch {
      return fallback;
    }
  }

  private clampTemplateValue(field: 'x' | 'y' | 'w' | 'fontSize', value: number): number {
    if (field === 'fontSize') {
      return !Number.isFinite(value) ? 10 : Math.min(14, Math.max(9, Math.round(value)));
    }
    const min = field === 'w' ? 20 : 0;
    const max = 96;
    return !Number.isFinite(value) ? (field === 'w' ? 24 : 0) : Math.min(max, Math.max(min, Math.round(value)));
  }

  private toInvoiceTemplateBlockId(raw: string): InvoiceTemplateBlockId | null {
    const normalized = String(raw ?? '').trim();
    return this.invoiceTemplateBlockOptions.some((b) => b.key === normalized)
      ? normalized as InvoiceTemplateBlockId
      : null;
  }

  invoiceTemplateBlockSampleContent(blockId: InvoiceTemplateBlockId): string {
    const map: Record<InvoiceTemplateBlockId, string> = {
      logo: '[ Logo cabinet ]',
      practitioner: 'Dr. Martin Dupont\n12 rue des Ostéopathes\n75001 Paris\nRPPS: 10001234567',
      patient: 'Mme. Sophie Lefort\n5 av. du Parc\n69000 Lyon\nNN: 2 85 12 69 001 012 34',
      invoiceMeta: 'Facture N° DEMO-001\nDate: 01/01/2025\nÉchéance: 01/01/2025',
      lineItems: 'Consultation ostéopathique  1  60,00 €\nBilan postural              1  20,00 €',
      totals: 'Total HT: 80,00 €\nTVA (0%): 0,00 €\nTotal TTC: 80,00 €',
      payment: 'Payé par CB\nDate: 01/01/2025\nMontant: 80,00 €',
      mentions: 'Non remboursé par la Sécurité Sociale.\nConservez ce document à des fins fiscales.',
      signature: '____________________\nSignature'
    };
    return map[blockId] ?? blockId;
  }

  private buildSampleInvoicePdf(layout: InvoiceTemplateLayout, JsPdf: typeof import('jspdf').jsPDF) {
    const PAGE_W = 210;
    const PAGE_H = 297;
    const pdf = new JsPdf({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const fontFamily = layout._global.fontFamily;
    const primaryHex = layout._global.primaryColor;
    const pr = parseInt(primaryHex.slice(1, 3), 16);
    const pg = parseInt(primaryHex.slice(3, 5), 16);
    const pb = parseInt(primaryHex.slice(5, 7), 16);
    const blockOrder = this.invoiceTemplateBlockOptions
      .filter((opt) => layout[opt.key].visible)
      .sort((a, b) => layout[a.key].y - layout[b.key].y);
    for (const opt of blockOrder) {
      const block = layout[opt.key];
      const x = (block.x / 100) * PAGE_W;
      const y = (block.y / 100) * PAGE_H;
      const w = (block.w / 100) * PAGE_W;
      const cr = parseInt(block.color.slice(1, 3), 16);
      const cg = parseInt(block.color.slice(3, 5), 16);
      const cb = parseInt(block.color.slice(5, 7), 16);
      pdf.setFont(fontFamily, 'normal');
      pdf.setFontSize(block.fontSize);
      pdf.setTextColor(cr, cg, cb);
      if (block.borderStyle === 'line') {
        pdf.setDrawColor(pr, pg, pb);
        pdf.line(x, y - 1, x + w, y - 1);
      } else if (block.borderStyle === 'box') {
        pdf.setDrawColor(pr, pg, pb);
        pdf.rect(x, y - 1, w, block.fontSize * 0.5 + 3);
      }
      if (block.customLabel) {
        pdf.setFont(fontFamily, 'bold');
        pdf.setFontSize(block.fontSize - 1);
        pdf.text(block.customLabel, x, y);
        pdf.setFont(fontFamily, 'normal');
        pdf.setFontSize(block.fontSize);
      }
      const contentText = block.content || this.invoiceTemplateBlockSampleContent(opt.key);
      const lines = pdf.splitTextToSize(contentText, w) as string[];
      const textY = block.customLabel ? y + block.fontSize * 0.4 : y;
      pdf.text(lines, x, textY);
    }
    if (layout._global.footerText) {
      pdf.setFont(fontFamily, 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(120, 120, 120);
      const footerLines = pdf.splitTextToSize(layout._global.footerText, PAGE_W - 28) as string[];
      pdf.text(footerLines, 14, PAGE_H - 8);
    }
    if (layout._global.showPageNumber) {
      pdf.setFont(fontFamily, 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(120, 120, 120);
      pdf.text('Page 1 / 1', PAGE_W - 25, PAGE_H - 5);
    }
    return pdf;
  }

  private buildInvoicePdf(
    invoice: BillingInvoiceDetail,
    office: Office | null,
    layout: InvoiceTemplateLayout,
    JsPdf: typeof import('jspdf').jsPDF
  ) {
    const PAGE_W = 210;
    const PAGE_H = 297;
    const pdf = new JsPdf({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const fontFamily = layout._global.fontFamily;
    const primaryHex = layout._global.primaryColor;
    const pr = parseInt(primaryHex.slice(1, 3), 16);
    const pg = parseInt(primaryHex.slice(3, 5), 16);
    const pb = parseInt(primaryHex.slice(5, 7), 16);

    const formatAmount = (cents: number, currency = 'EUR') => `${(cents / 100).toFixed(2)} ${currency}`;
    const formatDate = (iso: string) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('fr-FR');
    };

    const getBlockContent = (blockId: InvoiceTemplateBlockId): string => {
      const block = layout[blockId];
      if (block.content) return block.content;
      switch (blockId) {
        case 'logo': return office?.logoData ? '' : '[ Logo ]';
        case 'practitioner':
          return [
            office?.name,
            [office?.addressLine1, office?.addressLine2].filter(Boolean).join(', '),
            [office?.postalCode, office?.city].filter(Boolean).join(' '),
            office?.email,
            office?.phoneMobile
          ].filter(Boolean).join('\n');
        case 'patient':
          return invoice.patientName;
        case 'invoiceMeta':
          return [
            `Facture N° ${invoice.invoiceNumber}`,
            `Date : ${formatDate(invoice.issuedAt)}`,
            invoice.dueAt !== invoice.issuedAt ? `Échéance : ${formatDate(invoice.dueAt)}` : ''
          ].filter(Boolean).join('\n');
        case 'lineItems':
          if (!invoice.lineItems.length) return 'Consultation';
          return invoice.lineItems.map((li) => {
            const ht = formatAmount(li.unitAmountHtCents * li.quantity);
            const vat = li.vatRate > 0 ? ` (TVA ${li.vatRate}%)` : '';
            return `${li.label}  ×${li.quantity}  ${ht}${vat}`;
          }).join('\n');
        case 'totals': {
          const totalHt = invoice.lineItems.reduce((s, li) => s + li.unitAmountHtCents * li.quantity, 0);
          const totalTtc = invoice.amountCents;
          const totalVat = totalTtc - totalHt;
          return [
            `Total HT : ${formatAmount(totalHt)}`,
            `TVA : ${formatAmount(totalVat)}`,
            `Total TTC : ${formatAmount(totalTtc)}`
          ].join('\n');
        }
        case 'payment': {
          if (!invoice.payments.length) return `Méthode : ${invoice.paymentMethod || '-'}`;
          return invoice.payments.map((p) =>
            `${formatDate(p.paidAt)} — ${formatAmount(p.amountCents, p.currency)} — ${p.paymentMethod}`
          ).join('\n');
        }
        case 'mentions':
          return 'Prestation non remboursée par la Sécurité Sociale.';
        case 'signature':
          return '____________________\nSignature';
        default:
          return '';
      }
    };

    const blockOrder = this.invoiceTemplateBlockOptions
      .filter((opt) => layout[opt.key].visible)
      .sort((a, b) => layout[a.key].y - layout[b.key].y);

    for (const opt of blockOrder) {
      const block = layout[opt.key];
      const x = (block.x / 100) * PAGE_W;
      const y = (block.y / 100) * PAGE_H;
      const w = (block.w / 100) * PAGE_W;
      const cr = parseInt(block.color.slice(1, 3), 16);
      const cg = parseInt(block.color.slice(3, 5), 16);
      const cb = parseInt(block.color.slice(5, 7), 16);

      pdf.setFont(fontFamily, 'normal');
      pdf.setFontSize(block.fontSize);
      pdf.setTextColor(cr, cg, cb);

      if (block.borderStyle === 'line') {
        pdf.setDrawColor(pr, pg, pb);
        pdf.line(x, y - 1, x + w, y - 1);
      } else if (block.borderStyle === 'box') {
        pdf.setDrawColor(pr, pg, pb);
        pdf.rect(x, y - 1, w, block.fontSize * 0.5 + 3);
      }

      if (opt.key === 'logo' && office?.logoData) {
        try {
          const logoW = Math.min(w, 40);
          const logoH = 15;
          pdf.addImage(office.logoData, 'JPEG', x, y - logoH + 2, logoW, logoH);
          continue;
        } catch {
          // Fall through to text
        }
      }

      if (block.customLabel) {
        pdf.setFont(fontFamily, 'bold');
        pdf.setFontSize(block.fontSize - 1);
        pdf.text(block.customLabel, x, y);
        pdf.setFont(fontFamily, 'normal');
        pdf.setFontSize(block.fontSize);
      }

      const contentText = getBlockContent(opt.key);
      if (contentText) {
        const lines = pdf.splitTextToSize(contentText, w) as string[];
        const textY = block.customLabel ? y + block.fontSize * 0.4 : y;
        pdf.text(lines, x, textY);
      }
    }

    if (layout._global.footerText) {
      pdf.setFont(fontFamily, 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(120, 120, 120);
      const footerLines = pdf.splitTextToSize(layout._global.footerText, PAGE_W - 28) as string[];
      pdf.text(footerLines, 14, PAGE_H - 8);
    }

    if (layout._global.showPageNumber) {
      pdf.setFont(fontFamily, 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(120, 120, 120);
      pdf.text('Page 1 / 1', PAGE_W - 25, PAGE_H - 5);
    }

    return pdf;
  }
}
