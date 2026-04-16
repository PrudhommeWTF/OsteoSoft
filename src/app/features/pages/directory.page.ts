import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DirectoryContact, DirectoryContactPayload, OfficeOption } from '../../core/api.types';

type ContactKindFilter = 'all' | 'person' | 'company';
type ActiveFilter = 'all' | 'active' | 'inactive';

@Component({
  selector: 'app-directory-page',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './directory.page.html',
  styleUrl: './pages.scss',
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

  readonly contacts = signal<DirectoryContact[]>([]);
  readonly offices = signal<OfficeOption[]>([]);

  readonly search = signal('');
  readonly selectedOfficeId = signal<number | null>(null);
  readonly kindFilter = signal<ContactKindFilter>('all');
  readonly activeFilter = signal<ActiveFilter>('all');

  readonly isModalOpen = signal(false);
  readonly editingContactId = signal<number | null>(null);

  readonly canCreate = computed(() => this.auth.hasPermission('create-directory-contact'));
  readonly canEdit = computed(() => this.auth.hasPermission('edit-directory-contact'));
  readonly canDelete = computed(() => this.auth.hasPermission('delete-directory-contact'));
  readonly canExport = computed(() => this.auth.hasPermission('export-directory'));

  readonly filteredContacts = computed(() => {
    const search = this.search().trim().toLowerCase();
    const kind = this.kindFilter();
    const active = this.activeFilter();

    return this.contacts().filter((contact) => {
      if (kind !== 'all' && contact.kind !== kind) {
        return false;
      }

      if (active === 'active' && !contact.isActive) {
        return false;
      }

      if (active === 'inactive' && contact.isActive) {
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
    isActive: [true]
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
        isActive: this.activeFilter() === 'all' ? null : this.activeFilter() === 'active'
      });

      this.contacts.set(payload.contacts);
      this.offices.set(payload.offices);

      if (this.selectedOfficeId() === null && payload.selectedOfficeId != null) {
        this.selectedOfficeId.set(Number(payload.selectedOfficeId));
      }
    } catch {
      this.errorMessage.set('Impossible de charger le repertoire.');
    } finally {
      this.isLoading.set(false);
    }
  }

  onSearch(value: string): void {
    this.search.set(value);
  }

  async onOfficeChange(value: string): Promise<void> {
    const parsed = Number(value);
    this.selectedOfficeId.set(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
    await this.loadContacts();
  }

  async onKindFilterChange(value: ContactKindFilter): Promise<void> {
    this.kindFilter.set(value);
    await this.loadContacts();
  }

  async onActiveFilterChange(value: ActiveFilter): Promise<void> {
    this.activeFilter.set(value);
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
      isActive: true
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
      isActive: contact.isActive
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
        isActive: Boolean(value.isActive)
      };

      const editingId = this.editingContactId();
      if (editingId !== null) {
        await this.api.updateDirectoryContact(editingId, payload);
        this.successMessage.set('Contact mis a jour.');
      } else {
        await this.api.createDirectoryContact(payload);
        this.successMessage.set('Contact ajoute au repertoire.');
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

  async exportContacts(): Promise<void> {
    if (this.isExporting()) {
      return;
    }

    this.isExporting.set(true);
    this.errorMessage.set('');

    try {
      const blob = await this.api.exportDirectoryContacts(this.selectedOfficeId());
      const fileName = `repertoire-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      this.successMessage.set('Export du repertoire termine.');
    } catch {
      this.errorMessage.set('Impossible d\'exporter le repertoire.');
    } finally {
      this.isExporting.set(false);
    }
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
