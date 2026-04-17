import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Patient } from '../../core/api.types';

@Component({
  selector: 'app-patients-page',
  imports: [RouterLink],
  templateUrl: './patients.page.html',
  styleUrl: './pages.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientsPage {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);

  readonly search = signal('');
  readonly patients = signal<Patient[]>([]);
  readonly canExportPatients = computed(() => this.authService.hasPermission('export-patient-list'));
  readonly isExportModalOpen = signal(false);
  readonly isExportingPatients = signal(false);
  readonly exportPatientsError = signal('');

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

  async onSearch(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement | null;
    const query = target?.value ?? '';
    this.search.set(query);
    await this.load(query);
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
          nom: patient.fullName,
          telephone: patient.phone,
          derniereVisite: patient.lastVisit,
          sexe: patient.sex,
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
    this.patients.set(await this.api.getPatients(search));
  }
}
