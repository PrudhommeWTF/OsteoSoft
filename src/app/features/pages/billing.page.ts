import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import {
  BillingAlertsPayload,
  BillingDepositCandidate,
  BillingDepositDetail,
  BillingDepositListItem,
  BillingForecastPayload,
  BillingInsightsPayload,
  BillingOperation,
  BillingOperationsPayload,
  BillingUserOption,
  InvoiceSummaryTile,
  OfficeOption
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';

type ExportHistoryItem = {
  id: string;
  sessionId: string;
  label: string;
  operationsFormat: 'json' | 'excel';
  alertsFormat: 'json' | 'excel';
  status: 'success' | 'error';
  createdAt: string;
};

type TrashExportItem = ExportHistoryItem & {
  deletedAt: string;
};

@Component({
  selector: 'app-billing-page',
  imports: [CommonModule, RouterLink],
  templateUrl: './billing.page.html',
  styleUrl: './billing.page.scss',
  host: {
    '(document:click)': 'closeActionMenus()'
  },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BillingPage implements OnDestroy {
  private static readonly ALERT_FILTERS_STORAGE_KEY = 'billing-alert-filters-v1';
  private static readonly EXPORT_HISTORY_STORAGE_KEY = 'billing-export-history-v1';
  private static readonly EXPORT_HISTORY_EXPIRATION_DAYS = 30;
  private alertsReloadTimeout: ReturnType<typeof setTimeout> | null = null;
  private exportToastTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);

  readonly tiles = signal<InvoiceSummaryTile[]>([]);
  readonly operations = signal<BillingOperation[]>([]);
  readonly offices = signal<OfficeOption[]>([]);
  readonly users = signal<BillingUserOption[]>([]);
  readonly billingInsights = signal<BillingInsightsPayload | null>(null);
  readonly billingForecast = signal<BillingForecastPayload | null>(null);
  readonly billingAlerts = signal<BillingAlertsPayload | null>(null);
  readonly debtorSearch = signal('');
  readonly debtorSort = signal<'name' | 'invoices' | 'outstanding'>('outstanding');
  readonly debtorSortDirection = signal<'asc' | 'desc'>('desc');
  readonly debtorPage = signal(1);
  readonly debtorPageSize = signal(5);
  readonly exportHistoryPage = signal(1);
  readonly exportHistoryPageSize = signal(10);

  readonly fromDate = signal('');
  readonly toDate = signal('');
  readonly selectedOfficeId = signal<number | null>(null);
  readonly selectedUserId = signal<number | null>(null);

  readonly selectedOperationIds = signal<string[]>([]);
  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly isAlertsLoading = signal(false);
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

  readonly alertCategoryOverdue = signal(true);
  readonly alertCategoryDueSoon = signal(true);
  readonly alertCategoryHighExpenses = signal(true);
  readonly alertCategoryUnassigned = signal(true);

  readonly bulkOwnerUserId = signal<number | null>(null);
  readonly bulkRetrocessionPercent = signal('');
  readonly bulkRetrocessionRecipient = signal('');

  readonly canExportBilling = computed(() => this.authService.hasPermission('export-billing'));

  readonly selectedCount = computed(() => this.selectedOperationIds().length);

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

  readonly selectedDepositCandidateCount = computed(() => this.selectedDepositCandidates().length);

  readonly incompatibleSelectedDepositCandidates = computed(() => {
    const type = this.depositType();
    return this.selectedDepositCandidates().filter((item) => !this.isCandidateCompatibleWithDepositType(item.paymentMethod, type));
  });

  readonly hasIncompatibleSelectedDepositCandidates = computed(() => {
    return this.incompatibleSelectedDepositCandidates().length > 0;
  });

  readonly canProceedToDepositPointage = computed(() => {
    return this.depositOccurredAt().trim().length > 0 && this.depositTitle().trim().length > 0;
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

  readonly selectedAlertCategories = computed<Array<'overdue' | 'dueSoon' | 'highExpenses' | 'unassigned'>>(() => {
    const categories: Array<'overdue' | 'dueSoon' | 'highExpenses' | 'unassigned'> = [];
    if (this.alertCategoryOverdue()) {
      categories.push('overdue');
    }
    if (this.alertCategoryDueSoon()) {
      categories.push('dueSoon');
    }
    if (this.alertCategoryHighExpenses()) {
      categories.push('highExpenses');
    }
    if (this.alertCategoryUnassigned()) {
      categories.push('unassigned');
    }
    return categories;
  });

  readonly hasAnyAlertCategorySelected = computed(() => this.selectedAlertCategories().length > 0);
  readonly activeAlertCategoryCount = computed(() => this.selectedAlertCategories().length);
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
      item.operationsFormat === formatFilter || item.alertsFormat === formatFilter
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
      item.operationsFormat === 'excel' || item.alertsFormat === 'excel'
    ).length;
    const jsonCount = items.filter((item) =>
      item.operationsFormat === 'json' || item.alertsFormat === 'json'
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
    this.restoreAlertCategories();
    this.restoreExportHistory();
    this.restoreExportTrash();

    const now = new Date();
    this.fromDate.set(this.toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1)));
    this.toDate.set(this.toDateInputValue(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    void this.load();
  }

  ngOnDestroy(): void {
    if (this.alertsReloadTimeout != null) {
      clearTimeout(this.alertsReloadTimeout);
      this.alertsReloadTimeout = null;
    }
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
    await this.load();
  }

  async onDateRangeChange(): Promise<void> {
    await this.load();
  }

  async onOfficeChange(value: string): Promise<void> {
    const parsed = Number(value);
    this.selectedOfficeId.set(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
    this.selectedUserId.set(null);
    await this.load();
  }

  async onUserChange(value: string): Promise<void> {
    const parsed = Number(value);
    this.selectedUserId.set(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
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

  openExpenseModal(): void {
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
    const type = this.depositModalType();
    this.editingDepositId.set(mode === 'edit' ? (deposit?.id ?? null) : null);

    const now = this.defaultNowDateTimeLocal();
    this.depositOccurredAt.set(mode === 'edit' ? this.toDateTimeLocalValue(deposit?.occurredAt ?? '') || now : now);
    this.depositType.set(type);
    this.depositWizardStep.set(1);
    this.depositTitle.set(mode === 'edit' ? String(deposit?.title ?? '') : (type === 'especes' ? 'Bordereau de remise d\'especes' : 'Bordereau de remise de cheques'));
    this.depositCode.set(mode === 'edit' ? String(deposit?.code ?? '') : '');
    this.depositBankName.set(mode === 'edit' ? String(deposit?.bankName ?? '') : 'Banque principale');
    this.depositAccountLabel.set(mode === 'edit' ? String(deposit?.accountLabel ?? '') : (type === 'especes' ? 'Caisse especes' : 'Compte cheques')); 
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
      await this.loadDepositCandidates(type);
    }
  }

  closeDepositEditorModal(): void {
    this.isDepositEditorModalOpen.set(false);
    this.depositWizardStep.set(1);
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
      this.errorMessage.set('Selectionnez au moins un paiement avant le recapitulatif.');
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
      this.depositTitle.set('Bordereau de remise d\'especes');
      if (!this.depositAccountLabel().trim()) {
        this.depositAccountLabel.set('Caisse especes');
      }
      if (!this.depositBankName().trim()) {
        this.depositBankName.set('Banque principale');
      }
      this.pruneIncompatibleDepositSelections();
      this.syncDepositAmountFromCandidates();
      return;
    }

    this.depositTitle.set('Bordereau de remise de cheques');
    if (!this.depositAccountLabel().trim()) {
      this.depositAccountLabel.set('Compte cheques');
    }
    if (!this.depositBankName().trim()) {
      this.depositBankName.set('Banque principale');
    }
    this.pruneIncompatibleDepositSelections();
    this.syncDepositAmountFromCandidates();
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
    const isEditing = this.editingDepositId() != null;
    if (!isEditing && this.depositWizardStep() !== 3) {
      this.errorMessage.set('Finalisez le recapitulatif avant de creer le bordereau.');
      return;
    }
    if (!isEditing && this.depositEditorCandidateIds().length === 0) {
      this.errorMessage.set('Selectionnez au moins un paiement a pointer.');
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
          amount
        });
        this.successMessage.set('Bordereau mis a jour.');
      } else {
        await this.api.createBillingDeposit({
          occurredAt: this.fromDateTimeLocalValue(this.depositOccurredAt()) ?? new Date().toISOString(),
          officeId: this.selectedOfficeId(),
          ownerUserId: this.selectedUserId(),
          type: this.depositModalType(),
          depositCode: this.depositCode().trim(),
          bankName: this.depositBankName().trim(),
          accountLabel: this.depositAccountLabel().trim(),
          title: this.depositTitle().trim(),
          amount,
          currency: 'EUR',
          notes: this.depositNotes().trim(),
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
      this.errorMessage.set('Impossible de generer le PDF du bordereau.');
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

  private async loadDepositCandidates(type: 'cheque' | 'especes'): Promise<void> {
    this.isLoadingDepositCandidates.set(true);
    try {
      const rows = await this.api.getBillingDepositCandidates(type, this.selectedOfficeId());
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
    if (this.selectedOperationIds().length === 0) {
      this.errorMessage.set('Selectionnez au moins une operation.');
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
      this.successMessage.set('Operations mises a jour.');
      await this.load();
    } catch {
      this.errorMessage.set('Impossible de mettre a jour les operations.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async deleteSelectedOperations(): Promise<void> {
    if (this.selectedOperationIds().length === 0) {
      this.errorMessage.set('Selectionnez au moins une operation.');
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
      this.successMessage.set('Operations supprimees.');
      this.selectedOperationIds.set([]);
      await this.load();
    } catch {
      this.errorMessage.set('Impossible de supprimer les operations.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async exportOperations(format: 'json' | 'excel', mode: 'standard' | 'analytical' = 'standard'): Promise<void> {
    this.closeActionMenus();
    if (!this.canExportBilling()) {
      this.errorMessage.set('Vous n\'avez pas le droit d\'exporter la comptabilite.');
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
      this.successMessage.set('Export termine.');
    } catch {
      this.errorMessage.set('Impossible d\'exporter la comptabilite.');
    } finally {
      this.isSaving.set(false);
    }
  }

  async exportAlertsCsv(): Promise<void> {
    await this.exportAlerts('excel');
  }

  async exportAlertsJson(): Promise<void> {
    await this.exportAlerts('json');
  }

  async exportSnapshotPack(format: 'json' | 'excel'): Promise<void> {
    await this.exportSnapshotPackInternal(format, format);
  }

  async exportSnapshotPackMixed(): Promise<void> {
    await this.exportSnapshotPackInternal('excel', 'json');
  }

  private async exportSnapshotPackInternal(
    operationsFormat: 'json' | 'excel',
    alertsFormat: 'json' | 'excel'
  ): Promise<void> {
    this.closeActionMenus();
    if (!this.canExportBilling()) {
      this.errorMessage.set('Vous n\'avez pas le droit d\'exporter la comptabilite.');
      this.showExportToast('Export non autorise.', 'error');
      return;
    }
    if (this.isSnapshotExporting()) {
      this.errorMessage.set('Un pack export est deja en cours.');
      this.showExportToast('Un pack est deja en cours.', 'error');
      return;
    }

    const categories = this.selectedAlertCategories();
    if (categories.length === 0) {
      this.errorMessage.set('Selectionnez au moins une categorie d\'alerte.');
      this.showExportToast('Selectionnez une categorie d\'alerte.', 'error');
      return;
    }

    const createdAt = new Date().toISOString();
    const sessionId = this.buildExportSessionId();
    const label = operationsFormat === alertsFormat
      ? `Pack ${operationsFormat === 'json' ? 'JSON' : 'CSV'}`
      : 'Pack mixte (compta CSV + alertes JSON)';

    this.isSnapshotExporting.set(true);
    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const [operationsBlob, alertsBlob] = await Promise.all([
        this.api.exportBillingOperations(operationsFormat, {
          ...this.buildFilters(),
          mode: 'analytical'
        }),
        this.api.exportBillingAlerts(alertsFormat, this.selectedOfficeId(), categories)
      ]);

      const operationsExtension = operationsFormat === 'json' ? 'json' : 'csv';
      const alertsExtension = alertsFormat === 'json' ? 'json' : 'csv';
      const datePart = new Date().toISOString().slice(0, 10);
      this.downloadBlob(operationsBlob, `snapshot-comptabilite-analytical-${datePart}-${sessionId}.${operationsExtension}`);
      this.downloadBlob(alertsBlob, `snapshot-alertes-${datePart}-${sessionId}.${alertsExtension}`);
      this.successMessage.set(`Pack export telecharge (${label.toLowerCase()}).`);
      this.showExportToast('Pack export termine.', 'success');
      this.pushExportHistory({
        id: `${createdAt}-success-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        label,
        operationsFormat,
        alertsFormat,
        status: 'success',
        createdAt
      });
    } catch {
      this.errorMessage.set('Impossible d\'exporter le pack.');
      this.showExportToast('Echec du pack export.', 'error');
      this.pushExportHistory({
        id: `${createdAt}-error-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        label,
        operationsFormat,
        alertsFormat,
        status: 'error',
        createdAt
      });
    } finally {
      this.isSnapshotExporting.set(false);
      this.isSaving.set(false);
    }
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

  toggleAlertCategory(category: 'overdue' | 'dueSoon' | 'highExpenses' | 'unassigned', checked: boolean): void {
    if (category === 'overdue') {
      this.alertCategoryOverdue.set(checked);
      this.persistAlertCategories();
      this.scheduleAlertsReload();
      return;
    }
    if (category === 'dueSoon') {
      this.alertCategoryDueSoon.set(checked);
      this.persistAlertCategories();
      this.scheduleAlertsReload();
      return;
    }
    if (category === 'highExpenses') {
      this.alertCategoryHighExpenses.set(checked);
      this.persistAlertCategories();
      this.scheduleAlertsReload();
      return;
    }
    this.alertCategoryUnassigned.set(checked);
    this.persistAlertCategories();
    this.scheduleAlertsReload();
  }

  resetAlertCategories(): void {
    this.alertCategoryOverdue.set(true);
    this.alertCategoryDueSoon.set(true);
    this.alertCategoryHighExpenses.set(true);
    this.alertCategoryUnassigned.set(true);
    this.persistAlertCategories();
    this.scheduleAlertsReload();
  }

  selectAllAlertCategories(): void {
    this.alertCategoryOverdue.set(true);
    this.alertCategoryDueSoon.set(true);
    this.alertCategoryHighExpenses.set(true);
    this.alertCategoryUnassigned.set(true);
    this.persistAlertCategories();
    this.scheduleAlertsReload();
  }

  clearAlertCategories(): void {
    this.alertCategoryOverdue.set(false);
    this.alertCategoryDueSoon.set(false);
    this.alertCategoryHighExpenses.set(false);
    this.alertCategoryUnassigned.set(false);
    this.persistAlertCategories();
    this.scheduleAlertsReload();
  }

  private async exportAlerts(format: 'json' | 'excel'): Promise<void> {
    this.closeActionMenus();
    if (!this.canExportBilling()) {
      this.errorMessage.set('Vous n\'avez pas le droit d\'exporter la comptabilite.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const categories = this.selectedAlertCategories();
      if (categories.length === 0) {
        this.errorMessage.set('Selectionnez au moins une categorie d\'alerte.');
        return;
      }

      const blob = await this.api.exportBillingAlerts(format, this.selectedOfficeId(), categories);
      const extension = format === 'json' ? 'json' : 'csv';
      const fileName = `billing-alerts-${new Date().toISOString().slice(0, 10)}.${extension}`;
      this.downloadBlob(blob, fileName);
      this.successMessage.set(`Export ${format === 'json' ? 'JSON' : 'CSV'} des alertes termine.`);
    } catch {
      this.errorMessage.set('Impossible d\'exporter les alertes.');
    } finally {
      this.isSaving.set(false);
    }
  }

  private async reloadAlerts(): Promise<void> {
    const filters = this.buildFilters();
    const categories = this.selectedAlertCategories();
    if (categories.length === 0) {
      this.billingAlerts.set(this.emptyAlertsPayload());
      return;
    }

    this.isAlertsLoading.set(true);
    try {
      const alerts = await this.api.getBillingAlerts(filters.officeId, categories);
      this.billingAlerts.set(alerts);
    } catch {
      this.billingAlerts.set(null);
    } finally {
      this.isAlertsLoading.set(false);
    }
  }

  private scheduleAlertsReload(): void {
    if (this.alertsReloadTimeout != null) {
      clearTimeout(this.alertsReloadTimeout);
      this.alertsReloadTimeout = null;
    }

    this.isAlertsLoading.set(true);
    this.alertsReloadTimeout = setTimeout(() => {
      this.alertsReloadTimeout = null;
      void this.reloadAlerts();
    }, 180);
  }

  private emptyAlertsPayload(): BillingAlertsPayload {
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        overdueCriticalCount: 0,
        dueSoonCount: 0,
        highExpensesCount: 0,
        unassignedOwnerCount: 0
      },
      overdueCritical: [],
      dueSoon: [],
      highExpenses: [],
      unassignedOwnerOperations: []
    };
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
    this.isAlertsLoading.set(true);
    this.errorMessage.set('');
    try {
      const filters = this.buildFilters();
      const categories = this.selectedAlertCategories();
      const [operationsResult, insightsResult, forecastResult, alertsResult] = await Promise.allSettled([
        this.api.getBillingOperations(filters),
        this.api.getBillingInsights({
          from: filters.from,
          to: filters.to,
          officeId: filters.officeId
        }),
        this.api.getBillingForecast(filters.officeId),
        categories.length > 0
          ? this.api.getBillingAlerts(filters.officeId, categories)
          : Promise.resolve(this.emptyAlertsPayload())
      ]);

      if (operationsResult.status === 'fulfilled') {
        this.applyPayload(operationsResult.value);
      } else {
        throw operationsResult.reason;
      }

      this.billingInsights.set(insightsResult.status === 'fulfilled' ? insightsResult.value : null);
      this.billingForecast.set(forecastResult.status === 'fulfilled' ? forecastResult.value : null);
      this.billingAlerts.set(alertsResult.status === 'fulfilled' ? alertsResult.value : null);
    } catch {
      this.errorMessage.set('Impossible de charger les operations comptables.');
    } finally {
      this.isLoading.set(false);
      this.isAlertsLoading.set(false);
    }
  }

  private persistAlertCategories(): void {
    try {
      const payload = {
        overdue: this.alertCategoryOverdue(),
        dueSoon: this.alertCategoryDueSoon(),
        highExpenses: this.alertCategoryHighExpenses(),
        unassigned: this.alertCategoryUnassigned()
      };
      localStorage.setItem(BillingPage.ALERT_FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage may be unavailable (private mode / tests), keep runtime state only.
    }
  }

  private restoreAlertCategories(): void {
    try {
      const raw = localStorage.getItem(BillingPage.ALERT_FILTERS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as {
        overdue?: boolean;
        dueSoon?: boolean;
        highExpenses?: boolean;
        unassigned?: boolean;
      };

      this.alertCategoryOverdue.set(parsed.overdue !== false);
      this.alertCategoryDueSoon.set(parsed.dueSoon !== false);
      this.alertCategoryHighExpenses.set(parsed.highExpenses !== false);
      this.alertCategoryUnassigned.set(parsed.unassigned !== false);
    } catch {
      this.alertCategoryOverdue.set(true);
      this.alertCategoryDueSoon.set(true);
      this.alertCategoryHighExpenses.set(true);
      this.alertCategoryUnassigned.set(true);
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
      this.showExportToast('Aucun export ancien a nettoyer.', 'success');
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
      this.showExportToast(`Session ${normalized} copiee.`, 'success');
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
      this.showExportToast('Aucun export selectione.', 'error');
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
      this.showExportToast(`${selected.size} session(s) copiee(s).`, 'success');
    } catch {
      this.showExportToast('Impossible de copier les sessions.', 'error');
    }
  }

  showDeleteExportConfirm(): void {
    const count = this.selectedExportIds().size;
    if (count === 0) {
      this.showExportToast('Aucun export selectione.', 'error');
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
    this.showExportToast(`${removed} export(s) dans la corbeille. Recuperables pendant 7 jours.`, 'success');
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
      alertsFormat: trashItem.alertsFormat,
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
      alertsFormat: item.alertsFormat,
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
    this.showExportToast('Corbeille videe definitivement.', 'success');
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
      this.showExportToast('Aucun element a exporter.', 'error');
      return;
    }

    const header = ['Date', 'SessionId', 'Label', 'OperationsFormat', 'AlertsFormat', 'Status'];
    const csvRows = rows.map((item) => [
      item.createdAt,
      item.sessionId,
      item.label,
      item.operationsFormat,
      item.alertsFormat,
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
      this.showExportToast('Aucun element a exporter.', 'error');
      return;
    }

    const payload = rows.map((item) => ({
      createdAt: item.createdAt,
      sessionId: item.sessionId,
      label: item.label,
      operationsFormat: item.operationsFormat,
      alertsFormat: item.alertsFormat,
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
      this.showExportToast('Aucun element selectione.', 'error');
      return;
    }

    const rows = this.searchedExportHistory().filter((item) => selected.has(item.id));
    if (rows.length === 0) {
      this.showExportToast('Aucun element a exporter.', 'error');
      return;
    }

    const header = ['Date', 'SessionId', 'Label', 'OperationsFormat', 'AlertsFormat', 'Status'];
    const csvRows = rows.map((item) => [
      item.createdAt,
      item.sessionId,
      item.label,
      item.operationsFormat,
      item.alertsFormat,
      item.status
    ]);
    const csv = [header, ...csvRows]
      .map((line) => line.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';'))
      .join('\n');

    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    this.downloadBlob(blob, `export-history-selected-${new Date().toISOString().slice(0, 10)}.csv`);
    this.showExportToast(`${rows.length} export(s) selectione(s) en CSV.`, 'success');
  }

  exportSelectedHistoryJson(): void {
    const selected = this.selectedExportIds();
    if (selected.size === 0) {
      this.showExportToast('Aucun element selectione.', 'error');
      return;
    }

    const rows = this.searchedExportHistory().filter((item) => selected.has(item.id));
    if (rows.length === 0) {
      this.showExportToast('Aucun element a exporter.', 'error');
      return;
    }

    const payload = rows.map((item) => ({
      createdAt: item.createdAt,
      sessionId: item.sessionId,
      label: item.label,
      operationsFormat: item.operationsFormat,
      alertsFormat: item.alertsFormat,
      status: item.status
    }));

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    this.downloadBlob(blob, `export-history-selected-${new Date().toISOString().slice(0, 10)}.json`);
    this.showExportToast(`${rows.length} export(s) selectione(s) en JSON.`, 'success');
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
          alertsFormat: item.alertsFormat === 'excel' ? 'excel' as const : 'json' as const,
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
          alertsFormat: item.alertsFormat === 'excel' ? 'excel' as const : 'json' as const,
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
    this.operations.set(payload.operations ?? []);
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
}
