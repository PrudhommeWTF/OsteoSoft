import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { SetupService } from '../../core/setup.service';
import {
  CreateOfficePayload,
  CreateSetupOfficePayload,
  OfficeConsultationProfile,
  OfficeOpeningHours,
  OfficeWeekDay,
  PaymentMethodSetting,
  ServiceTypeSetting
} from '../../core/api.types';

type OfficeCreateStep = 1 | 2 | 3 | 4 | 5 | 6;
type SetupFlowMode = 'welcome' | 'create' | 'restore';

type EditableServiceType = ServiceTypeSetting & { tempKey: string };
type EditablePaymentMethod = PaymentMethodSetting & { tempKey: string };
type EditableConsultationReason = { tempKey: string; label: string };
type EditableConsultationProfile = {
  tempKey: string;
  id: string;
  name: string;
  reasons: EditableConsultationReason[];
};

const DEFAULT_PAYMENT_REMINDER_LETTER_TITLE = 'Relance de règlement';
const DEFAULT_PAYMENT_REMINDER_LETTER_CONTENT = `{$CIVILITE},

Suite à la consultation ostéopathique du {$DATECONSULTATION}, il apparaît que la somme de {$MONTANTCONSULTATION} {$DEVISE} n'a pas été réglée à ce jour. Si ceci n'est pas une erreur de ma part, je vous prie de bien vouloir régulariser cette situation par retour de courrier.

Je vous remercie par avance, et vous prie d'agréer mes sincères salutations.`;

@Component({
  selector: 'app-installation-page',
  imports: [ReactiveFormsModule],
  templateUrl: './installation.page.html',
  styleUrl: './installation.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstallationPage {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly setupService = inject(SetupService);
  private readonly fb = inject(FormBuilder);

  private readonly adminPasswordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S{12,256}$/;

  readonly officeForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    adminPassword: ['', [Validators.required, Validators.minLength(12), Validators.maxLength(256)]],
    adminPasswordConfirmation: ['', [Validators.required, Validators.maxLength(256)]],
    defaultSessionDurationMinutes: [60, [Validators.required, Validators.min(15), Validators.max(90)]],
    country: ['France', [Validators.required, Validators.maxLength(80)]],
    devise: ['EUR' as 'EUR' | 'USD' | 'CHF' | 'GBP' | 'CAD', [Validators.required]],
    invoiceNumberFormat: [
      'AAAA-XXXXXX' as
        | 'AAAA-XXXXXX'
        | 'AAAAMM-XXXXXX'
        | 'AAAAMMJJ-XXXXXX'
        | 'AAAAMM-XXXX : RAZ mensuelle (déconseillé)'
        | 'AAAA-XXXX : RAZ annuel',
      [Validators.required]
    ],
    numberingConfiguration: [
      'Numérotation globale au cabinet' as 'Numérotation globale au cabinet' | 'Numérotation par praticien',
      [Validators.required]
    ],
    alwaysShowSocialSecurityAndMutuelle: [false],
    addressLine1: ['', [Validators.maxLength(200)]],
    addressLine2: ['', [Validators.maxLength(200)]],
    postalCode: ['', [Validators.maxLength(20)]],
    city: ['', [Validators.maxLength(100)]],
    phoneMobile: ['', [Validators.maxLength(30)]],
    phoneLandline: ['', [Validators.maxLength(30)]],
    phoneFax: ['', [Validators.maxLength(30)]],
    email: ['', [Validators.email, Validators.maxLength(200)]],
    website: ['', [Validators.maxLength(200)]],
    logoData: [''],
    openingHoursJson: ['']
  });

  readonly flowMode = signal<SetupFlowMode>('welcome');
  readonly step = signal<OfficeCreateStep>(1);
  readonly isCreating = signal(false);
  readonly isInstallingDemo = signal(false);
  readonly isRestoring = signal(false);
  readonly isRestoreDragOver = signal(false);
  readonly restoreSuccess = signal('');
  readonly restoreFileName = signal('');
  readonly error = signal('');

  readonly serviceTypes = signal<EditableServiceType[]>([]);
  readonly paymentMethods = signal<EditablePaymentMethod[]>(this.createDefaultPaymentMethods());
  readonly consultationProfiles = signal<EditableConsultationProfile[]>([]);
  readonly officeOpeningHoursDraft = signal<OfficeOpeningHours>(this.createDefaultOfficeOpeningHours());

  readonly countryOptions = ['France', 'Belgique', 'Suisse', 'Luxembourg', 'Canada'];
  readonly generalDeviseOptions = ['EUR', 'USD', 'CHF', 'GBP', 'CAD'];
  readonly invoiceNumberFormatOptions: Array<{ value: CreateSetupOfficePayload['invoiceNumberFormat']; label: string }> = [
    { value: 'AAAA-XXXXXX', label: 'Compteur continu annuel (AAAA-XXXXXX)' },
    { value: 'AAAAMM-XXXXXX', label: 'Compteur continu mensuel (AAAAMM-XXXXXX)' },
    { value: 'AAAAMMJJ-XXXXXX', label: 'Compteur continu journalier (AAAAMMJJ-XXXXXX)' },
    { value: 'AAAAMM-XXXX : RAZ mensuelle (déconseillé)', label: 'Remise a zero mensuelle (AAAAMM-XXXX)' },
    { value: 'AAAA-XXXX : RAZ annuel', label: 'Remise a zero annuelle (AAAA-XXXX)' }
  ];
  readonly numberingConfigurationOptions = [
    'Numérotation globale au cabinet',
    'Numérotation par praticien'
  ] as const;
  readonly officeWeekDays: OfficeWeekDay[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  startNewInstallation(): void {
    this.error.set('');
    this.restoreSuccess.set('');
    this.flowMode.set('create');
    this.step.set(1);
  }

  startRestore(): void {
    this.error.set('');
    this.restoreSuccess.set('');
    this.flowMode.set('restore');
  }

  backToWelcome(): void {
    this.error.set('');
    this.restoreSuccess.set('');
    this.restoreFileName.set('');
    this.isRestoreDragOver.set(false);
    this.flowMode.set('welcome');
  }

  async installDemoInstance(): Promise<void> {
    this.error.set('');
    this.restoreSuccess.set('');
    this.isInstallingDemo.set(true);

    try {
      await this.api.createSetupDemoInstance();
      this.setupService.markComplete();
      await this.router.navigateByUrl('/login');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erreur lors de l\'installation de la demonstration');
    } finally {
      this.isInstallingDemo.set(false);
    }
  }

  previousStep(): void {
    const current = this.step();
    if (current <= 1) {
      return;
    }
    this.step.set((current - 1) as OfficeCreateStep);
  }

  nextStep(): void {
    const current = this.step();
    if (!this.isStepValid(current)) {
      this.markStepTouched(current);
      return;
    }
    if (current >= 6) {
      return;
    }
    this.error.set('');
    this.step.set((current + 1) as OfficeCreateStep);
  }

  isStepValid(step: OfficeCreateStep): boolean {
    if (step === 1) {
      const raw = this.officeForm.getRawValue();
      return (
        raw.name.trim().length > 0
        && Number(raw.defaultSessionDurationMinutes) > 0
        && this.isAdminPasswordStrong(raw.adminPassword)
        && raw.adminPassword.trim() === raw.adminPasswordConfirmation.trim()
      );
    }
    if (step === 3) {
      const hasInvalidServiceType = this.serviceTypes().some((item) => !item.label.trim());
      const hasInvalidPaymentMethod = this.paymentMethods().some((item) => !item.label.trim());
      return !hasInvalidServiceType && !hasInvalidPaymentMethod;
    }
    return true;
  }

  markStepTouched(step: OfficeCreateStep): void {
    if (step === 1) {
      this.officeForm.controls.name.markAsTouched();
      this.officeForm.controls.adminPassword.markAsTouched();
      this.officeForm.controls.adminPasswordConfirmation.markAsTouched();
      this.officeForm.controls.defaultSessionDurationMinutes.markAsTouched();
      this.error.set('Renseignez un mot de passe admin robuste et confirmez-le.');
    }
  }

  adminPasswordHasLowercase(): boolean {
    return /[a-z]/.test(this.officeForm.controls.adminPassword.value);
  }

  adminPasswordHasUppercase(): boolean {
    return /[A-Z]/.test(this.officeForm.controls.adminPassword.value);
  }

  adminPasswordHasDigit(): boolean {
    return /\d/.test(this.officeForm.controls.adminPassword.value);
  }

  adminPasswordHasSpecialCharacter(): boolean {
    return /[^A-Za-z0-9]/.test(this.officeForm.controls.adminPassword.value);
  }

  adminPasswordHasMinLength(): boolean {
    return this.officeForm.controls.adminPassword.value.length >= 12;
  }

  adminPasswordMatchesConfirmation(): boolean {
    return this.officeForm.controls.adminPassword.value === this.officeForm.controls.adminPasswordConfirmation.value;
  }

  onOfficeLogoSelected(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.item(0) ?? null;
    if (!file) {
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.error.set('Le logo ne doit pas dépasser 2 Mo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.officeForm.patchValue({ logoData: reader.result as string });
    };
    reader.readAsDataURL(file);
  }

  addServiceTypeRow(): void {
    this.serviceTypes.update((items) => [
      ...items,
      {
        id: 0,
        label: `Nouvelle prestation ${items.length + 1}`,
        amountHt: 0,
        vatRate: 0,
        displayOrder: items.length + 1,
        tempKey: this.createTempKey('srv')
      }
    ]);
  }

  removeServiceType(tempKey: string): void {
    this.serviceTypes.update((items) => items.filter((item) => item.tempKey !== tempKey));
  }

  updateServiceTypeLabel(tempKey: string, value: string): void {
    this.serviceTypes.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, label: value } : item))
    );
  }

  updateServiceTypeAmount(tempKey: string, value: string): void {
    const parsed = Number(value);
    this.serviceTypes.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, amountHt: Number.isFinite(parsed) ? parsed : 0 } : item))
    );
  }

  addPaymentMethod(): void {
    this.paymentMethods.update((items) => [
      ...items,
      {
        id: 0,
        systemKey: null,
        isSystem: false,
        label: `Nouveau moyen ${items.length + 1}`,
        isActive: true,
        displayOrder: items.length + 1,
        tempKey: this.createTempKey('pay')
      }
    ]);
  }

  removePaymentMethod(tempKey: string): void {
    this.paymentMethods.update((items) => {
      const target = items.find((item) => item.tempKey === tempKey);
      if (target?.isSystem) {
        return items;
      }
      return items.filter((item) => item.tempKey !== tempKey);
    });
  }

  togglePaymentMethodActive(tempKey: string): void {
    this.paymentMethods.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, isActive: !item.isActive } : item))
    );
  }

  updatePaymentMethodLabel(tempKey: string, value: string): void {
    this.paymentMethods.update((items) =>
      items.map((item) => {
        if (item.tempKey !== tempKey || item.isSystem) {
          return item;
        }
        return { ...item, label: value };
      })
    );
  }

  officeDayLabel(day: OfficeWeekDay): string {
    const labels: Record<OfficeWeekDay, string> = {
      monday: 'Lundi',
      tuesday: 'Mardi',
      wednesday: 'Mercredi',
      thursday: 'Jeudi',
      friday: 'Vendredi',
      saturday: 'Samedi',
      sunday: 'Dimanche'
    };
    return labels[day];
  }

  addOfficeOpeningRange(day: OfficeWeekDay): void {
    const draft = this.officeOpeningHoursDraft();
    const nextRanges = [...(draft[day] ?? []), { start: '09:00', end: '12:00' }];
    this.officeOpeningHoursDraft.set({ ...draft, [day]: nextRanges });
  }

  removeOfficeOpeningRange(day: OfficeWeekDay, index: number): void {
    const draft = this.officeOpeningHoursDraft();
    const dayRanges = draft[day] ?? [];
    if (index < 0 || index >= dayRanges.length) {
      return;
    }
    this.officeOpeningHoursDraft.set({ ...draft, [day]: dayRanges.filter((_, i) => i !== index) });
  }

  updateOfficeOpeningRange(day: OfficeWeekDay, index: number, field: 'start' | 'end', value: string): void {
    const draft = this.officeOpeningHoursDraft();
    const dayRanges = draft[day] ?? [];
    if (index < 0 || index >= dayRanges.length) {
      return;
    }
    const nextRanges = dayRanges.map((range, i) => (i === index ? { ...range, [field]: value } : range));
    this.officeOpeningHoursDraft.set({ ...draft, [day]: nextRanges });
  }

  addConsultationProfile(): void {
    this.consultationProfiles.update((profiles) => [
      ...profiles,
      {
        tempKey: this.createTempKey('profile'),
        id: this.createTempKey('profile-id'),
        name: `Profil ${profiles.length + 1}`,
        reasons: []
      }
    ]);
  }

  removeConsultationProfile(profileTempKey: string): void {
    this.consultationProfiles.update((profiles) =>
      profiles.filter((profile) => profile.tempKey !== profileTempKey)
    );
  }

  updateConsultationProfileName(profileTempKey: string, value: string): void {
    this.consultationProfiles.update((profiles) =>
      profiles.map((profile) =>
        profile.tempKey === profileTempKey ? { ...profile, name: value } : profile
      )
    );
  }

  addConsultationReason(profileTempKey: string): void {
    this.consultationProfiles.update((profiles) =>
      profiles.map((profile) => {
        if (profile.tempKey !== profileTempKey) {
          return profile;
        }
        return {
          ...profile,
          reasons: [
            ...profile.reasons,
            { tempKey: this.createTempKey('reason'), label: `Motif ${profile.reasons.length + 1}` }
          ]
        };
      })
    );
  }

  removeConsultationReason(profileTempKey: string, reasonTempKey: string): void {
    this.consultationProfiles.update((profiles) =>
      profiles.map((profile) => {
        if (profile.tempKey !== profileTempKey) {
          return profile;
        }
        return { ...profile, reasons: profile.reasons.filter((r) => r.tempKey !== reasonTempKey) };
      })
    );
  }

  updateConsultationReasonLabel(profileTempKey: string, reasonTempKey: string, value: string): void {
    this.consultationProfiles.update((profiles) =>
      profiles.map((profile) => {
        if (profile.tempKey !== profileTempKey) {
          return profile;
        }
        return {
          ...profile,
          reasons: profile.reasons.map((r) =>
            r.tempKey === reasonTempKey ? { ...r, label: value } : r
          )
        };
      })
    );
  }

  onConsultationReasonDragStart(event: DragEvent, profileTempKey: string, reasonTempKey: string): void {
    if (!event.dataTransfer) {
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${profileTempKey}|${reasonTempKey}`);
  }

  onConsultationReasonDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onConsultationReasonDrop(event: DragEvent, profileTempKey: string, targetReasonTempKey: string): void {
    event.preventDefault();
    const payload = event.dataTransfer?.getData('text/plain') ?? '';
    const [sourceProfileTempKey, sourceReasonTempKey] = payload.split('|');
    if (!sourceProfileTempKey || !sourceReasonTempKey || sourceProfileTempKey !== profileTempKey) {
      return;
    }
    this.consultationProfiles.update((profiles) =>
      profiles.map((profile) => {
        if (profile.tempKey !== profileTempKey) {
          return profile;
        }
        const items = profile.reasons;
        const fromIndex = items.findIndex((r) => r.tempKey === sourceReasonTempKey);
        const toIndex = items.findIndex((r) => r.tempKey === targetReasonTempKey);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
          return profile;
        }
        const next = [...items];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return { ...profile, reasons: next };
      })
    );
  }

  async createOffice(): Promise<void> {
    if (!this.isStepValid(6) || this.officeForm.controls.name.value.trim().length === 0) {
      this.error.set('Renseignez les informations obligatoires, dont un mot de passe admin robuste.');
      return;
    }

    const hasInvalidServiceType = this.serviceTypes().some((item) => !item.label.trim());
    const hasInvalidPaymentMethod = this.paymentMethods().some((item) => !item.label.trim());
    if (hasInvalidServiceType || hasInvalidPaymentMethod) {
      this.error.set('Les libellés des prestations et moyens de paiement sont obligatoires.');
      return;
    }

    this.isCreating.set(true);
    this.error.set('');

    try {
      await this.api.createSetupOffice(this.buildPayload());
      this.setupService.markComplete();
      await this.router.navigateByUrl('/login');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erreur lors de la création du cabinet');
    } finally {
      this.isCreating.set(false);
    }
  }

  async onRestoreFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.item(0) ?? null;
    if (!file) {
      return;
    }

    await this.restoreFromBackupFile(file);
    if (input) {
      input.value = '';
    }
  }

  onRestoreDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isRestoreDragOver.set(true);
  }

  onRestoreDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isRestoreDragOver.set(false);
  }

  async onRestoreDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isRestoreDragOver.set(false);

    const file = event.dataTransfer?.files?.item(0) ?? null;
    if (!file) {
      return;
    }

    await this.restoreFromBackupFile(file);
  }

  private async restoreFromBackupFile(file: File): Promise<void> {
    this.error.set('');
    this.restoreSuccess.set('');
    this.restoreFileName.set(file.name);
    this.isRestoring.set(true);

    try {
      const payload = await this.readBackupPayloadFromFile(file);
      await this.api.restoreSetupBackup(payload);
      this.setupService.invalidate();
      const requiresSetup = await this.setupService.ensureChecked();

      if (requiresSetup) {
        this.restoreSuccess.set('La sauvegarde a ete importee. Vous pouvez maintenant creer le premier cabinet.');
        this.flowMode.set('create');
        this.step.set(1);
        return;
      }

      this.setupService.markComplete();
      this.restoreSuccess.set('Sauvegarde restauree avec succes. Redirection vers la connexion...');
      await this.router.navigateByUrl('/login');
    } catch {
      this.error.set('La restauration a echoue. Verifiez le fichier de sauvegarde.');
    } finally {
      this.isRestoring.set(false);
    }
  }

  private async readBackupPayloadFromFile(file: File): Promise<unknown> {
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.json')) {
      return JSON.parse(await file.text());
    }

    if (!fileName.endsWith('.zip')) {
      throw new Error('Unsupported backup format');
    }

    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const manifestText = await zip.file('manifest.json')?.async('string');
    const dataText = await zip.file('data.json')?.async('string');
    const metaText = await zip.file('meta.json')?.async('string');

    if (!manifestText || !dataText) {
      throw new Error('Archive incomplete');
    }

    return {
      manifest: JSON.parse(manifestText),
      data: JSON.parse(dataText),
      ...(metaText ? { meta: JSON.parse(metaText) } : {})
    };
  }

  private buildPayload(): CreateSetupOfficePayload {
    const raw = this.officeForm.getRawValue();
    return {
      name: raw.name.trim(),
      adminPassword: raw.adminPassword.trim(),
      defaultSessionDurationMinutes: Number(raw.defaultSessionDurationMinutes) || 60,
      country: raw.country.trim(),
      devise: raw.devise,
      invoiceNumberFormat: raw.invoiceNumberFormat,
      numberingConfiguration: raw.numberingConfiguration,
      alwaysShowSocialSecurityAndMutuelle: raw.alwaysShowSocialSecurityAndMutuelle,
      hideVatMention: false,
      addressLine1: raw.addressLine1.trim(),
      addressLine2: raw.addressLine2.trim(),
      postalCode: raw.postalCode.trim(),
      city: raw.city.trim(),
      phoneMobile: raw.phoneMobile.trim(),
      phoneLandline: raw.phoneLandline.trim(),
      phoneFax: raw.phoneFax.trim(),
      email: raw.email.trim(),
      website: raw.website.trim(),
      vatNumber: '',
      logoData: raw.logoData.trim(),
      paymentReminderLetterTemplate: {
        title: DEFAULT_PAYMENT_REMINDER_LETTER_TITLE,
        content: DEFAULT_PAYMENT_REMINDER_LETTER_CONTENT
      },
      patientLetterTemplates: [],
      invoiceTemplateLayoutJson: '{}',
      openingHours: this.officeOpeningHoursDraft(),
      consultationProfiles: this.toOfficeConsultationProfiles(),
      officeUserDelegations: [],
      serviceTypes: this.serviceTypes().map((item, index) => ({
        id: null,
        label: item.label.trim(),
        amountHt: Number(item.amountHt) || 0,
        vatRate: 0,
        displayOrder: index + 1
      })),
      paymentMethods: this.paymentMethods().map((item, index) => ({
        id: null,
        label: item.label.trim(),
        isActive: item.isActive,
        displayOrder: index + 1
      }))
    };
  }

  private isAdminPasswordStrong(password: string): boolean {
    return this.adminPasswordPattern.test(String(password ?? '').trim());
  }

  private toOfficeConsultationProfiles(): OfficeConsultationProfile[] {
    return this.consultationProfiles()
      .map((profile, index) => ({
        id: profile.id,
        name: profile.name.trim() || `Profil ${index + 1}`,
        reasons: profile.reasons.map((r) => r.label.trim()).filter((r) => r.length > 0),
        displayOrder: index + 1
      }))
      .filter((profile) => profile.name.length > 0);
  }

  private createDefaultOfficeOpeningHours(): OfficeOpeningHours {
    return { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
  }

  private createDefaultPaymentMethods(): EditablePaymentMethod[] {
    return [
      { id: 0, systemKey: 'cb', isSystem: true, label: 'Carte bleue (CB)', isActive: true, displayOrder: 1, tempKey: this.createTempKey('pay') },
      { id: 0, systemKey: 'especes', isSystem: true, label: 'Espèces', isActive: true, displayOrder: 2, tempKey: this.createTempKey('pay') },
      { id: 0, systemKey: 'cheque', isSystem: true, label: 'Chèque', isActive: true, displayOrder: 3, tempKey: this.createTempKey('pay') }
    ];
  }

  private createTempKey(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
