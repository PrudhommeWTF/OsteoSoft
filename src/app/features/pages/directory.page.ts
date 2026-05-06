import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DirectoryContact, DirectoryContactPayload, OfficeOption } from '../../core/api.types';
import { BsTooltipDirective } from '../../core/bs-tooltip.directive';
import { sanitizeCellValue } from '../../core/xlsx-export.utils';

type ContactKindFilter = 'all' | 'person' | 'company';

@Component({
  selector: 'app-directory-page',
  standalone: true,
  imports: [ReactiveFormsModule, BsTooltipDirective],
  templateUrl: './directory.page.html',
  styleUrl: './directory.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DirectoryPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FormBuilder);

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly isDeletingId = signal<number | null>(null);
  readonly isExporting = signal(false);

  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly modalError = signal('');
  readonly exportError = signal('');

  readonly isExportModalOpen = signal(false);

  readonly contacts = signal<DirectoryContact[]>([]);
  readonly offices = signal<OfficeOption[]>([]);

  readonly search = signal('');
  readonly selectedOfficeId = signal<number | null>(this.auth.activeOfficeId());
  readonly isAllOfficesOverride = signal(false);
  readonly kindFilter = signal<ContactKindFilter>('all');

  readonly isModalOpen = signal(false);
  readonly editingContactId = signal<number | null>(null);

  readonly canCreate = computed(() => this.auth.hasPermission('create-directory-contact'));
  readonly canEdit = computed(() => this.auth.hasPermission('edit-directory-contact'));
  readonly canDelete = computed(() => this.auth.hasPermission('delete-directory-contact'));
  readonly canExport = computed(() => this.auth.hasPermission('export-directory'));

  readonly filteredContacts = computed(() => {
    const search = this.search().trim().toLowerCase();
    const kind = this.kindFilter();

    return this.contacts().filter((contact) => {
      if (kind !== 'all' && contact.kind !== kind) {
        return false;
      }

      if (!search) {
        return true;
      }

      return [
        contact.displayName,
        contact.organization,
        contact.role,
        contact.email,
        contact.mobilePhone,
        contact.landlinePhone,
        contact.city,
        contact.officeName
      ]
        .map((value) => String(value ?? '').toLowerCase())
        .some((value) => value.includes(search));
    });
  });

  readonly pageSize = signal(25);
  readonly currentPage = signal(1);

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filteredContacts().length / this.pageSize())));
  readonly safeCurrentPage = computed(() => Math.min(this.currentPage(), this.totalPages()));

  readonly paginationInfo = computed(() => {
    const total = this.filteredContacts().length;
    const size = this.pageSize();
    const page = this.safeCurrentPage();
    const from = total === 0 ? 0 : (page - 1) * size + 1;
    const to = Math.min(page * size, total);
    return { from, to, total };
  });

  readonly pagedContacts = computed(() => {
    const page = this.safeCurrentPage();
    const size = this.pageSize();
    return this.filteredContacts().slice((page - 1) * size, page * size);
  });

  readonly pageSizeOptions = [10, 25, 50, 100];
  private readonly activeOfficeSyncEffect = effect(() => {
    const activeOfficeId = this.auth.activeOfficeId();
    if (this.isAllOfficesOverride()) {
      return;
    }

    if (this.selectedOfficeId() === activeOfficeId) {
      return;
    }

    this.selectedOfficeId.set(activeOfficeId);
    this.currentPage.set(1);
    void this.loadContacts();
  });

  setPageSize(size: number): void {
    this.pageSize.set(size);
    this.currentPage.set(1);
  }

  goToPrevPage(): void {
    const page = this.safeCurrentPage();
    if (page > 1) {
      this.currentPage.set(page - 1);
    }
  }

  goToNextPage(): void {
    const page = this.safeCurrentPage();
    if (page < this.totalPages()) {
      this.currentPage.set(page + 1);
    }
  }

  readonly form = this.fb.nonNullable.group({
    officeId: [0, [Validators.required, Validators.min(1)]],
    kind: ['person' as 'person' | 'company', [Validators.required]],
    firstName: ['', [Validators.maxLength(120)]],
    lastName: ['', [Validators.maxLength(120)]],
    organization: ['', [Validators.maxLength(200)]],
    role: ['', [Validators.maxLength(120)]],
    email: ['', [Validators.maxLength(160), Validators.email]],
    mobilePhone: ['', [Validators.maxLength(50)]],
    landlinePhone: ['', [Validators.maxLength(50)]],
    address1: ['', [Validators.maxLength(200)]],
    address2: ['', [Validators.maxLength(200)]],
    postalCode: ['', [Validators.maxLength(20)]],
    city: ['', [Validators.maxLength(120)]],
    country: ['France', [Validators.maxLength(80)]],
    notes: ['', [Validators.maxLength(4000)]],
  });

  constructor() {
    void this.loadContacts();
  }

  async loadContacts(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');

    try {
      const payload = await this.api.getDirectoryContacts({
        officeId: this.selectedOfficeId(),
        kind: this.kindFilter(),
      });

      this.contacts.set(payload.contacts);
      this.offices.set(payload.offices);
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 403) {
          this.errorMessage.set('Accès refusé au répertoire (droits insuffisants).');
        } else if (error.status === 401) {
          this.errorMessage.set('Session expiree. Reconnectez-vous puis reessayez.');
        } else if (error.status === 0) {
          this.errorMessage.set('Serveur API inaccessible. Verifiez que le backend est demarre.');
        } else {
          this.errorMessage.set('Impossible de charger le répertoire.');
        }
      } else {
        this.errorMessage.set('Impossible de charger le répertoire.');
      }
    } finally {
      this.isLoading.set(false);
    }
  }

  onSearch(value: string): void {
    this.search.set(value);
    this.currentPage.set(1);
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
      this.currentPage.set(1);
      await this.loadContacts();
      return;
    }

    this.isAllOfficesOverride.set(false);
    if (nextOfficeId === this.selectedOfficeId() && this.auth.activeOfficeId() === nextOfficeId) {
      return;
    }

    if (this.auth.activeOfficeId() === nextOfficeId) {
      this.selectedOfficeId.set(nextOfficeId);
      this.currentPage.set(1);
      await this.loadContacts();
      return;
    }

    this.auth.setActiveOfficeId(nextOfficeId);
  }

  async onKindFilterChange(value: ContactKindFilter): Promise<void> {
    this.kindFilter.set(value);
    this.currentPage.set(1);
    await this.loadContacts();
  }

  openCreateModal(): void {
    this.editingContactId.set(null);
    this.modalError.set('');
    this.form.reset({
      officeId: this.selectedOfficeId() ?? this.offices()[0]?.id ?? 0,
      kind: 'person',
      firstName: '',
      lastName: '',
      organization: '',
      role: '',
      email: '',
      mobilePhone: '',
      landlinePhone: '',
      address1: '',
      address2: '',
      postalCode: '',
      city: '',
      country: 'France',
      notes: '',
    });
    this.isModalOpen.set(true);
  }

  openEditModal(contact: DirectoryContact): void {
    this.editingContactId.set(contact.id);
    this.modalError.set('');
    this.form.reset({
      officeId: contact.officeId,
      kind: contact.kind,
      firstName: contact.firstName,
      lastName: contact.lastName,
      organization: contact.organization,
      role: contact.role,
      email: contact.email,
      mobilePhone: contact.mobilePhone,
      landlinePhone: contact.landlinePhone,
      address1: contact.address1,
      address2: contact.address2,
      postalCode: contact.postalCode,
      city: contact.city,
      country: contact.country || 'France',
      notes: contact.notes,
    });
    this.isModalOpen.set(true);
  }

  closeModal(): void {
    if (this.isSaving()) {
      return;
    }

    this.isModalOpen.set(false);
    this.modalError.set('');
  }

  async saveContact(): Promise<void> {
    const isEdit = this.editingContactId() !== null;
    if (isEdit ? !this.canEdit() : !this.canCreate()) {
      return;
    }
    if (this.form.invalid || this.isSaving()) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    if (!value.firstName.trim() && !value.lastName.trim() && !value.organization.trim()) {
      this.modalError.set('Renseignez au moins un nom ou une organisation.');
      return;
    }

    this.isSaving.set(true);
    this.modalError.set('');

    try {
      const payload: DirectoryContactPayload = {
        officeId: Number(value.officeId),
        kind: value.kind,
        firstName: value.firstName.trim(),
        lastName: value.lastName.trim(),
        organization: value.organization.trim(),
        role: value.role.trim(),
        email: value.email.trim(),
        mobilePhone: value.mobilePhone.trim(),
        landlinePhone: value.landlinePhone.trim(),
        address1: value.address1.trim(),
        address2: value.address2.trim(),
        postalCode: value.postalCode.trim(),
        city: value.city.trim(),
        country: value.country.trim() || 'France',
        notes: value.notes.trim(),
      };

      const editingId = this.editingContactId();
      if (editingId !== null) {
        await this.api.updateDirectoryContact(editingId, payload);
        this.successMessage.set('Contact mis à jour.');
      } else {
        await this.api.createDirectoryContact(payload);
        this.successMessage.set('Contact ajouté au répertoire.');
      }

      this.isModalOpen.set(false);
      await this.loadContacts();
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 403) {
          this.modalError.set('Vous n\'avez pas les droits pour cette action.');
        } else if (error.status === 404) {
          this.modalError.set('Cabinet introuvable.');
        } else {
          this.modalError.set('Impossible d\'enregistrer ce contact.');
        }
      } else {
        this.modalError.set('Impossible d\'enregistrer ce contact.');
      }
    } finally {
      this.isSaving.set(false);
    }
  }

  async deleteContact(contact: DirectoryContact): Promise<void> {
    if (this.isDeletingId() !== null) {
      return;
    }

    const confirmed = window.confirm(`Supprimer le contact ${contact.displayName} ?`);
    if (!confirmed) {
      return;
    }

    this.isDeletingId.set(contact.id);
    this.errorMessage.set('');

    try {
      await this.api.deleteDirectoryContact(contact.id);
      this.successMessage.set('Contact supprime.');
      await this.loadContacts();
    } catch {
      this.errorMessage.set('Impossible de supprimer ce contact.');
    } finally {
      this.isDeletingId.set(null);
    }
  }

  openExportModal(): void {
    this.exportError.set('');
    this.isExportModalOpen.set(true);
  }

  closeExportModal(): void {
    this.isExportModalOpen.set(false);
    this.isExporting.set(false);
    this.exportError.set('');
  }

  async exportContacts(format: 'json' | 'excel'): Promise<void> {
    if (this.isExporting()) {
      return;
    }

    this.isExporting.set(true);
    this.exportError.set('');

    try {
      const rows = [...this.filteredContacts()].sort((a, b) =>
        this.contactName(a).localeCompare(this.contactName(b), 'fr', { sensitivity: 'base' })
      );
      const exportedAt = new Date().toISOString();
      const fileDate = exportedAt.slice(0, 10);

      if (format === 'json') {
        const payload = {
          meta: {
            kind: 'directory-export',
            exportedAt,
            count: rows.length,
            officeId: this.selectedOfficeId(),
            search: this.search().trim(),
            kindFilter: this.kindFilter()
          },
          contacts: rows.map((contact) => ({
            id: contact.id,
            displayName: contact.displayName,
            kind: contact.kind,
            officeName: contact.officeName,
            role: contact.role,
            email: contact.email,
            mobilePhone: contact.mobilePhone,
            landlinePhone: contact.landlinePhone,
            address1: contact.address1,
            address2: contact.address2,
            postalCode: contact.postalCode,
            city: contact.city,
            country: contact.country,
            notes: contact.notes
          }))
        };

        this.downloadBlob(
          new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
          `repertoire-export-${fileDate}.json`
        );
      } else {
        const ExcelJS = await import('exceljs');
        const sheetRows = rows.map((contact) => ({
          nom: sanitizeCellValue(this.contactName(contact)),
          type: sanitizeCellValue(this.kindLabel(contact.kind)),
          cabinet: sanitizeCellValue(contact.officeName),
          fonction: sanitizeCellValue(contact.role),
          email: sanitizeCellValue(contact.email),
          telephoneMobile: sanitizeCellValue(contact.mobilePhone),
          telephoneFixe: sanitizeCellValue(contact.landlinePhone),
          adresse: sanitizeCellValue(contact.address1),
          complementAdresse: sanitizeCellValue(contact.address2),
          codePostal: sanitizeCellValue(contact.postalCode),
          ville: sanitizeCellValue(contact.city),
          pays: sanitizeCellValue(contact.country),
          notes: sanitizeCellValue(contact.notes)
        }));

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Répertoire');
        if (sheetRows.length > 0) {
          worksheet.columns = Object.keys(sheetRows[0]).map((key) => ({ header: key, key }));
          worksheet.addRows(sheetRows);
        }
        const arrayBuffer = await workbook.xlsx.writeBuffer();

        this.downloadBlob(
          new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
          `repertoire-export-${fileDate}.xlsx`
        );
      }

      this.successMessage.set('Export du répertoire terminé.');
      this.closeExportModal();
    } catch {
      this.exportError.set('Impossible d\'exporter le répertoire.');
    } finally {
      this.isExporting.set(false);
    }
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  }

  kindLabel(kind: 'person' | 'company'): string {
    return kind === 'company' ? 'Societe' : 'Personne';
  }

  contactName(contact: DirectoryContact): string {
    if (contact.displayName.trim()) {
      return contact.displayName;
    }

    return contact.organization || 'Contact';
  }
}
