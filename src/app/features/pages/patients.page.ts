import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { OfficeOption, Patient } from '../../core/api.types';
import { BsTooltipDirective } from '../../core/bs-tooltip.directive';
import { sanitizeCellValue } from '../../core/xlsx-export.utils';

@Component({
  selector: 'app-patients-page',
  imports: [RouterLink, BsTooltipDirective],
  templateUrl: './patients.page.html',
  styleUrl: './patients.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientsPage {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);

  readonly search = signal('');
  readonly patients = signal<Patient[]>([]);
  readonly selectedOfficeId = signal<number | null>(this.authService.activeOfficeId());
  readonly isAllOfficesOverride = signal(false);
  readonly officeOptions = computed<OfficeOption[]>(() => this.authService.offices());
  readonly canExportPatients = computed(() => this.authService.hasPermission('export-patient-list'));
  readonly canCreatePatient = computed(() => this.authService.hasPermission('create-patient-record'));
  readonly isExportModalOpen = signal(false);
  readonly isExportingPatients = signal(false);
  readonly exportPatientsError = signal('');
  private readonly activeOfficeSyncEffect = effect(() => {
    const activeOfficeId = this.authService.activeOfficeId();
    if (this.isAllOfficesOverride()) {
      return;
    }

    if (this.selectedOfficeId() === activeOfficeId) {
      return;
    }

    this.selectedOfficeId.set(activeOfficeId);
    void this.load();
  });

  constructor() {
    void this.load();
  }

  readonly filteredPatients = computed(() => {
    const query = this.search().trim().toLowerCase();
    if (!query) {
      return this.patients();
    }

    return this.patients().filter((patient) => patient.fullName.toLowerCase().includes(query));
  });

  readonly pageSize = signal(25);
  readonly currentPage = signal(1);

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filteredPatients().length / this.pageSize())));
  readonly safeCurrentPage = computed(() => Math.min(this.currentPage(), this.totalPages()));

  readonly paginationInfo = computed(() => {
    const total = this.filteredPatients().length;
    const size = this.pageSize();
    const page = this.safeCurrentPage();
    const from = total === 0 ? 0 : (page - 1) * size + 1;
    const to = Math.min(page * size, total);
    return { from, to, total };
  });

  readonly pagedPatients = computed(() => {
    const page = this.safeCurrentPage();
    const size = this.pageSize();
    return this.filteredPatients().slice((page - 1) * size, page * size);
  });

  readonly pageSizeOptions = [10, 25, 50, 100];

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

  onSearch(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const query = target?.value ?? '';
    this.search.set(query);
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
      await this.load();
      return;
    }

    this.isAllOfficesOverride.set(false);
    if (nextOfficeId === this.selectedOfficeId() && this.authService.activeOfficeId() === nextOfficeId) {
      return;
    }

    if (this.authService.activeOfficeId() === nextOfficeId) {
      this.selectedOfficeId.set(nextOfficeId);
      this.currentPage.set(1);
      await this.load();
      return;
    }

    this.authService.setActiveOfficeId(nextOfficeId);
  }

  sexIcon(sex: Patient['sex']): string | null {
    if (sex === 'Femme') return 'fa-solid fa-venus';
    if (sex === 'Homme') return 'fa-solid fa-mars';
    return null;
  }

  sexColorClass(sex: Patient['sex']): string {
    if (sex === 'Femme') return 'text-danger';
    if (sex === 'Homme') return 'text-primary';
    return 'text-secondary';
  }

  openExportModal(): void {
    this.exportPatientsError.set('');
    this.isExportModalOpen.set(true);
  }

  closeExportModal(): void {
    this.isExportModalOpen.set(false);
    this.isExportingPatients.set(false);
    this.exportPatientsError.set('');
  }

  async exportPatients(format: 'json' | 'excel'): Promise<void> {
    if (this.isExportingPatients()) {
      return;
    }

    this.isExportingPatients.set(true);
    this.exportPatientsError.set('');

    try {
      const rows = [...this.filteredPatients()].sort((a, b) => a.fullName.localeCompare(b.fullName, 'fr', { sensitivity: 'base' }));
      const exportedAt = new Date().toISOString();
      const fileDate = exportedAt.slice(0, 10);

      if (format === 'json') {
        const payload = {
          meta: {
            kind: 'patients-list-export',
            exportedAt,
            count: rows.length,
            query: this.search().trim()
          },
          patients: rows.map((patient) => ({
            id: patient.id,
            fullName: patient.fullName,
            phone: patient.phone,
            lastVisit: patient.lastVisit,
            sex: patient.sex,
            age: patient.age,
            consultationCount: patient.consultationCount
          }))
        };

        this.downloadBlob(
          new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
          `patients-export-${fileDate}.json`
        );
      } else {
        const xlsx = await import('xlsx');
        const sheetRows = rows.map((patient) => ({
          nom: sanitizeCellValue(patient.fullName),
          telephone: sanitizeCellValue(patient.phone),
          derniereVisite: sanitizeCellValue(patient.lastVisit),
          sexe: sanitizeCellValue(patient.sex),
          age: patient.age ?? '',
          nombreConsultations: patient.consultationCount
        }));

        const worksheet = xlsx.utils.json_to_sheet(sheetRows);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Patients');
        const arrayBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'array' });

        this.downloadBlob(
          new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
          `patients-export-${fileDate}.xlsx`
        );
      }

      this.closeExportModal();
    } catch {
      this.exportPatientsError.set('Impossible d\'exporter la liste des patients pour le moment.');
    } finally {
      this.isExportingPatients.set(false);
    }
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private async load(search = ''): Promise<void> {
    this.patients.set(await this.api.getPatients(search, this.selectedOfficeId()));
  }
}
