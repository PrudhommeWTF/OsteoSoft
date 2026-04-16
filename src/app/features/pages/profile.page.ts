import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ApiService } from '../../core/api.service';

@Component({
  selector: 'app-profile-page',
  imports: [ReactiveFormsModule],
  templateUrl: './profile.page.html',
  styleUrl: './profile.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePage {
  private readonly api = inject(ApiService);
  private readonly fb = inject(FormBuilder);

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly error = signal('');
  readonly success = signal('');

  readonly patientRemarksDisplayOptions = [
    { value: 'hidden' as const, label: 'Ne pas afficher' },
    { value: 'edit' as const, label: 'Afficher en écriture' },
    { value: 'readonly' as const, label: 'Afficher en lecture seule' }
  ];

  readonly appointmentColorModeOptions = [
    { value: 'calendar' as const, label: 'Couleur du calendrier' },
    { value: 'user' as const, label: 'Couleur de l’utilisateur' }
  ];

  readonly pdfDisplayModeOptions = [
    { value: 'browser' as const, label: 'Afficher dans le navigateur' },
    { value: 'download' as const, label: 'Télécharger directement' }
  ];

  readonly consultationOrderOptions = ['Chronologique', 'Antichronologique'] as const;

  readonly patientAutoSaveOptions = ['Jamais', 'Toutes les 2 minutes', 'Toutes les 5 minutes', 'Toutes les 10 minutes'] as const;

  readonly form = this.fb.nonNullable.group({
    slotDurationMinutes: [15, [Validators.required, Validators.min(5), Validators.max(50)]],
    displayHeight: [14, [Validators.required, Validators.min(14), Validators.max(35)]],
    pdfDisplayMode: ['browser' as 'browser' | 'download', [Validators.required]],
    consultationOrder: ['Antichronologique' as 'Chronologique' | 'Antichronologique', [Validators.required]],
    groupConsultationsByYearFrom: [10, [Validators.required, Validators.min(0), Validators.max(200)]],
    patientAutoSaveFrequency: [
      'Toutes les 2 minutes' as 'Jamais' | 'Toutes les 2 minutes' | 'Toutes les 5 minutes' | 'Toutes les 10 minutes',
      [Validators.required]
    ],
    showWeekend: [false],
    showPatientSex: [true],
    showPatientMobilePhone: [true],
    showPatientLandlinePhone: [false],
    showAppointmentComment: [true],
    patientRemarksDisplay: ['hidden' as 'hidden' | 'edit' | 'readonly', [Validators.required]],
    appointmentColorMode: ['calendar' as 'calendar' | 'user', [Validators.required]]
  });

  constructor() {
    void this.load();
  }

  async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Veuillez corriger les champs invalides.');
      return;
    }

    if (this.isSaving()) {
      return;
    }

    this.isSaving.set(true);
    this.error.set('');
    this.success.set('');

    try {
      const saved = await this.api.updateMyAgendaPreferences(this.form.getRawValue());
      this.form.reset(saved);
      this.success.set('Préférences enregistrées.');
    } catch {
      this.error.set('Impossible d’enregistrer vos préférences.');
    } finally {
      this.isSaving.set(false);
    }
  }

  private async load(): Promise<void> {
    this.isLoading.set(true);
    this.error.set('');

    try {
      const preferences = await this.api.getMyAgendaPreferences();
      this.form.reset(preferences);
    } catch {
      this.error.set('Impossible de charger vos préférences.');
    } finally {
      this.isLoading.set(false);
    }
  }
}
