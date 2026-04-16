import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
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

  readonly search = signal('');
  readonly patients = signal<Patient[]>([]);

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

  private async load(search = ''): Promise<void> {
    this.patients.set(await this.api.getPatients(search));
  }
}
