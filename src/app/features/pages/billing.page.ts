import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { jsPDF } from 'jspdf';

import { ApiService } from '../../core/api.service';
import {
  BillingDepositCandidate,
  BillingDepositDetail,
  BillingDepositListItem,
  BillingOperation,
  BillingOperationsPayload,
  BillingUserOption,
  InvoiceSummaryTile,
  OfficeOption
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';

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
export class BillingPage {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);

  readonly tiles = signal<InvoiceSummaryTile[]>([]);
  readonly operations = signal<BillingOperation[]>([]);
  readonly offices = signal<OfficeOption[]>([]);
  readonly users = signal<BillingUserOption[]>([]);

  readonly fromDate = signal('');
  readonly toDate = signal('');
  readonly selectedOfficeId = signal<number | null>(null);
  readonly selectedUserId = signal<number | null>(null);

  readonly selectedOperationIds = signal<string[]>([]);
  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');

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

  constructor() {
    const now = new Date();
    this.fromDate.set(this.toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1)));
    this.toDate.set(this.toDateInputValue(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    void this.load();
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
      const pdf = this.buildDepositPdf(detail);
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

  private buildDepositPdf(detail: BillingDepositDetail): jsPDF {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
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

  async exportOperations(format: 'json' | 'excel'): Promise<void> {
    this.closeActionMenus();
    if (!this.canExportBilling()) {
      this.errorMessage.set('Vous n\'avez pas le droit d\'exporter la comptabilite.');
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const blob = await this.api.exportBillingOperations(format, this.buildFilters());
      const extension = format === 'json' ? 'json' : 'csv';
      const fileName = `comptabilite-${new Date().toISOString().slice(0, 10)}.${extension}`;
      this.downloadBlob(blob, fileName);
      this.successMessage.set('Export termine.');
    } catch {
      this.errorMessage.set('Impossible d\'exporter la comptabilite.');
    } finally {
      this.isSaving.set(false);
    }
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
      const payload = await this.api.getBillingOperations(this.buildFilters());
      this.applyPayload(payload);
    } catch {
      this.errorMessage.set('Impossible de charger les operations comptables.');
    } finally {
      this.isLoading.set(false);
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
