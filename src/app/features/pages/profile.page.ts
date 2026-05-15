import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { UpdateMyUserProfilePayload } from '../../core/api.types';
import { ThemeMode, ThemeService } from '../../core/theme.service';
import { BsTooltipDirective } from '../../core/bs-tooltip.directive';

@Component({
  selector: 'app-profile-page',
  imports: [ReactiveFormsModule, BsTooltipDirective],
  templateUrl: './profile.page.html',
  styleUrl: './profile.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePage {
  private readonly api = inject(ApiService);
  readonly authService = inject(AuthService);
  private readonly fb = inject(FormBuilder);
  private readonly themeService = inject(ThemeService);

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly error = signal('');
  readonly success = signal('');
  readonly activeTab = signal<'securite' | 'identite' | 'pro' | 'documents' | 'compta' | 'agenda' | 'consultation' | 'interface'>(
    'identite'
  );
  readonly lockedRole = signal('');
  readonly lockedIsActive = signal(true);
  readonly lockedCabinets = signal<string[]>([]);

  readonly countryOptions = ['France', 'Belgique', 'Suisse', 'Luxembourg', 'Canada'] as const;

  readonly yearsForStatisticsOptions = [2, 3, 4, 5, 10] as const;

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

  readonly themeModeOptions = [
    { value: 'system' as const, label: 'Suivre le thème du système' },
    { value: 'light' as const, label: 'Forcer le thème clair' },
    { value: 'dark' as const, label: 'Forcer le thème sombre' }
  ];

  readonly agendaViewOptions = ['Mois', 'Semaine', '3 jours', 'Jour'] as const;

  readonly consultationOrderOptions = ['Chronologique', 'Antichronologique'] as const;

  readonly patientAutoSaveOptions = ['Jamais', 'Toutes les 2 minutes', 'Toutes les 5 minutes', 'Toutes les 10 minutes'] as const;

  readonly accountForm = this.fb.nonNullable.group({
    username: ['', [Validators.required, Validators.maxLength(100)]],
    password: ['', [Validators.maxLength(256)]],
    passwordConfirmation: ['', [Validators.maxLength(256)]],
    lastName: ['', [Validators.maxLength(100)]],
    firstName: ['', [Validators.maxLength(100)]],
    email: ['', [Validators.maxLength(150), Validators.email]],
    mobilePhone: ['', [Validators.maxLength(50)]],
    country: ['France', [Validators.maxLength(80)]],
    siret: ['', [Validators.maxLength(30)]],
    adeliCode: ['', [Validators.maxLength(40)]],
    rppsCode: ['', [Validators.maxLength(40)]],
    apeNafCode: ['', [Validators.maxLength(40)]],
    nameSuffixText: ['', [Validators.maxLength(200)]],
    letterHeader: ['', [Validators.maxLength(500)]],
    letterFooter: ['', [Validators.maxLength(500)]],
    signatureText: ['', [Validators.maxLength(2_000_000)]],
    colorHex: ['#4d92d1', [Validators.maxLength(20)]],
    bankName: ['', [Validators.maxLength(150)]],
    iban: ['', [Validators.maxLength(60)]],
    defaultAgendaView: ['Semaine', [Validators.maxLength(80)]],
    defaultYearsForStatistics: [5, [Validators.required, Validators.min(2), Validators.max(10)]],
    invoiceMentions: ['', [Validators.maxLength(2000)]],
    includeFreeConsultations: [true],
    showConsultationHour: [true]
  });

  readonly preferencesForm = this.fb.nonNullable.group({
    slotDurationMinutes: [15, [Validators.required, Validators.min(5), Validators.max(50)]],
    displayHeight: [14, [Validators.required, Validators.min(14), Validators.max(35)]],
    themeMode: ['system' as ThemeMode, [Validators.required]],
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
    if (this.authService.mustChangePassword()) {
      this.activeTab.set('securite');
    }
    void this.load();
  }

  async save(): Promise<void> {
    if (this.accountForm.invalid || this.preferencesForm.invalid) {
      this.accountForm.markAllAsTouched();
      this.preferencesForm.markAllAsTouched();
      this.error.set('Veuillez corriger les champs invalides.');
      return;
    }

    if (this.hasPasswordMismatch()) {
      this.error.set('Les mots de passe saisis ne correspondent pas.');
      return;
    }

    if (this.isSaving()) {
      return;
    }

    this.isSaving.set(true);
    this.error.set('');
    this.success.set('');

    try {
      const profilePayload = this.buildProfilePayload();
      await this.api.updateMyUserProfile(profilePayload);
      const savedPreferences = await this.api.updateMyAgendaPreferences(this.preferencesForm.getRawValue());

      this.preferencesForm.reset(savedPreferences);
      this.themeService.setThemeMode(savedPreferences.themeMode, { persist: true });
      this.accountForm.patchValue({
        password: '',
        passwordConfirmation: ''
      });

      await this.authService.refreshSession();
      this.success.set('Profil enregistré avec succès.');
    } catch {
      this.error.set('Impossible d’enregistrer votre profil.');
    } finally {
      this.isSaving.set(false);
    }
  }

  private async load(): Promise<void> {
    this.isLoading.set(true);
    this.error.set('');

    try {
      const [profile, preferences] = await Promise.all([
        this.api.getMyUserProfile(),
        this.api.getMyAgendaPreferences().catch(() => null)
      ]);

      this.lockedRole.set(profile.role || 'Inconnu');
      this.lockedIsActive.set(Boolean(profile.isActive));
      this.lockedCabinets.set(
        String(profile.cabinetName ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      );

      this.accountForm.reset({
        username: profile.username || '',
        password: '',
        passwordConfirmation: '',
        lastName: profile.lastName || '',
        firstName: profile.firstName || '',
        email: profile.email || '',
        mobilePhone: profile.mobilePhone || '',
        country: profile.country || 'France',
        siret: profile.siret || '',
        adeliCode: profile.adeliCode || '',
        rppsCode: profile.rppsCode || '',
        apeNafCode: profile.apeNafCode || '',
        nameSuffixText: profile.nameSuffixText || '',
        letterHeader: profile.letterHeader || '',
        letterFooter: profile.letterFooter || '',
        signatureText: profile.signatureText || '',
        colorHex: profile.colorHex || '#4d92d1',
        bankName: profile.bankName || '',
        iban: profile.iban || '',
        defaultAgendaView: profile.defaultAgendaView || 'Semaine',
        defaultYearsForStatistics: profile.defaultYearsForStatistics ?? 5,
        invoiceMentions: profile.invoiceMentions || '',
        includeFreeConsultations: profile.includeFreeConsultations ?? true,
        showConsultationHour: profile.showConsultationHour ?? true
      });

      if (preferences) {
        this.preferencesForm.reset(preferences);
      }
    } catch {
      this.error.set('Impossible de charger votre profil.');
    } finally {
      this.isLoading.set(false);
    }
  }

  hasPasswordMismatch(): boolean {
    const password = this.accountForm.controls.password.value.trim();
    const confirmation = this.accountForm.controls.passwordConfirmation.value.trim();

    if (!password && !confirmation) {
      return false;
    }

    return password !== confirmation;
  }

  toggleTab(tab: 'securite' | 'identite' | 'pro' | 'documents' | 'compta' | 'agenda' | 'consultation' | 'interface'): void {
    this.activeTab.set(tab);
  }

  isTabActive(tab: 'securite' | 'identite' | 'pro' | 'documents' | 'compta' | 'agenda' | 'consultation' | 'interface'): boolean {
    return this.activeTab() === tab;
  }

  onThemeModePreviewChange(value: string): void {
    if (value !== 'system' && value !== 'light' && value !== 'dark') {
      return;
    }

    this.themeService.setThemeMode(value, { persist: false });
  }

  private buildProfilePayload(): UpdateMyUserProfilePayload {
    const raw = this.accountForm.getRawValue();

    return {
      username: raw.username.trim(),
      password: raw.password.trim(),
      lastName: raw.lastName.trim(),
      firstName: raw.firstName.trim(),
      email: raw.email.trim(),
      mobilePhone: raw.mobilePhone.trim(),
      country: raw.country.trim() || 'France',
      siret: raw.siret.trim(),
      adeliCode: raw.adeliCode.trim(),
      rppsCode: raw.rppsCode.trim(),
      apeNafCode: raw.apeNafCode.trim(),
      nameSuffixText: raw.nameSuffixText.trim(),
      letterHeader: raw.letterHeader.trim(),
      letterFooter: raw.letterFooter.trim(),
      signatureText: raw.signatureText.trim(),
      colorHex: raw.colorHex.trim() || '#4d92d1',
      bankName: raw.bankName.trim(),
      iban: raw.iban.trim(),
      defaultAgendaView: raw.defaultAgendaView.trim() || 'Semaine',
      defaultYearsForStatistics: Number(raw.defaultYearsForStatistics) || 5,
      invoiceMentions: raw.invoiceMentions.trim(),
      includeFreeConsultations: raw.includeFreeConsultations,
      showConsultationHour: raw.showConsultationHour
    };
  }
}
