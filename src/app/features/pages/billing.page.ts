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
  readonly exportHistorySort = signal<'date-desc' | 'date-asc' | 'status'>('date-desc');
  readonly exportHistorySearch = signal('');
  readonly exportToastMessage = signal('');
  readonly exportToastType = signal<'success' | 'error'>('success');
  readonly isExportToastVisible = signal(false);

  readonly expenseOccurredAt = signal(this.defaultNowDateTimeLocal());
  readonly expenseTitle = signal('');
  readonly expenseAmount = signal('');
  readonly expensePaymentMethod = signal('');
  readonly expenseNotes = signal('');
  readonly isExpenseModalOpen = signal(false);

  readonly depositOccurredAt = signal(this.defaultNowDateTimeLocal());
  readonly depositType = signal<'cheque' | 'especes'>('cheque');
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
    const filter = this.exportHistoryFilter();
    if (filter === 'all') {
      return this.exportHistory();
    }
    return this.exportHistory().filter((item) => item.status === filter);
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

  constructor() {
    this.restoreAlertCategories();
    this.restoreExportHistory();

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
    this.depositTitle.set(mode === 'edit' ? String(deposit?.title ?? '') : (type === 'especes' ? 'Bordereau de remise d\'especes' : 'Bordereau de remise de cheques'));
    this.depositCode.set(mode === 'edit' ? String(deposit?.code ?? '') : '');
    this.depositBankName.set(mode === 'edit' ? String(deposit?.bankName ?? '') : '');
    this.depositAccountLabel.set(mode === 'edit' ? String(deposit?.accountLabel ?? '') : '');
    this.depositNotes.set(mode === 'edit' ? String(deposit?.notes ?? '') : '');
    this.depositAmount.set(mode === 'edit' ? (Number(deposit?.amountCents ?? 0) / 100).toFixed(2) : '');
    this.depositEditorCandidateIds.set(mode === 'edit' ? [...(deposit?.operationIds ?? [])] : []);

    this.isDepositEditorModalOpen.set(true);
    if (mode === 'create') {
      await this.loadDepositCandidates(type);
      const preselected = this.selectedOperations()
        .filter((operation) => operation.sourceType === 'invoice')
        .map((operation) => operation.id);
      if (preselected.length > 0) {
        this.depositEditorCandidateIds.update((current) => [...new Set([...current, ...preselected])]);
      }
    } else {
      await this.loadDepositCandidates(type);
    }
  }

  closeDepositEditorModal(): void {
    this.isDepositEditorModalOpen.set(false);
  }

  toggleDepositCandidate(operationId: string, checked: boolean): void {
    const current = this.depositEditorCandidateIds();
    if (checked) {
      if (!current.includes(operationId)) {
        this.depositEditorCandidateIds.set([...current, operationId]);
      }
      return;
    }
    this.depositEditorCandidateIds.set(current.filter((id) => id !== operationId));
  }

  async saveDepositEditor(): Promise<void> {
    const amount = Number(this.depositAmount());
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

  setExportHistorySort(sort: 'date-desc' | 'date-asc' | 'status'): void {
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

  exportHistoryCsv(): void {
    const rows = this.displayedExportHistory();
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
    this.showExportToast('Historique exporte en CSV.', 'success');
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
        .slice(0, 12)
        .map((item) => ({
          id: String(item.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          sessionId: String(item.sessionId ?? this.buildExportSessionId()),
          label: String(item.label ?? 'Pack export'),
          operationsFormat: item.operationsFormat === 'json' ? 'json' as const : 'excel' as const,
          alertsFormat: item.alertsFormat === 'excel' ? 'excel' as const : 'json' as const,
          status: item.status === 'error' ? 'error' as const : 'success' as const,
          createdAt: String(item.createdAt ?? new Date().toISOString())
        }));
      this.exportHistory.set(sanitized);
    } catch {
      this.exportHistory.set([]);
    }
  }

  private buildExportSessionId(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
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
