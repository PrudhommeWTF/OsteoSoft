import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import {
  AccessManagedUser,
  AgendaSettingsPayload,
  AuthUser,
  CreateOfficePayload,
  GeneralSettingsPayload,
  LocalAgendaCalendar,
  NewOfficeDraft,
  Office,
  OfficeConsultationProfile,
  OfficeOpeningHours,
  OfficeWeekDay,
  Patient,
  PaymentMethodSetting,
  ServiceTypeSetting,
  SystemAuditLog,
  UserAccountPayload
} from '../../core/api.types';

type SettingsSectionId =
  | 'data-management'
  | 'audit-logs'
  | 'user-management'
  | 'roles-and-access'
  | 'offices';

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  icon: string;
  summary: string;
  description: string;
  items: string[];
};

type AccessDomain = {
  id:
    | 'patient-record'
    | 'patients-list'
    | 'agenda'
    | 'billing'
    | 'statistics'
    | 'contact-directory';
  label: string;
  icon: string;
  description: string;
  permissions: Array<{ id: string; label: string }>;
  impactedProfiles: string[];
};

type AccessDomainId = AccessDomain['id'];

type AccessProfile = {
  id: string;
  label: string;
  description: string;
  immutable?: boolean;
  rights: Record<AccessDomainId, Record<string, boolean>>;
};

type EditableServiceType = ServiceTypeSetting & {
  tempKey: string;
};

type EditablePaymentMethod = PaymentMethodSetting & {
  tempKey: string;
};

type EditableLocalCalendar = LocalAgendaCalendar & {
  tempKey: string;
};

type EditableConsultationReason = {
  tempKey: string;
  label: string;
};

type EditableConsultationProfile = {
  tempKey: string;
  id: string;
  name: string;
  reasons: EditableConsultationReason[];
};

type EditableOfficeUserDelegation = {
  tempKey: string;
  userId: number | null;
  profileId: string;
};

type OfficeModalTabId =
  | 'general'
  | 'contact-details'
  | 'billing'
  | 'opening-hours'
  | 'agendas'
  | 'users-profiles'
  | 'consultation-reasons'
  | 'patient-letters';

type OfficeCreateStep = 1 | 2 | 3 | 4 | 5 | 6;
type DraftSaveState = 'idle' | 'saving' | 'saved' | 'error';
type UserModalTabId = 'application-rights' | 'cabinet-rights' | 'identity' | 'professional' | 'billing';

@Component({
  selector: 'app-settings-page',
  imports: [ReactiveFormsModule],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPage implements OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);

  readonly accessDomains: AccessDomain[] = [
    {
      id: 'patient-record',
      label: 'Fiche patient',
      icon: 'fa-solid fa-id-card',
      description: 'Accès au détail du dossier patient, à la consultation de l’historique clinique et aux informations administratives.',
      permissions: [
        { id: 'read-patient-record', label: 'Accéder aux fiches patients existantes' },
        { id: 'create-patient-record', label: 'Créer une nouvelle fiche patient' },
        { id: 'delete-patient-record', label: 'Supprimer une fiche patient' },
        { id: 'export-patient-record', label: 'Exporter une fiche patient en PDF' },
        { id: 'create-consultation', label: 'Créer une nouvelle consultation' },
        { id: 'read-consultation-detail', label: 'Afficher le détail d\'une consultation existante' },
        { id: 'choose-consultation-author', label: 'Choisir le créateur d\'une consultation' },
        { id: 'read-protected-patient-record', label: 'Accéder aux fiches patients protégées' },
        { id: 'protect-patient-record', label: 'Protéger l\'accès à une fiche patient' },
        { id: 'invoice-consultation', label: 'Facturer une consultation' },
        { id: 'cancel-invoice', label: 'Annuler une facture' }
      ],
      impactedProfiles: ['Administrateur', 'Praticien', 'Assistant']
    },
    {
      id: 'patients-list',
      label: 'Listing Patients',
      icon: 'fa-solid fa-list-ul',
      description: 'Visibilité de la liste des patients, recherche rapide et navigation vers les dossiers individuels.',
      permissions: [
        { id: 'read-patient-list', label: 'Voir la liste des patients' },
        { id: 'search-patient-list', label: 'Rechercher et filtrer' },
        { id: 'export-patient-list', label: 'Exporter la liste des patients' }
      ],
      impactedProfiles: ['Administrateur', 'Praticien', 'Secrétariat']
    },
    {
      id: 'agenda',
      label: 'Agenda',
      icon: 'fa-solid fa-calendar-days',
      description: 'Gestion du planning, des rendez-vous, des créneaux et des statuts de consultation.',
      permissions: [
        { id: 'read-agenda', label: 'Consulter l\'agenda' },
        { id: 'create-appointment', label: 'Créer un rendez-vous' },
        { id: 'edit-appointment', label: 'Déplacer ou modifier un rendez-vous' },
        { id: 'delete-appointment', label: 'Supprimer un rendez-vous' },
        { id: 'export-agenda', label: 'Exporter les données de l\'agenda' }
      ],
      impactedProfiles: ['Administrateur', 'Praticien', 'Secrétariat']
    },
    {
      id: 'billing',
      label: 'Comptabilité',
      icon: 'fa-solid fa-file-invoice-dollar',
      description: 'Accès aux factures, aux paiements, aux relances et aux exports comptables.',
      permissions: [
        { id: 'read-billing-kpis', label: 'Voir les indicateurs financiers' },
        { id: 'create-invoice', label: 'Créer une facture' },
        { id: 'mark-payment', label: 'Enregistrer un paiement' },
        { id: 'export-billing', label: 'Exporter les données comptables' }
      ],
      impactedProfiles: ['Administrateur', 'Comptabilité']
    },
    {
      id: 'statistics',
      label: 'Statistiques',
      icon: 'fa-solid fa-chart-column',
      description: 'Consultation des tableaux de bord, indicateurs d’activité et analyses de fréquentation.',
      permissions: [
        { id: 'read-dashboard', label: 'Voir les tableaux de bord' },
        { id: 'read-advanced-statistics', label: 'Accéder aux statistiques avancées' },
        { id: 'export-statistics', label: 'Exporter les statistiques' }
      ],
      impactedProfiles: ['Administrateur', 'Direction', 'Praticien référent']
    },
    {
      id: 'contact-directory',
      label: 'Répertoire de contacts',
      icon: 'fa-solid fa-address-book',
      description: 'Gestion des contacts externes et correspondants du cabinet utilisés dans les échanges métier.',
      permissions: [
        { id: 'read-directory', label: 'Consulter le répertoire' },
        { id: 'create-directory-contact', label: 'Ajouter un contact' },
        { id: 'edit-directory-contact', label: 'Modifier un contact' },
        { id: 'delete-directory-contact', label: 'Supprimer un contact' },
        { id: 'export-directory', label: 'Exporter le répertoire' }
      ],
      impactedProfiles: ['Administrateur', 'Praticien', 'Secrétariat']
    }
  ];

  readonly profileForm = this.fb.nonNullable.group({
    label: ['', [Validators.required, Validators.maxLength(80)]],
    description: ['', [Validators.maxLength(160)]]
  });



  readonly serviceTypeForm = this.fb.nonNullable.group({
    label: ['', [Validators.required, Validators.maxLength(120)]],
    amountHt: [0, [Validators.required, Validators.min(0), Validators.max(1_000_000)]],
    vatRate: [0, [Validators.required, Validators.min(0), Validators.max(100)]]
  });

  readonly officeDelegationForm = this.fb.nonNullable.group({
    userId: [0, [Validators.required, Validators.min(1)]],
    profileId: ['super-admin', [Validators.required]]
  });

  readonly userForm = this.fb.nonNullable.group({
    isActive: [true],
    profileId: ['super-admin', [Validators.required]],
    role: ['practitioner', [Validators.required, Validators.maxLength(40)]],
    officeId: [0, [Validators.min(0)]],
    username: ['', [Validators.required, Validators.maxLength(100)]],
    password: ['', [Validators.maxLength(256)]],
    confirmPassword: ['', [Validators.maxLength(256)]],
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

  readonly officeForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    defaultSessionDurationMinutes: [60, [Validators.required, Validators.min(15), Validators.max(90)]],
    country: ['France', [Validators.required, Validators.maxLength(80)]],
    devise: ['EUR', [Validators.required]],
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
    hideVatMention: [false],
    addressLine1: ['', [Validators.maxLength(200)]],
    addressLine2: ['', [Validators.maxLength(200)]],
    postalCode: ['', [Validators.maxLength(20)]],
    city: ['', [Validators.maxLength(100)]],
    phoneMobile: ['', [Validators.maxLength(30)]],
    phoneLandline: ['', [Validators.maxLength(30)]],
    phoneFax: ['', [Validators.maxLength(30)]],
    email: ['', [Validators.email]],
    website: ['', [Validators.maxLength(200)]],
    vatNumber: ['', [Validators.maxLength(30)]],
    logoData: [''],
    openingHoursJson: ['']
  });

  readonly agendaSettingsForm = this.fb.nonNullable.group({
    lunchStartHour: [12, [Validators.required, Validators.min(0), Validators.max(23)]],
    lunchEndHour: [13, [Validators.required, Validators.min(1), Validators.max(24)]],
    defaultSessionDurationMinutes: [60, [Validators.required, Validators.min(15), Validators.max(90)]],
    slotDurationMinutes: [15, [Validators.required, Validators.min(5), Validators.max(50)]],
    displayHeight: [14, [Validators.required, Validators.min(14), Validators.max(35)]],
    autoConsultationType: [false]
  });

  readonly localCalendarForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    description: ['', [Validators.maxLength(300)]],
    colorHex: ['#4d92d1', [Validators.pattern(/^#[0-9a-fA-F]{6}$/)]],
    visibility: ['all' as 'all' | 'selected', [Validators.required]]
  });

  readonly profileFormError = signal('');
  readonly profileLinkError = signal('');
  readonly profileLinkSuccess = signal('');
  readonly rightsSaveError = signal('');
  readonly isProfilesLoading = signal(false);
  readonly isCreatingProfile = signal(false);
  readonly isSavingRights = signal(false);
  readonly isSavingCurrentUserProfile = signal(false);
  readonly isDownloadingBackup = signal(false);
  readonly isRestoringBackup = signal(false);
  readonly isSearchingRgpdPatients = signal(false);
  readonly isExportingRgpdPatient = signal(false);
  readonly isAuditLogsLoading = signal(false);
  readonly isUsersLoading = signal(false);
  readonly isSavingUserProfile = signal(false);
  readonly isCreatingUserAccount = signal(false);
  readonly isSavingUserAccount = signal(false);
  readonly isCreatingUserMode = signal(false);
  readonly isUserModalOpen = signal(false);
  readonly userModalTab = signal<UserModalTabId>('identity');
  readonly deletingUserId = signal<number | null>(null);
  readonly userProfileLinkError = signal('');
  readonly userProfileLinkSuccess = signal('');
  readonly userSignatureError = signal('');
  readonly dataManagementError = signal('');
  readonly dataManagementSuccess = signal('');
  readonly auditLogsError = signal('');
  readonly backupReminderError = signal('');
  readonly backupReminderSuccess = signal('');
  readonly selectedBackupFileName = signal('');
  readonly selectedAuditLogLimit = signal(100);
  readonly isServiceTypeModalOpen = signal(false);
  readonly isOfficeDelegationModalOpen = signal(false);
  readonly officeDelegationModalError = signal('');
  readonly showRgpdPatientPicker = signal(false);
  readonly rgpdPatientSearch = signal('');
  readonly rgpdSearchResults = signal<Patient[]>([]);
  readonly selectedRgpdPatient = signal<Patient | null>(null);
  readonly selectedUserSignatureFileName = signal('');
  readonly expandedAccordionId = signal<string | null>('general-root');
  readonly userSignatureValue = signal('');
  readonly selectedUserOfficeIds = signal<number[]>([]);
  readonly auditLogs = signal<SystemAuditLog[]>([]);
  readonly offices = signal<Office[]>([]);
  readonly isOfficesLoading = signal(false);
  readonly isCreatingOffice = signal(false);
  readonly isUpdatingOffice = signal<number | null>(null);
  readonly isDeletingOffice = signal<number | null>(null);
  readonly officesError = signal('');
  readonly officesSuccess = signal('');
  readonly isOfficeModalOpen = signal(false);
  readonly editingOfficeId = signal<number | null>(null);
  readonly officeModalTab = signal<OfficeModalTabId>('general');
  readonly officeCreateStep = signal<OfficeCreateStep>(1);
  readonly officeDraftSaveState = signal<DraftSaveState>('idle');
  readonly lastOfficeDraftSavedAt = signal<number | null>(null);
  readonly officeDraftStatusNowTick = signal(Date.now());
  readonly officeConfigTargetId = signal<number | null>(null);
  readonly officeOpeningHoursDraft = signal<OfficeOpeningHours>(this.createDefaultOfficeOpeningHours());
  readonly serviceTypes = signal<EditableServiceType[]>([]);
  readonly paymentMethods = signal<EditablePaymentMethod[]>([]);
  readonly consultationProfiles = signal<EditableConsultationProfile[]>([]);
  readonly officeUserDelegations = signal<EditableOfficeUserDelegation[]>([]);
  readonly localCalendars = signal<EditableLocalCalendar[]>([]);
  readonly isAgendaSettingsLoading = signal(false);
  readonly isSavingAgendaSettings = signal(false);
  readonly agendaSettingsError = signal('');
  readonly agendaSettingsSuccess = signal('');
  readonly isLocalCalendarModalOpen = signal(false);
  readonly editingLocalCalendarTempKey = signal<string | null>(null);
  readonly localCalendarModalOfficeId = signal<number | null>(null);
  readonly localCalendarModalSelectedUserIds = signal<number[]>([]);

  readonly currentUser = signal<AuthUser | null>(null);
  readonly users = signal<AccessManagedUser[]>([]);
  readonly selectedUserId = signal<number | null>(null);
  readonly selectedUserProfileId = signal('');
  readonly selectedBackupPayload = signal<unknown | null>(null);

  readonly agendaViewOptions = ['Semaine', 'Jour', 'Mois'];
  readonly calendarOptions = ['Tous les calendriers', 'Calendrier personnel'];
  readonly calendarVisibilityOptions = [
    { value: 'all' as const, label: 'Tout le monde' },
    { value: 'selected' as const, label: 'Comptes sélectionnés' }
  ];
  readonly patientRemarksDisplayOptions = [
    { value: 'hidden' as const, label: 'Ne pas afficher' },
    { value: 'edit' as const, label: 'Afficher en écriture' },
    { value: 'readonly' as const, label: 'Afficher en lecture seule' }
  ];
  readonly appointmentColorModeOptions = [
    { value: 'calendar' as const, label: 'Couleur du calendrier' },
    { value: 'user' as const, label: 'Couleur de l\'utilisateur' }
  ];
  readonly countryOptions = ['France', 'Belgique', 'Suisse', 'Luxembourg', 'Canada'];
  readonly auditLogLimitOptions = [50, 100, 200, 500];
  readonly generalDeviseOptions = ['EUR', 'USD', 'CHF', 'GBP', 'CAD'];
  readonly backupReminderOptions = ['Toutes les semaines', 'Tous les 15 jours', 'Tous les mois', 'Tous les 2 mois'] as const;
  readonly invoiceNumberFormatOptions = [
    'AAAA-XXXXXX',
    'AAAAMM-XXXXXX',
    'AAAAMMJJ-XXXXXX',
    'AAAAMM-XXXX : RAZ mensuelle (déconseillé)',
    'AAAA-XXXX : RAZ annuel'
  ] as const;
  readonly numberingConfigurationOptions = ['Numérotation globale au cabinet', 'Numérotation par praticien'] as const;
  readonly vatRateOptions = [0, 5.5, 10, 20];
  readonly officeWeekDays: OfficeWeekDay[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  readonly serviceTypeLabels = computed(() => this.serviceTypes().map((item) => item.label));
  readonly isCreatingOfficeMode = computed(() => this.isOfficeModalOpen() && !this.editingOfficeId());

  readonly officeDraftStatusText = computed(() => {
    this.officeDraftStatusNowTick();

    const state = this.officeDraftSaveState();
    if (state === 'saving') {
      return 'Sauvegarde du brouillon en cours...';
    }
    if (state === 'error') {
      return 'Echec de la sauvegarde automatique du brouillon';
    }

    const savedAt = this.lastOfficeDraftSavedAt();
    if (!savedAt) {
      return 'Aucun brouillon enregistre';
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
    if (elapsedSeconds < 5) {
      return 'Brouillon enregistre a l\'instant';
    }
    if (elapsedSeconds < 60) {
      return `Brouillon enregistre il y a ${elapsedSeconds}s`;
    }

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
      return `Brouillon enregistre il y a ${elapsedMinutes} min`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    return `Brouillon enregistre il y a ${elapsedHours} h`;
  });

  private readonly superAdminId = 'super-admin';
  private rightsPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private rgpdSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private rgpdSearchRequestId = 0;
  private officeDraftAutosaveTimer: ReturnType<typeof setInterval> | null = null;
  private officeDraftStatusTimer: ReturnType<typeof setInterval> | null = null;
  private isPersistingOfficeDraft = false;
  private pendingOfficeDraftSave = false;

  readonly profiles = signal<AccessProfile[]>([
    {
      id: this.superAdminId,
      label: 'Super Administrateur',
      description: 'Profil système avec tous les droits activés par défaut.',
      immutable: true,
      rights: this.buildRights(true)
    }
  ]);

  readonly selectedProfileId = signal(this.superAdminId);
  readonly currentUserProfileId = signal(this.superAdminId);

  readonly selectedProfile = computed(() => {
    return this.profiles().find((profile) => profile.id === this.selectedProfileId()) ?? this.profiles()[0];
  });

  constructor() {
    void this.loadAccessProfiles();
    void this.loadCurrentUser();
    void this.loadUsers();
  }

  ngOnDestroy(): void {
    this.stopOfficeDraftAutosave();
  }

  previousOfficeCreateStep(): void {
    const current = this.officeCreateStep();
    if (current <= 1) {
      return;
    }

    this.officeCreateStep.set((current - 1) as OfficeCreateStep);
  }

  async nextOfficeCreateStep(): Promise<void> {
    const current = this.officeCreateStep();
    if (!this.isOfficeCreateStepValid(current)) {
      this.markOfficeCreateStepTouched(current);
      return;
    }

    if (current >= 6) {
      return;
    }

    await this.persistOfficeDraft();
    this.officeCreateStep.set((current + 1) as OfficeCreateStep);
  }

  readonly sections: SettingsSection[] = [
    {
      id: 'data-management',
      label: 'Gestion des données',
      icon: 'fa-solid fa-database',
      summary: 'Sauvegardes, exports, imports et conservation des données applicatives.',
      description: 'Centralisez ici tous les outils liés au cycle de vie des données du cabinet.',
      items: [
        'Sauvegarde et restauration de la base',
        'Export RGPD et archivage',
        'Import de données de test ou de reprise'
      ]
    },
    {
      id: 'user-management',
      label: 'Gestion des utilisateurs',
      icon: 'fa-solid fa-users-gear',
      summary: 'Création, activation, désactivation et suivi des comptes praticiens.',
      description: 'Cette section pilotera les comptes de connexion et leur état dans l’application.',
      items: [
        'Liste des utilisateurs actifs',
        'Création et suspension de comptes',
        'Réinitialisation d’accès'
      ]
    },
    {
      id: 'roles-and-access',
      label: 'Gestion des profils et des droits d\'accès',
      icon: 'fa-solid fa-user-shield',
      summary: 'Définition des rôles, habilitations et droits par module.',
      description: 'Préparez ici la matrice d’autorisations pour les écrans et actions sensibles.',
      items: [
        'Profils standards et personnalisés',
        'Droits de lecture, modification et export',
        'Affectation des profils aux utilisateurs'
      ]
    },
    {
      id: 'offices',
      label: 'Gestion des cabinets',
      icon: 'fa-solid fa-building',
      summary: 'Lieux de soins où travaillent les praticiens et consultent les patients.',
      description: 'Gérez ici les cabinets et leurs coordonnées pour la facturation et correspondance.',
      items: [
        'Liste des cabinets',
        'Coordonnées et contacts',
        'Logo et identité visuelle'
      ]
    },
    {
      id: 'audit-logs',
      label: 'Traçabilité',
      icon: 'fa-solid fa-clipboard-list',
      summary: 'Journal des actions sensibles réalisées dans l’application.',
      description: 'Consultez ici les événements d’audit pour suivre les créations, modifications et suppressions.',
      items: ['Historique des actions', 'Filtrage des derniers événements', 'Suivi des opérations sensibles']
    }
  ];

  readonly activeSectionId = signal<SettingsSectionId>('data-management');

  readonly activeSection = computed(
    () => this.sections.find((section) => section.id === this.activeSectionId()) ?? this.sections[0]
  );

  readonly isUserSignatureImage = computed(() => this.userSignatureValue().startsWith('data:image/'));

  readonly userCabinetOptions = computed(() => {
    return this.offices()
      .map((office) => ({ id: office.id, name: office.name.trim() }))
      .filter((office) => !!office.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  });

  readonly agendaUserVisibilityOptions = computed(() => {
    return this.users()
      .filter((user) => user.isActive)
      .map((user) => ({
        id: user.id,
        label: this.getUserDisplayName(user)
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  });

  readonly officeCalendars = computed(() => {
    const officeId = this.editingOfficeId();
    if (!officeId) {
      return [] as EditableLocalCalendar[];
    }

    return this.localCalendars()
      .filter((calendar) => calendar.officeId === officeId)
      .sort((a, b) => a.displayOrder - b.displayOrder);
  });

  readonly officeDelegationUserOptions = computed(() => {
    const officeId = this.editingOfficeId();
    if (!officeId) {
      return [] as Array<{ id: number; label: string }>;
    }

    const linkedUsers = this.users().filter((user) => {
      const linkedOfficeIds = Array.isArray(user.officeIds)
        ? user.officeIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
        : [];
      const legacyOfficeId = user.officeId != null ? Number(user.officeId) : null;
      return linkedOfficeIds.includes(officeId) || legacyOfficeId === officeId;
    });

    const sourceUsers = linkedUsers.length > 0
      ? linkedUsers
      : this.users().filter((user) => user.isActive);

    return sourceUsers
      .map((user) => ({
        id: user.id,
        label: this.getUserDisplayName(user)
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  });

  readonly officeDelegationProfileOptions = computed(() => {
    return this.profiles()
      .map((profile) => ({
        id: profile.id,
        label: profile.label
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  });

  readonly selectedEditableUser = computed(() => {
    const userId = this.selectedUserId();
    if (!userId) {
      return null;
    }

    return this.users().find((user) => user.id === userId) ?? null;
  });

  readonly isEditingAdminUser = computed(() => {
    const selectedUser = this.selectedEditableUser();
    return Boolean(selectedUser && selectedUser.username === 'admin');
  });

  readonly selectedUserCabinetDelegations = computed(() => {
    const userId = this.selectedUserId();
    if (!userId) {
      return [] as Array<{
        officeId: number;
        officeName: string;
        profileId: string | null;
        profileLabel: string;
        isConfigured: boolean;
      }>;
    }

    const selectedOfficeIds = [...new Set(
      this.selectedUserOfficeIds()
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )];

    if (selectedOfficeIds.length === 0) {
      return [];
    }

    return selectedOfficeIds
      .map((officeId) => {
        const office = this.offices().find((item) => item.id === officeId);
        const officeName = office?.name?.trim() || `Cabinet #${officeId}`;
        const delegation = office?.officeUserDelegations.find((item) => Number(item.userId) === userId) ?? null;

        if (!delegation) {
          return {
            officeId,
            officeName,
            profileId: null,
            profileLabel: 'Aucun profil cabinet defini',
            isConfigured: false
          };
        }

        return {
          officeId,
          officeName,
          profileId: delegation.profileId,
          profileLabel: delegation.profileLabel || delegation.profileId,
          isConfigured: true
        };
      })
      .sort((a, b) => a.officeName.localeCompare(b.officeName, 'fr'));
  });

  selectSection(sectionId: SettingsSectionId): void {
    this.activeSectionId.set(sectionId);

    if (sectionId === 'user-management' && this.users().length === 0) {
      void this.loadUsers();
    }

    if (sectionId === 'user-management' && this.offices().length === 0 && !this.isOfficesLoading()) {
      void this.loadOffices();
    }



    if (sectionId === 'offices' && this.offices().length === 0 && !this.isOfficesLoading()) {
      void this.loadOffices();
    }

    if (sectionId === 'audit-logs' && this.auditLogs().length === 0 && !this.isAuditLogsLoading()) {
      void this.loadAuditLogs();
    }
  }

  onAuditLogLimitChange(value: string): void {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return;
    }

    this.selectedAuditLogLimit.set(parsed);
    void this.loadAuditLogs();
  }

  refreshAuditLogs(): void {
    void this.loadAuditLogs();
  }

  toggleAccordion(accordionId: string): void {
    const currentExpanded = this.expandedAccordionId();
    this.expandedAccordionId.set(currentExpanded === accordionId ? null : accordionId);
  }

  openServiceTypeModal(): void {
    this.serviceTypeForm.reset({
      label: '',
      amountHt: 0,
      vatRate: 0
    });
    this.isServiceTypeModalOpen.set(true);
  }

  closeServiceTypeModal(): void {
    this.isServiceTypeModalOpen.set(false);
  }

  addServiceType(): void {
    if (this.serviceTypeForm.invalid) {
      this.serviceTypeForm.markAllAsTouched();
      return;
    }

    const raw = this.serviceTypeForm.getRawValue();
    const label = raw.label.trim();
    if (!label) {
      return;
    }

    this.serviceTypes.update((items) => [
      ...items,
      {
        id: 0,
        label,
        amountHt: Number(raw.amountHt) || 0,
        vatRate: Number(raw.vatRate) || 0,
        displayOrder: items.length + 1,
        tempKey: this.createTempKey('srv')
      }
    ]);

    this.closeServiceTypeModal();
  }

  removeServiceType(tempKey: string): void {
    this.serviceTypes.update((items) => items.filter((item) => item.tempKey !== tempKey));
  }

  removePaymentMethod(tempKey: string): void {
    this.paymentMethods.update((items) => items.filter((item) => item.tempKey !== tempKey));
  }

  togglePaymentMethodActive(tempKey: string): void {
    this.paymentMethods.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, isActive: !item.isActive } : item))
    );
  }

  onServiceTypeDragStart(event: DragEvent, tempKey: string): void {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/service-type-temp-key', tempKey);
  }

  onPaymentMethodDragStart(event: DragEvent, tempKey: string): void {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/payment-method-temp-key', tempKey);
  }

  allowDrop(event: DragEvent): void {
    event.preventDefault();
  }

  onServiceTypeDrop(event: DragEvent, targetTempKey: string): void {
    event.preventDefault();
    const draggedTempKey = event.dataTransfer?.getData('text/service-type-temp-key') ?? '';
    if (!draggedTempKey || draggedTempKey === targetTempKey) {
      return;
    }

    this.serviceTypes.update((items) => this.moveByTempKey(items, draggedTempKey, targetTempKey));
  }

  onPaymentMethodDrop(event: DragEvent, targetTempKey: string): void {
    event.preventDefault();
    const draggedTempKey = event.dataTransfer?.getData('text/payment-method-temp-key') ?? '';
    if (!draggedTempKey || draggedTempKey === targetTempKey) {
      return;
    }

    this.paymentMethods.update((items) => this.moveByTempKey(items, draggedTempKey, targetTempKey));
  }

  addPaymentMethod(): void {
    this.paymentMethods.update((items) => [
      ...items,
      {
        id: 0,
        label: `Nouveau moyen ${items.length + 1}`,
        isActive: true,
        displayOrder: items.length + 1,
        tempKey: this.createTempKey('pay')
      }
    ]);
  }

  updatePaymentMethodLabel(tempKey: string, value: string): void {
    this.paymentMethods.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, label: value } : item))
    );
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

  updateServiceTypeVat(tempKey: string, value: string): void {
    const parsed = Number(value);
    this.serviceTypes.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, vatRate: Number.isFinite(parsed) ? parsed : 0 } : item))
    );
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(value);
  }

  openCreateLocalCalendarModal(officeId?: number): void {
    const resolvedOfficeId = officeId ?? this.editingOfficeId() ?? null;
    if (!resolvedOfficeId) {
      this.agendaSettingsError.set('Enregistrez d\'abord le cabinet avant d\'ajouter un agenda.');
      return;
    }

    const nextIndex = this.officeCalendars().length + 1;
    this.editingLocalCalendarTempKey.set(null);
    this.localCalendarModalOfficeId.set(resolvedOfficeId);
    this.localCalendarForm.reset({
      name: `Calendrier ${nextIndex}`,
      description: '',
      colorHex: '#4d92d1',
      visibility: 'all' as const
    });
    this.localCalendarForm.get('name')?.updateValueAndValidity();
    this.localCalendarForm.updateValueAndValidity();
    this.localCalendarModalSelectedUserIds.set([]);
    this.isLocalCalendarModalOpen.set(true);
    this.agendaSettingsError.set('');
  }

  openEditLocalCalendarModal(tempKey: string): void {
    const calendar = this.localCalendars().find((item) => item.tempKey === tempKey);
    if (!calendar) {
      console.warn(`Calendar with tempKey ${tempKey} not found`);
      return;
    }

    this.editingLocalCalendarTempKey.set(tempKey);
    this.localCalendarModalOfficeId.set(calendar.officeId ?? null);
    
    // Create properly typed values
    const nameValue = (calendar.name || '').trim();
    const descriptionValue = (calendar.description || '').trim();
    const colorValue = calendar.colorHex && /^#[0-9a-fA-F]{6}$/.test(calendar.colorHex) ? calendar.colorHex : '#4d92d1';
    const visibilityValue: 'all' | 'selected' = calendar.visibility === 'selected' ? 'selected' : 'all';
    
    // Reset the form with typed values
    this.localCalendarForm.reset({
      name: nameValue,
      description: descriptionValue,
      colorHex: colorValue,
      visibility: visibilityValue
    });
    
    // Ensure form is marked as valid after reset
    this.localCalendarForm.get('name')?.updateValueAndValidity();
    this.localCalendarForm.get('description')?.updateValueAndValidity();
    this.localCalendarForm.get('colorHex')?.updateValueAndValidity();
    this.localCalendarForm.get('visibility')?.updateValueAndValidity();
    this.localCalendarForm.updateValueAndValidity();
    
    this.localCalendarModalSelectedUserIds.set([...calendar.visibleUserIds]);
    this.isLocalCalendarModalOpen.set(true);
    this.agendaSettingsError.set('');
  }

  closeLocalCalendarModal(): void {
    this.isLocalCalendarModalOpen.set(false);
    this.editingLocalCalendarTempKey.set(null);
    this.localCalendarModalOfficeId.set(null);
    this.localCalendarModalSelectedUserIds.set([]);
  }

  removeLocalCalendar(tempKey: string): void {
    const previousCalendars = this.localCalendars();
    const nextCalendars = previousCalendars
      .filter((item) => item.tempKey !== tempKey)
      .map((item, index) => ({ ...item, displayOrder: index + 1 }));

    this.localCalendars.set(nextCalendars);
    this.agendaSettingsError.set('');
    this.agendaSettingsSuccess.set('');

    void this.persistAgendaSettings('Calendrier supprimé.', previousCalendars);
  }

  onLocalCalendarModalVisibleUsersChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const selected = Array.from(select.selectedOptions)
      .map((option) => Number(option.value))
      .filter((id) => Number.isInteger(id) && id > 0);

    this.localCalendarModalSelectedUserIds.set(selected);
  }

  async saveLocalCalendarModal(): Promise<void> {
    if (this.localCalendarForm.invalid) {
      this.localCalendarForm.markAllAsTouched();
      this.agendaSettingsError.set('Veuillez corriger les erreurs dans le formulaire calendrier.');
      return;
    }

    const raw = this.localCalendarForm.getRawValue();
    const tempKey = this.editingLocalCalendarTempKey();
    
    // Validate required fields
    const nameValue = (raw.name || '').trim();
    if (!nameValue) {
      this.agendaSettingsError.set('Le nom du calendrier est obligatoire.');
      return;
    }

    const visibleUserIds = raw.visibility === 'selected'
      ? [...new Set(this.localCalendarModalSelectedUserIds().filter((id) => Number.isInteger(id) && id > 0))]
      : [];

    const previousCalendars = this.localCalendars();
    const modalOfficeId = this.localCalendarModalOfficeId();
    if (!modalOfficeId) {
      this.agendaSettingsError.set('Chaque agenda doit être rattaché à un cabinet.');
      return;
    }

    const editedCalendar = tempKey ? previousCalendars.find((item) => item.tempKey === tempKey) ?? null : null;
    const preservedCalendars = previousCalendars.filter((item) => item.officeId !== modalOfficeId);
    const nextOfficeCalendar: EditableLocalCalendar = {
      id: editedCalendar?.id ?? null,
      tempKey: editedCalendar?.tempKey ?? this.createTempKey('cal'),
      name: nameValue,
      description: (raw.description || '').trim(),
      colorHex: raw.colorHex && /^#[0-9a-fA-F]{6}$/.test(raw.colorHex) ? raw.colorHex : '#4d92d1',
      visibility: raw.visibility,
      visibleUserIds,
      visibleUsernames: editedCalendar?.visibleUsernames ?? [],
      officeId: modalOfficeId,
      displayOrder: 0
    };

    const nextCalendars = [...preservedCalendars, nextOfficeCalendar].map((item, index) => ({
      ...item,
      displayOrder: index + 1
    }));

    this.localCalendars.set(nextCalendars);
    this.agendaSettingsError.set('');
    this.agendaSettingsSuccess.set('');

    const saved = await this.persistAgendaSettings('Calendrier enregistré.', previousCalendars);
    if (saved) {
      this.closeLocalCalendarModal();
    }
  }

  getLocalCalendarVisibilityText(calendar: EditableLocalCalendar): string {
    if (calendar.visibility === 'all') {
      return 'Tout le monde';
    }

    const optionsById = new Map(this.agendaUserVisibilityOptions().map((option) => [option.id, option.label]));
    const labels = calendar.visibleUserIds
      .map((id) => optionsById.get(id))
      .filter((label): label is string => Boolean(label));

    return labels.length > 0 ? labels.join(', ') : 'Aucun compte';
  }

  async saveAgendaSettings(): Promise<void> {
    await this.persistAgendaSettings('Paramètres agenda enregistrés.');
  }

  private async persistAgendaSettings(successMessage: string, rollbackCalendars?: EditableLocalCalendar[]): Promise<boolean> {
    if (this.agendaSettingsForm.invalid) {
      this.agendaSettingsForm.markAllAsTouched();
      this.agendaSettingsError.set('Veuillez corriger les champs agenda invalides.');
      if (rollbackCalendars) {
        this.localCalendars.set(rollbackCalendars);
      }
      return false;
    }

    if (this.localCalendars().length === 0) {
      this.agendaSettingsError.set('Au moins un calendrier local est requis.');
      if (rollbackCalendars) {
        this.localCalendars.set(rollbackCalendars);
      }
      return false;
    }

    const hasInvalidCalendar = this.localCalendars().some((calendar) => !calendar.name.trim());
    if (hasInvalidCalendar) {
      this.agendaSettingsError.set('Le nom de chaque calendrier est obligatoire.');
      if (rollbackCalendars) {
        this.localCalendars.set(rollbackCalendars);
      }
      return false;
    }

    const hasCalendarWithoutOffice = this.localCalendars().some((calendar) => !Number.isInteger(calendar.officeId) || Number(calendar.officeId) <= 0);
    if (hasCalendarWithoutOffice) {
      this.agendaSettingsError.set('Chaque agenda doit être associé à un cabinet.');
      if (rollbackCalendars) {
        this.localCalendars.set(rollbackCalendars);
      }
      return false;
    }

    if (this.isSavingAgendaSettings()) {
      return false;
    }

    this.isSavingAgendaSettings.set(true);
    this.agendaSettingsError.set('');
    this.agendaSettingsSuccess.set('');

    try {
      const payload = this.buildAgendaSettingsPayload();
      const saved = await this.api.updateAgendaSettings(payload);
      this.applyAgendaSettings(saved);
      this.agendaSettingsSuccess.set(successMessage);
      return true;
    } catch {
      if (rollbackCalendars) {
        this.localCalendars.set(rollbackCalendars);
      }
      this.agendaSettingsError.set('Impossible d\'enregistrer les paramètres agenda.');
      return false;
    } finally {
      this.isSavingAgendaSettings.set(false);
    }
  }

  selectUserForProfileLink(userId: number): void {
    const user = this.users().find((item) => item.id === userId);
    if (!user) {
      return;
    }

    this.selectedUserId.set(user.id);
    this.selectedUserProfileId.set(user.profileId ?? this.superAdminId);
    this.isCreatingUserMode.set(false);
    this.userForm.reset({
      isActive: user.isActive,
      profileId: user.profileId ?? this.superAdminId,
      role: user.role || 'practitioner',
      officeId: user.officeId ?? 0,
      username: user.username,
      password: '',
      confirmPassword: '',
      lastName: user.lastName || '',
      firstName: user.firstName || '',
      email: user.email || '',
      mobilePhone: user.mobilePhone || '',
      country: user.country || 'France',
      siret: user.siret || '',
      adeliCode: user.adeliCode || '',
      rppsCode: user.rppsCode || '',
      apeNafCode: user.apeNafCode || '',
      nameSuffixText: user.nameSuffixText || '',
      letterHeader: user.letterHeader || '',
      letterFooter: user.letterFooter || '',
      signatureText: user.signatureText || '',
      colorHex: user.colorHex || '#4d92d1',
      bankName: user.bankName || '',
      iban: user.iban || '',
      defaultAgendaView: user.defaultAgendaView || 'Semaine',
      defaultYearsForStatistics: user.defaultYearsForStatistics ?? 5,
      invoiceMentions: user.invoiceMentions || '',
      includeFreeConsultations: user.includeFreeConsultations ?? true,
      showConsultationHour: user.showConsultationHour ?? true
    });
    this.userProfileLinkError.set('');
    this.userProfileLinkSuccess.set('');
    this.userSignatureError.set('');
    this.selectedUserSignatureFileName.set('');
    this.userSignatureValue.set(user.signatureText || '');
    const officeIds = Array.isArray(user.officeIds) && user.officeIds.length > 0
      ? [...new Set(user.officeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
      : (user.officeId != null ? [user.officeId] : []);
    this.selectedUserOfficeIds.set(officeIds);
  }

  startCreateUserAccount(): void {
    this.selectedUserId.set(null);
    this.selectedUserProfileId.set(this.superAdminId);
    this.isCreatingUserMode.set(true);
    this.userForm.reset({
      isActive: true,
      profileId: this.superAdminId,
      role: 'practitioner',
      officeId: 0,
      username: '',
      password: '',
      confirmPassword: '',
      lastName: '',
      firstName: '',
      email: '',
      mobilePhone: '',
      country: 'France',
      siret: '',
      adeliCode: '',
      rppsCode: '',
      apeNafCode: '',
      nameSuffixText: '',
      letterHeader: '',
      letterFooter: '',
      signatureText: '',
      colorHex: '#4d92d1',
      bankName: '',
      iban: '',
      defaultAgendaView: 'Semaine',
      defaultYearsForStatistics: 5,
      invoiceMentions: '',
      includeFreeConsultations: true,
      showConsultationHour: true
    });
    this.userProfileLinkError.set('');
    this.userProfileLinkSuccess.set('');
    this.userSignatureError.set('');
    this.selectedUserSignatureFileName.set('');
    this.userSignatureValue.set('');
    this.selectedUserOfficeIds.set([]);
  }

  onUserCabinetSelectionChange(event: Event): void {
    const options = Array.from((event.target as HTMLSelectElement).selectedOptions);
    const selectedIds = [...new Set(options
      .map((option) => Number(option.value))
      .filter((id) => Number.isInteger(id) && id > 0))];
    this.selectedUserOfficeIds.set(selectedIds);
  }

  openCreateUserModal(): void {
    this.startCreateUserAccount();
    this.userModalTab.set('identity');

    if (this.offices().length === 0 && !this.isOfficesLoading()) {
      void this.loadOffices();
    }

    this.isUserModalOpen.set(true);
  }

  openEditUserModal(userId?: number): void {
    const targetId = userId ?? this.selectedUserId() ?? this.users()[0]?.id ?? null;
    if (!targetId) {
      return;
    }

    if (this.offices().length === 0 && !this.isOfficesLoading()) {
      void this.loadOffices();
    }

    this.selectUserForProfileLink(targetId);
    this.userModalTab.set('identity');
    this.isUserModalOpen.set(true);
  }

  closeUserModal(): void {
    this.isUserModalOpen.set(false);
    this.userModalTab.set('identity');
    this.userProfileLinkError.set('');
    this.userSignatureError.set('');
  }

  selectUserModalTab(tabId: UserModalTabId): void {
    this.userModalTab.set(tabId);
  }

  openCabinetDelegationsSection(): void {
    this.closeUserModal();
    this.selectSection('offices');
  }

  getUserDisplayName(user: AccessManagedUser): string {
    const fullName = `${user.lastName || ''} ${user.firstName || ''}`.trim();
    return fullName || user.username;
  }

  getUserInitials(user: AccessManagedUser): string {
    const firstName = (user.firstName || '').trim();
    const lastName = (user.lastName || '').trim();
    const firstInitial = firstName.charAt(0).toUpperCase();
    const lastInitial = lastName.charAt(0).toUpperCase();
    const initials = `${firstInitial}${lastInitial}`.trim();

    if (initials) {
      return initials;
    }

    return user.username.slice(0, 2).toUpperCase();
  }

  async onUserSignatureFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.item(0) ?? null;

    this.userSignatureError.set('');

    if (!file) {
      this.selectedUserSignatureFileName.set('');
      return;
    }

    if (file.size > 1_500_000) {
      this.userSignatureError.set('Le fichier de signature est trop volumineux (maximum 1.5 Mo).');
      if (input) {
        input.value = '';
      }
      return;
    }

    try {
      const dataUrl = await this.readFileAsDataUrl(file);
      this.userForm.controls.signatureText.setValue(dataUrl);
      this.selectedUserSignatureFileName.set(file.name);
      this.userSignatureValue.set(dataUrl);
    } catch {
      this.userSignatureError.set('Impossible de lire le fichier de signature.');
      if (input) {
        input.value = '';
      }
    }
  }

  clearUserSignature(): void {
    this.userForm.controls.signatureText.setValue('');
    this.selectedUserSignatureFileName.set('');
    this.userSignatureValue.set('');
    this.userSignatureError.set('');
  }

  getUserSignaturePreviewText(): string {
    if (!this.userSignatureValue()) {
      return '';
    }

    if (this.isUserSignatureImage()) {
      return 'Signature image enregistrée';
    }

    const value = this.userSignatureValue();
    const compact = value.length > 96 ? `${value.slice(0, 96)}...` : value;
    return compact;
  }

  async downloadBackup(): Promise<void> {
    this.dataManagementError.set('');
    this.dataManagementSuccess.set('');
    this.isDownloadingBackup.set(true);

    try {
      const blob = await this.api.downloadDataBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      anchor.href = url;
      anchor.download = `osteosoft-backup-${stamp}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      this.dataManagementSuccess.set('Sauvegarde téléchargée avec succès.');
    } catch {
      this.dataManagementError.set('Impossible de télécharger la sauvegarde pour le moment.');
    } finally {
      this.isDownloadingBackup.set(false);
    }
  }

  async onBackupFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.item(0) ?? null;

    this.dataManagementError.set('');
    this.dataManagementSuccess.set('');

    if (!file) {
      this.selectedBackupFileName.set('');
      this.selectedBackupPayload.set(null);
      return;
    }

    this.selectedBackupFileName.set(file.name);

    try {
      const content = await file.text();
      this.selectedBackupPayload.set(JSON.parse(content));
      this.dataManagementSuccess.set('Fichier de sauvegarde chargé, vous pouvez lancer la restauration.');
    } catch {
      this.selectedBackupPayload.set(null);
      this.dataManagementError.set('Le fichier sélectionné n\'est pas une sauvegarde JSON valide.');
    }
  }

  async restoreBackup(): Promise<void> {
    if (!this.selectedBackupPayload()) {
      this.dataManagementError.set('Veuillez sélectionner un fichier de sauvegarde valide.');
      return;
    }

    const confirmation = globalThis.confirm('Cette opération remplacera toutes les données actuelles. Continuer ?');
    if (!confirmation) {
      return;
    }

    this.dataManagementError.set('');
    this.dataManagementSuccess.set('');
    this.isRestoringBackup.set(true);

    try {
      await this.api.restoreDataBackup(this.selectedBackupPayload());
      this.dataManagementSuccess.set('Restauration terminée avec succès.');
      await this.loadAccessProfiles();
      await this.loadUsers();
      await this.loadCurrentUser();
    } catch {
      this.dataManagementError.set('La restauration a échoué. Vérifiez le fichier de sauvegarde.');
    } finally {
      this.isRestoringBackup.set(false);
    }
  }

  toggleRgpdPatientPicker(): void {
    this.showRgpdPatientPicker.update((value) => !value);
    if (!this.showRgpdPatientPicker()) {
      this.rgpdPatientSearch.set('');
      this.rgpdSearchResults.set([]);
      this.isSearchingRgpdPatients.set(false);
    }
  }

  onRgpdPatientSearchChange(rawValue: string): void {
    this.rgpdPatientSearch.set(rawValue);
    this.dataManagementError.set('');

    if (this.rgpdSearchDebounceId !== null) {
      clearTimeout(this.rgpdSearchDebounceId);
      this.rgpdSearchDebounceId = null;
    }

    const term = rawValue.trim();
    if (term.length < 2) {
      this.rgpdSearchResults.set([]);
      this.isSearchingRgpdPatients.set(false);
      return;
    }

    this.isSearchingRgpdPatients.set(true);
    this.rgpdSearchDebounceId = setTimeout(() => {
      void this.searchRgpdPatients(term);
    }, 250);
  }

  selectRgpdPatient(patient: Patient): void {
    this.selectedRgpdPatient.set(patient);
    this.rgpdPatientSearch.set('');
    this.rgpdSearchResults.set([]);
    this.isSearchingRgpdPatients.set(false);
    this.showRgpdPatientPicker.set(false);
    this.dataManagementError.set('');
  }

  clearRgpdPatientSelection(): void {
    this.selectedRgpdPatient.set(null);
    this.dataManagementError.set('');
  }

  getRelatedPatientIcon(sex: Patient['sex']): string {
    if (sex === 'Femme') {
      return 'fa-solid fa-venus';
    }
    if (sex === 'Homme') {
      return 'fa-solid fa-mars';
    }
    return 'fa-solid fa-circle-question';
  }

  getRelatedPatientMeta(patient: Patient): string {
    const ageText = patient.age === null ? 'Age inconnu' : `${patient.age} ans`;
    const consultationText = `${patient.consultationCount} consultation${patient.consultationCount > 1 ? 's' : ''}`;
    return `${ageText} - ${consultationText}`;
  }

  async exportSelectedPatientRgpd(): Promise<void> {
    const selected = this.selectedRgpdPatient();
    if (!selected) {
      this.dataManagementError.set('Veuillez sélectionner un patient pour l\'export RGPD.');
      return;
    }
    const patientId = selected.id;

    this.dataManagementError.set('');
    this.dataManagementSuccess.set('');
    this.isExportingRgpdPatient.set(true);
    try {
      const blob = await this.api.downloadPatientRgpdExport(patientId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const slug = (selected?.fullName ?? `patient-${patientId}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const stamp = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = `rgpd-export-${slug || `patient-${patientId}`}-${stamp}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      this.dataManagementSuccess.set('Export RGPD généré avec succès.');
    } catch {
      this.dataManagementError.set('Impossible de générer l\'export RGPD pour ce patient.');
    } finally {
      this.isExportingRgpdPatient.set(false);
    }
  }

  private async searchRgpdPatients(term: string): Promise<void> {
    const requestId = ++this.rgpdSearchRequestId;

    try {
      const patients = await this.api.getPatients(term);
      if (requestId !== this.rgpdSearchRequestId) {
        return;
      }

      const selectedId = this.selectedRgpdPatient()?.id;
      this.rgpdSearchResults.set(
        patients.filter((patient) => patient.id !== selectedId).slice(0, 40)
      );
    } catch {
      if (requestId === this.rgpdSearchRequestId) {
        this.rgpdSearchResults.set([]);
        this.dataManagementError.set('Impossible de rechercher les patients pour l\'export RGPD.');
      }
    } finally {
      if (requestId === this.rgpdSearchRequestId) {
        this.isSearchingRgpdPatients.set(false);
      }
    }
  }

  formatUserName(user: AccessManagedUser): string {
    const fullName = `${user.lastName || ''} ${user.firstName || ''}`.trim();
    return fullName || '-';
  }

  formatCreatedDate(value: string): string {
    if (!value) {
      return '-';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return '-';
    }

    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(parsed);
  }

  formatAuditLogDateTime(value: string): string {
    if (!value) {
      return '-';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return '-';
    }

    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(parsed);
  }

  formatAuditLogMetadata(metadata: Record<string, unknown> | null): string {
    if (!metadata || !this.isRecord(metadata)) {
      return '-';
    }

    const changeFields = this.extractChangedFields(metadata);
    if (changeFields.length) {
      const visibleFields = changeFields.slice(0, 3).join(', ');
      const suffix = changeFields.length > 3 ? ', ...' : '';
      return `Champs modifies: ${visibleFields}${suffix}`;
    }

    const entries = Object.entries(metadata).filter(([key]) => key !== 'changes');
    if (entries.length === 0) {
      return '-';
    }

    return entries
      .slice(0, 2)
      .map(([key, value]) => `${key}: ${this.stringifyAuditValue(value)}`)
      .join(' | ');
  }

  canDeleteUser(user: AccessManagedUser): boolean {
    return user.username !== 'admin';
  }

  async deleteUser(user: AccessManagedUser): Promise<void> {
    if (!this.canDeleteUser(user)) {
      this.userProfileLinkError.set('Le compte admin ne peut pas être supprimé.');
      return;
    }

    const confirmation = globalThis.confirm(`Supprimer le compte ${user.username} ?`);
    if (!confirmation) {
      return;
    }

    this.userProfileLinkError.set('');
    this.userProfileLinkSuccess.set('');
    this.deletingUserId.set(user.id);

    try {
      await this.api.deleteUserAccount(user.id);
      this.users.update((items) => items.filter((item) => item.id !== user.id));

      if (this.selectedUserId() === user.id) {
        this.selectedUserId.set(null);
      }

      this.userProfileLinkSuccess.set('Compte utilisateur supprimé.');
    } catch {
      this.userProfileLinkError.set('Impossible de supprimer ce compte utilisateur.');
    } finally {
      this.deletingUserId.set(null);
    }
  }

  async saveUserAccount(): Promise<void> {
    if (this.userForm.invalid) {
      this.userForm.markAllAsTouched();
      this.userProfileLinkError.set('Veuillez corriger les champs invalides.');
      return;
    }

    if (this.userSignatureError()) {
      this.userProfileLinkError.set('Veuillez corriger le champ signature avant d\'enregistrer.');
      return;
    }

    const userId = this.selectedUserId();
    const payload = this.buildUserAccountPayload();
    const isCreate = this.isCreatingUserMode() || !userId;

    this.userProfileLinkError.set('');
    this.userProfileLinkSuccess.set('');

    if (!payload.profileId) {
      this.userProfileLinkError.set('Veuillez sélectionner un profil.');
      return;
    }

    const raw = this.userForm.getRawValue();
    const password = String(raw.password ?? '').trim();
    const confirmPassword = String(raw.confirmPassword ?? '').trim();

    if (isCreate && !password) {
      this.userProfileLinkError.set('Le mot de passe est obligatoire pour créer un compte.');
      return;
    }

    if (password || confirmPassword) {
      if (!password || !confirmPassword) {
        this.userProfileLinkError.set('Veuillez renseigner le mot de passe et sa confirmation.');
        return;
      }

      if (password !== confirmPassword) {
        this.userProfileLinkError.set('La confirmation du mot de passe ne correspond pas.');
        return;
      }
    }

    if (isCreate) {
      this.isCreatingUserAccount.set(true);
    } else {
      this.isSavingUserAccount.set(true);
    }

    try {
      if (isCreate) {
        const createdUser = await this.api.createUserAccount(payload);
        this.users.update((items) => [...items, createdUser].sort((a, b) => a.username.localeCompare(b.username)));
        this.selectUserForProfileLink(createdUser.id);
        this.userProfileLinkSuccess.set('Compte utilisateur créé.');
        this.closeUserModal();
      } else {
        await this.api.updateUserAccount(userId, payload);

        const profileLabel = this.profiles().find((profile) => profile.id === payload.profileId)?.label ?? null;
        const cabinetName = payload.officeId
          ? this.offices().find((office) => office.id === payload.officeId)?.name ?? ''
          : '';
        this.users.update((items) =>
          items
            .map((item) =>
              item.id === userId
                ? {
                    ...item,
                    ...payload,
                    role: payload.role ?? item.role,
                    cabinetName,
                    profileLabel
                  }
                : item
            )
            .sort((a, b) => a.username.localeCompare(b.username))
        );

        this.userForm.controls.password.setValue('');
        this.userForm.controls.confirmPassword.setValue('');
        this.userSignatureValue.set(payload.signatureText);
        this.selectedUserSignatureFileName.set('');
        this.userProfileLinkSuccess.set('Compte utilisateur mis à jour.');
        this.closeUserModal();
      }
    } catch {
      this.userProfileLinkError.set('Impossible d’enregistrer le compte utilisateur.');
    } finally {
      this.isCreatingUserAccount.set(false);
      this.isSavingUserAccount.set(false);
    }
  }

  async createProfile(): Promise<void> {
    if (this.profileForm.invalid) {
      this.profileForm.markAllAsTouched();
      return;
    }

    this.profileFormError.set('');
    const raw = this.profileForm.getRawValue();
    const label = raw.label.trim();
    const description = raw.description.trim();

    if (!label) {
      this.profileFormError.set('Le nom du profil est obligatoire.');
      return;
    }

    const exists = this.profiles().some((profile) => profile.label.toLowerCase() === label.toLowerCase());
    if (exists) {
      this.profileFormError.set('Un profil avec ce nom existe déjà.');
      return;
    }

    this.isCreatingProfile.set(true);
    try {
      const profile = await this.api.createAccessProfile(label, description);
      const normalizedProfile = this.normalizeProfile(profile);

      this.profiles.update((items) => [...items, normalizedProfile]);
      this.selectedProfileId.set(normalizedProfile.id);
      this.profileForm.reset({ label: '', description: '' });
    } catch {
      this.profileFormError.set('Impossible de créer le profil pour le moment.');
    } finally {
      this.isCreatingProfile.set(false);
    }
  }

  selectProfile(profileId: string): void {
    this.selectedProfileId.set(profileId);
  }

  updateCurrentUserProfileId(profileId: string): void {
    this.currentUserProfileId.set(profileId || this.superAdminId);
  }

  isSuperAdminSelected(): boolean {
    return this.selectedProfile().id === this.superAdminId;
  }

  isPermissionEnabled(domainId: AccessDomainId, permissionId: string): boolean {
    return Boolean(this.selectedProfile().rights[domainId]?.[permissionId]);
  }

  isDomainFullyEnabled(domain: AccessDomain): boolean {
    return domain.permissions.every((permission) => this.isPermissionEnabled(domain.id, permission.id));
  }

  setDomainAll(domain: AccessDomain, enabled: boolean): void {
    if (this.isSuperAdminSelected()) {
      return;
    }

    this.profiles.update((items) =>
      items.map((profile) => {
        if (profile.id !== this.selectedProfile().id) {
          return profile;
        }

        const currentDomain = profile.rights[domain.id] ?? {};
        const nextDomain = { ...currentDomain };

        for (const permission of domain.permissions) {
          nextDomain[permission.id] = enabled;
        }

        return {
          ...profile,
          rights: {
            ...profile.rights,
            [domain.id]: nextDomain
          }
        };
      })
    );

    this.schedulePersistSelectedProfileRights();
  }

  setPermission(domainId: AccessDomainId, permissionId: string, enabled: boolean): void {
    if (this.isSuperAdminSelected()) {
      return;
    }

    this.profiles.update((items) =>
      items.map((profile) => {
        if (profile.id !== this.selectedProfile().id) {
          return profile;
        }

        const currentDomain = profile.rights[domainId] ?? {};
        return {
          ...profile,
          rights: {
            ...profile.rights,
            [domainId]: {
              ...currentDomain,
              [permissionId]: enabled
            }
          }
        };
      })
    );

    this.schedulePersistSelectedProfileRights();
  }

  async saveCurrentUserProfile(): Promise<void> {
    this.profileLinkError.set('');
    this.profileLinkSuccess.set('');

    const profileId = this.currentUserProfileId();
    if (!profileId) {
      this.profileLinkError.set('Veuillez sélectionner un profil.');
      return;
    }

    this.isSavingCurrentUserProfile.set(true);
    try {
      await this.api.updateCurrentUserAccessProfile(profileId);
      this.currentUser.update((user) =>
        user
          ? {
              ...user,
              profileId,
              profileLabel: this.profiles().find((profile) => profile.id === profileId)?.label ?? null
            }
          : user
      );
      this.profileLinkSuccess.set('Profil du compte mis à jour.');
    } catch {
      this.profileLinkError.set('Impossible de mettre à jour le profil du compte.');
    } finally {
      this.isSavingCurrentUserProfile.set(false);
    }
  }

  private buildRights(defaultValue: boolean): Record<AccessDomainId, Record<string, boolean>> {
    return this.accessDomains.reduce((acc, domain) => {
      const permissions = domain.permissions.reduce((permissionMap, permission) => {
        permissionMap[permission.id] = defaultValue;
        return permissionMap;
      }, {} as Record<string, boolean>);

      acc[domain.id] = permissions;
      return acc;
    }, {} as Record<AccessDomainId, Record<string, boolean>>);
  }

  private normalizeProfile(profile: {
    id: string;
    label: string;
    description: string;
    immutable?: boolean;
    rights: Record<string, Record<string, boolean>>;
  }): AccessProfile {
    const baseRights = this.buildRights(false);

    for (const domain of this.accessDomains) {
      for (const permission of domain.permissions) {
        baseRights[domain.id][permission.id] = Boolean(profile.rights?.[domain.id]?.[permission.id]);
      }
    }

    return {
      id: profile.id,
      label: profile.label,
      description: profile.description,
      immutable: Boolean(profile.immutable),
      rights: baseRights
    };
  }

  private schedulePersistSelectedProfileRights(): void {
    if (this.rightsPersistTimer) {
      clearTimeout(this.rightsPersistTimer);
    }

    this.rightsPersistTimer = setTimeout(() => {
      void this.persistSelectedProfileRights();
    }, 180);
  }

  private async persistSelectedProfileRights(): Promise<void> {
    const profile = this.selectedProfile();
    if (!profile || profile.immutable) {
      return;
    }

    this.rightsSaveError.set('');
    this.isSavingRights.set(true);
    try {
      await this.api.updateAccessProfileRights(profile.id, { rights: profile.rights });
    } catch {
      this.rightsSaveError.set('La sauvegarde des droits a échoué.');
    } finally {
      this.isSavingRights.set(false);
    }
  }

  private async loadAccessProfiles(): Promise<void> {
    this.isProfilesLoading.set(true);
    this.profileFormError.set('');
    try {
      const profiles = await this.api.getAccessProfiles();
      if (!profiles.length) {
        return;
      }

      this.profiles.set(profiles.map((profile) => this.normalizeProfile(profile)));

      const currentSelected = this.selectedProfileId();
      const stillExists = profiles.some((profile) => profile.id === currentSelected);
      if (!stillExists) {
        this.selectedProfileId.set(profiles[0].id);
      }
    } catch {
      this.profileFormError.set('Impossible de charger les profils depuis le serveur.');
    } finally {
      this.isProfilesLoading.set(false);
    }
  }

  private async loadCurrentUser(): Promise<void> {
    try {
      const user = await this.api.me();
      this.currentUser.set(user);
      const profileId = user.profileId;

      if (profileId) {
        this.currentUserProfileId.set(profileId);
      }
    } catch {
      this.profileLinkError.set('Impossible de récupérer le compte utilisateur courant.');
    }
  }

  private async loadUsers(): Promise<void> {
    this.isUsersLoading.set(true);
    this.userProfileLinkError.set('');
    try {
      const users = await this.api.getUsers();
      this.users.set(users);

      const firstUser = users[0] ?? null;
      if (firstUser) {
        this.selectUserForProfileLink(firstUser.id);
      } else {
        this.startCreateUserAccount();
      }
    } catch {
      this.userProfileLinkError.set('Impossible de charger les utilisateurs.');
    } finally {
      this.isUsersLoading.set(false);
    }
  }

  private async loadAuditLogs(): Promise<void> {
    this.isAuditLogsLoading.set(true);
    this.auditLogsError.set('');

    try {
      const logs = await this.api.getAuditLogs(this.selectedAuditLogLimit());
      this.auditLogs.set(logs);
    } catch {
      this.auditLogsError.set('Impossible de charger les logs d\'audit.');
    } finally {
      this.isAuditLogsLoading.set(false);
    }
  }

  private async loadAgendaSettings(): Promise<void> {
    this.isAgendaSettingsLoading.set(true);
    this.agendaSettingsError.set('');

    try {
      const payload = await this.api.getAgendaSettings();
      this.applyAgendaSettings(payload);
    } catch {
      this.agendaSettingsError.set('Impossible de charger les paramètres agenda.');
    } finally {
      this.isAgendaSettingsLoading.set(false);
    }
  }

  private initializeInlineOfficeAgendaForm(): void {
    const officeId = this.editingOfficeId();
    if (!officeId) {
      return;
    }

    const office = this.offices().find((item) => item.id === officeId);
    const currentOfficeCalendar = this.officeCalendars()[0] ?? null;
    const visibility: 'all' | 'selected' = currentOfficeCalendar?.visibility === 'selected' ? 'selected' : 'all';

    this.editingLocalCalendarTempKey.set(currentOfficeCalendar?.tempKey ?? null);
    this.localCalendarModalOfficeId.set(officeId);
    this.localCalendarForm.reset({
      name: currentOfficeCalendar?.name?.trim() || `Agenda principal - ${office?.name ?? 'Cabinet'}`,
      description: currentOfficeCalendar?.description?.trim() || '',
      colorHex: currentOfficeCalendar?.colorHex || '#4d92d1',
      visibility
    });
    this.localCalendarModalSelectedUserIds.set(currentOfficeCalendar ? [...currentOfficeCalendar.visibleUserIds] : []);
    this.agendaSettingsError.set('');
    this.agendaSettingsSuccess.set('');
  }

  private applyAgendaSettings(payload: AgendaSettingsPayload): void {
    this.agendaSettingsForm.reset({
      lunchStartHour: payload.settings.lunchStartHour,
      lunchEndHour: payload.settings.lunchEndHour,
      defaultSessionDurationMinutes: payload.settings.defaultSessionDurationMinutes,
      slotDurationMinutes: payload.settings.slotDurationMinutes,
      displayHeight: payload.settings.displayHeight,
      autoConsultationType: payload.settings.autoConsultationType
    });

    this.localCalendars.set(
      payload.localCalendars.map((calendar, index) => ({
        ...calendar,
        displayOrder: index + 1,
        tempKey: this.createTempKey('cal')
      }))
    );
  }

  private buildAgendaSettingsPayload(): AgendaSettingsPayload {
    const raw = this.agendaSettingsForm.getRawValue();

    return {
      settings: {
        lunchStartHour: Number(raw.lunchStartHour),
        lunchEndHour: Number(raw.lunchEndHour),
        defaultSessionDurationMinutes: Number(raw.defaultSessionDurationMinutes),
        slotDurationMinutes: Number(raw.slotDurationMinutes),
        displayHeight: Number(raw.displayHeight),
        autoConsultationType: raw.autoConsultationType,
        showWeekend: false,
        showPatientSex: true,
        showPatientMobilePhone: true,
        showPatientLandlinePhone: false,
        showAppointmentComment: true,
        patientRemarksDisplay: 'hidden',
        appointmentColorMode: 'calendar'
      },
      localCalendars: this.localCalendars().map((calendar, index) => ({
        id: calendar.id,
        name: calendar.name.trim(),
        description: calendar.description.trim(),
        colorHex: calendar.colorHex.trim() || '#4d92d1',
        visibility: calendar.visibility,
        visibleUserIds: calendar.visibility === 'selected' ? [...new Set(calendar.visibleUserIds)] : [],
        visibleUsernames: [],
        officeId: Number(calendar.officeId),
        displayOrder: index + 1
      }))
    };
  }

  private buildUserAccountPayload(): UserAccountPayload {
    const raw = this.userForm.getRawValue();
    const officeIds = [...new Set(this.selectedUserOfficeIds()
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0))];

    return {
      isActive: raw.isActive,
      profileId: raw.profileId.trim(),
      role: raw.role.trim(),
      officeId: officeIds.length > 0 ? officeIds[0] : null,
      officeIds,
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

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          resolve(result);
          return;
        }

        reject(new Error('INVALID_FILE_RESULT'));
      };

      reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_ERROR'));
      reader.readAsDataURL(file);
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private extractChangedFields(metadata: Record<string, unknown>): string[] {
    const rawChanges = metadata['changes'];
    if (!Array.isArray(rawChanges)) {
      return [];
    }

    return rawChanges
      .map((change) => {
        if (!this.isRecord(change)) {
          return '';
        }

        const field = change['field'];
        return typeof field === 'string' ? field.trim() : '';
      })
      .filter((field) => field.length > 0);
  }

  private stringifyAuditValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '-';
    }

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (Array.isArray(value)) {
      return `${value.length} element(s)`;
    }

    if (this.isRecord(value)) {
      return '{...}';
    }

    return String(value);
  }

  private moveByTempKey<T extends { tempKey: string }>(items: T[], draggedTempKey: string, targetTempKey: string): T[] {
    const sourceIndex = items.findIndex((item) => item.tempKey === draggedTempKey);
    const targetIndex = items.findIndex((item) => item.tempKey === targetTempKey);

    if (sourceIndex < 0 || targetIndex < 0) {
      return items;
    }

    const next = [...items];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    return next;
  }

  private createTempKey(prefix: string): string {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now()}-${randomPart}`;
  }

  // Offices Management

  async loadOffices(): Promise<void> {
    this.isOfficesLoading.set(true);
    this.officesError.set('');

    try {
      const offices = await this.api.getOffices();
      this.offices.set(offices);
      if (offices.length > 0 && this.serviceTypes().length === 0 && this.paymentMethods().length === 0) {
        const firstOffice = offices[0];
        this.serviceTypes.set(
          firstOffice.serviceTypes.map((item, index) => ({
            ...item,
            displayOrder: index + 1,
            tempKey: this.createTempKey('srv')
          }))
        );
        this.paymentMethods.set(
          firstOffice.paymentMethods.map((item, index) => ({
            ...item,
            displayOrder: index + 1,
            tempKey: this.createTempKey('pay')
          }))
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur lors du chargement des cabinets';
      this.officesError.set(message);
      console.error('Error loading offices:', err);
    } finally {
      this.isOfficesLoading.set(false);
    }
  }

  openOfficeModal(officeId?: number): void {
    this.officesError.set('');
    this.officesSuccess.set('');
    this.editingOfficeId.set(officeId ?? null);
    this.officeModalTab.set('general');
    this.officeCreateStep.set(1);

    if (!this.isAgendaSettingsLoading() && this.localCalendars().length === 0) {
      void this.loadAgendaSettings();
    }

    if (this.users().length === 0 && !this.isUsersLoading()) {
      void this.loadUsers();
    }

    if (officeId) {
      this.stopOfficeDraftAutosave();
      const office = this.offices().find((o) => o.id === officeId);
      if (office) {
        const openingHours = this.ensureOfficeOpeningHours(office.openingHours);
        this.officeOpeningHoursDraft.set(openingHours);
        this.serviceTypes.set(
          office.serviceTypes.map((item, index) => ({
            ...item,
            displayOrder: index + 1,
            tempKey: this.createTempKey('srv')
          }))
        );
        this.paymentMethods.set(
          office.paymentMethods.map((item, index) => ({
            ...item,
            displayOrder: index + 1,
            tempKey: this.createTempKey('pay')
          }))
        );
        this.consultationProfiles.set(this.toEditableConsultationProfiles(office.consultationProfiles));
        this.officeUserDelegations.set(this.toEditableOfficeUserDelegations(office.officeUserDelegations));
        this.officeForm.reset({
          name: office.name,
          defaultSessionDurationMinutes: office.defaultSessionDurationMinutes,
          country: office.country || 'France',
          devise: office.devise || 'EUR',
          invoiceNumberFormat: office.invoiceNumberFormat,
          numberingConfiguration: office.numberingConfiguration,
          alwaysShowSocialSecurityAndMutuelle: office.alwaysShowSocialSecurityAndMutuelle,
          hideVatMention: office.hideVatMention,
          addressLine1: office.addressLine1 || '',
          addressLine2: office.addressLine2 || '',
          postalCode: office.postalCode || '',
          city: office.city || '',
          phoneMobile: office.phoneMobile || '',
          phoneLandline: office.phoneLandline || '',
          phoneFax: office.phoneFax || '',
          email: office.email || '',
          website: office.website || '',
          vatNumber: office.vatNumber || '',
          logoData: office.logoData || '',
          openingHoursJson: JSON.stringify(openingHours)
        });
      }
    } else {
      this.officeDraftSaveState.set('idle');
      this.lastOfficeDraftSavedAt.set(null);
      const openingHours = this.createDefaultOfficeOpeningHours();
      this.officeOpeningHoursDraft.set(openingHours);
      this.serviceTypes.set([]);
      this.paymentMethods.set([]);
      this.consultationProfiles.set([]);
      this.officeUserDelegations.set([]);
      this.officeForm.reset({
        name: '',
        defaultSessionDurationMinutes: 60,
        country: 'France',
        devise: 'EUR',
        invoiceNumberFormat: 'AAAA-XXXXXX',
        numberingConfiguration: 'Numérotation globale au cabinet',
        alwaysShowSocialSecurityAndMutuelle: false,
        hideVatMention: false,
        addressLine1: '',
        addressLine2: '',
        postalCode: '',
        city: '',
        phoneMobile: '',
        phoneLandline: '',
        phoneFax: '',
        email: '',
        website: '',
        vatNumber: '',
        logoData: '',
        openingHoursJson: JSON.stringify(openingHours)
      });

      void this.loadOfficeDraft();
      this.startOfficeDraftAutosave();
    }

    this.isOfficeModalOpen.set(true);
  }

  setOfficeConfigTarget(value: string): void {
    const parsed = Number(value);
    this.officeConfigTargetId.set(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
  }

  openMovedOfficeConfiguration(tabId: 'consultation-reasons' | 'patient-letters'): void {
    const targetOfficeId = this.officeConfigTargetId() ?? this.offices()[0]?.id ?? null;

    if (!targetOfficeId) {
      this.officesError.set('Aucun cabinet disponible. Ajoutez d\'abord un cabinet.');
      return;
    }

    this.openOfficeModal(targetOfficeId);
    this.selectOfficeModalTab(tabId);
  }

  closeOfficeModal(): void {
    if (!this.editingOfficeId()) {
      void this.persistOfficeDraft();
    }

    this.stopOfficeDraftAutosave();
    this.isOfficeModalOpen.set(false);
    this.isOfficeDelegationModalOpen.set(false);
    this.officeDelegationModalError.set('');
    this.editingOfficeId.set(null);
    this.officeModalTab.set('general');
    this.officeCreateStep.set(1);
  }

  selectOfficeModalTab(tabId: OfficeModalTabId): void {
    this.officeModalTab.set(tabId);

    if (tabId === 'agendas' && this.editingOfficeId()) {
      this.initializeInlineOfficeAgendaForm();
    }
  }

  async saveInlineOfficeAgenda(): Promise<void> {
    const officeId = this.editingOfficeId();
    if (!officeId) {
      this.agendaSettingsError.set('Enregistrez d\'abord le cabinet avant de configurer son agenda.');
      return;
    }

    this.localCalendarModalOfficeId.set(officeId);
    const currentOfficeCalendar = this.officeCalendars()[0] ?? null;
    this.editingLocalCalendarTempKey.set(currentOfficeCalendar?.tempKey ?? null);

    await this.saveLocalCalendarModal();
  }

  addConsultationProfile(): void {
    this.consultationProfiles.update((profiles) => {
      const nextIndex = profiles.length + 1;
      return [
        ...profiles,
        {
          tempKey: this.createTempKey('profile'),
          id: this.createTempKey('profile-id'),
          name: `Profil ${nextIndex}`,
          reasons: []
        }
      ];
    });
  }

  addOfficeUserDelegation(): void {
    const profileOptions = this.officeDelegationProfileOptions();
    const userOptions = this.officeDelegationUserOptions();
    const usedUserIds = new Set(
      this.officeUserDelegations()
        .map((item) => Number(item.userId))
        .filter((id) => Number.isInteger(id) && id > 0)
    );
    const firstAvailableUser = userOptions.find((option) => !usedUserIds.has(option.id))?.id ?? userOptions[0]?.id ?? 0;

    this.officeDelegationForm.reset({
      userId: firstAvailableUser,
      profileId: profileOptions[0]?.id ?? this.superAdminId
    });
    this.officeDelegationModalError.set('');
    this.isOfficeDelegationModalOpen.set(true);
  }

  closeOfficeDelegationModal(): void {
    this.isOfficeDelegationModalOpen.set(false);
    this.officeDelegationModalError.set('');
  }

  saveOfficeDelegationFromModal(): void {
    if (this.officeDelegationForm.invalid) {
      this.officeDelegationForm.markAllAsTouched();
      this.officeDelegationModalError.set('Veuillez sélectionner un utilisateur et un profil.');
      return;
    }

    const raw = this.officeDelegationForm.getRawValue();
    const userId = Number(raw.userId);
    const profileId = String(raw.profileId ?? '').trim();

    if (!Number.isInteger(userId) || userId <= 0 || !profileId) {
      this.officeDelegationModalError.set('Veuillez sélectionner un utilisateur et un profil valides.');
      return;
    }

    const alreadyExists = this.officeUserDelegations().some((item) => Number(item.userId) === userId);
    if (alreadyExists) {
      this.officeDelegationModalError.set('Cet utilisateur possède déjà une délégation dans ce cabinet.');
      return;
    }

    this.officeUserDelegations.update((items) => [
      ...items,
      {
        tempKey: this.createTempKey('delegation'),
        userId,
        profileId
      }
    ]);

    this.closeOfficeDelegationModal();
  }

  removeOfficeUserDelegation(tempKey: string): void {
    this.officeUserDelegations.update((items) => items.filter((item) => item.tempKey !== tempKey));
  }

  updateOfficeUserDelegationUser(tempKey: string, value: string): void {
    const parsed = Number(value);
    const userId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    this.officeUserDelegations.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, userId } : item))
    );
  }

  updateOfficeUserDelegationProfile(tempKey: string, value: string): void {
    const profileId = String(value ?? '').trim();
    this.officeUserDelegations.update((items) =>
      items.map((item) => (item.tempKey === tempKey ? { ...item, profileId } : item))
    );
  }

  removeConsultationProfile(profileTempKey: string): void {
    this.consultationProfiles.update((profiles) => profiles.filter((profile) => profile.tempKey !== profileTempKey));
  }

  updateConsultationProfileName(profileTempKey: string, value: string): void {
    this.consultationProfiles.update((profiles) =>
      profiles.map((profile) =>
        profile.tempKey === profileTempKey
          ? { ...profile, name: value }
          : profile
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
            {
              tempKey: this.createTempKey('reason'),
              label: `Motif ${profile.reasons.length + 1}`
            }
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

        return {
          ...profile,
          reasons: profile.reasons.filter((reason) => reason.tempKey !== reasonTempKey)
        };
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
          reasons: profile.reasons.map((reason) =>
            reason.tempKey === reasonTempKey
              ? { ...reason, label: value }
              : reason
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

        return {
          ...profile,
          reasons: this.moveByTempKey(profile.reasons, sourceReasonTempKey, targetReasonTempKey)
        };
      })
    );
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

  async saveOffice(): Promise<void> {
    if (this.officeForm.invalid) {
      this.officeForm.markAllAsTouched();
      return;
    }

    const payload = this.buildOfficePayload();
    const editId = this.editingOfficeId();
    const normalizedPayload = editId
      ? payload
      : {
        ...payload,
        hideVatMention: false,
        vatNumber: '',
        serviceTypes: payload.serviceTypes.map((item) => ({ ...item, vatRate: 0 }))
      };
    const hasInvalidServiceType = normalizedPayload.serviceTypes.some((item) => !item.label.trim());
    const hasInvalidPaymentMethod = normalizedPayload.paymentMethods.some((item) => !item.label.trim());
    if (hasInvalidServiceType || hasInvalidPaymentMethod) {
      this.officesError.set('Les libellés des prestations et moyens de paiement sont obligatoires.');
      return;
    }

    if (editId) {
      this.isUpdatingOffice.set(editId);
    } else {
      this.isCreatingOffice.set(true);
    }

    this.officesError.set('');
    this.officesSuccess.set('');

    try {
      if (editId) {
        const updated = await this.api.updateOffice(editId, normalizedPayload);
        const offices = this.offices().map((o) => (o.id === editId ? updated : o));
        this.offices.set(offices);
      } else {
        const created = await this.api.createOffice(normalizedPayload);
        this.offices.set([...this.offices(), created]);
        try {
          await this.api.deleteNewOfficeDraft();
        } catch {
          // Non-blocking cleanup.
        }
        this.officeDraftSaveState.set('idle');
        this.lastOfficeDraftSavedAt.set(null);
      }

      this.officesSuccess.set(editId ? 'Cabinet mis à jour avec succès' : 'Cabinet créé avec succès');
      this.closeOfficeModal();

      setTimeout(() => {
        this.officesSuccess.set('');
      }, 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur lors de l\'enregistrement';
      this.officesError.set(message);
      console.error('Error saving office:', err);
    } finally {
      this.isCreatingOffice.set(false);
      this.isUpdatingOffice.set(null);
    }
  }

  private isOfficeCreateStepValid(step: OfficeCreateStep): boolean {
    if (step === 1) {
      const raw = this.officeForm.getRawValue();
      return raw.name.trim().length > 0 && Number(raw.defaultSessionDurationMinutes) > 0;
    }

    if (step === 3) {
      const raw = this.officeForm.getRawValue();
      const hasValidNumbering = String(raw.invoiceNumberFormat || '').trim().length > 0
        && String(raw.numberingConfiguration || '').trim().length > 0;
      if (!hasValidNumbering) {
        return false;
      }

      const hasInvalidServiceType = this.serviceTypes().some((item) => !item.label.trim());
      const hasInvalidPaymentMethod = this.paymentMethods().some((item) => !item.label.trim());
      return !hasInvalidServiceType && !hasInvalidPaymentMethod;
    }

    return true;
  }

  private markOfficeCreateStepTouched(step: OfficeCreateStep): void {
    if (step === 1) {
      this.officeForm.controls.name.markAsTouched();
      this.officeForm.controls.defaultSessionDurationMinutes.markAsTouched();
    }

    if (step === 3) {
      this.officeForm.controls.invoiceNumberFormat.markAsTouched();
      this.officeForm.controls.numberingConfiguration.markAsTouched();
    }
  }

  private startOfficeDraftAutosave(): void {
    this.stopOfficeDraftAutosave();

    this.officeDraftStatusTimer = setInterval(() => {
      this.officeDraftStatusNowTick.set(Date.now());
    }, 5_000);

    this.officeDraftAutosaveTimer = setInterval(() => {
      if (!this.isOfficeModalOpen() || this.editingOfficeId()) {
        return;
      }

      void this.persistOfficeDraft();
    }, 8_000);
  }

  private stopOfficeDraftAutosave(): void {
    if (this.officeDraftAutosaveTimer !== null) {
      clearInterval(this.officeDraftAutosaveTimer);
      this.officeDraftAutosaveTimer = null;
    }

    if (this.officeDraftStatusTimer !== null) {
      clearInterval(this.officeDraftStatusTimer);
      this.officeDraftStatusTimer = null;
    }
  }

  private async loadOfficeDraft(): Promise<void> {
    try {
      const draft = await this.api.getNewOfficeDraft();
      if (!draft) {
        return;
      }

      this.applyOfficeDraft(draft);

      const updatedAtMs = Number(new Date(draft.updatedAt));
      if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
        this.lastOfficeDraftSavedAt.set(updatedAtMs);
      }
      this.officeDraftSaveState.set('saved');
    } catch {
      // Non-blocking draft restore.
    }
  }

  private applyOfficeDraft(draft: NewOfficeDraft): void {
    const payload = draft.payload;
    const safeStep = draft.step >= 1 && draft.step <= 6 ? (draft.step as OfficeCreateStep) : 1;

    const openingHours = this.ensureOfficeOpeningHours(payload.openingHours);
    this.officeOpeningHoursDraft.set(openingHours);
    this.officeCreateStep.set(safeStep);

    this.officeForm.patchValue({
      name: String(payload.name ?? ''),
      defaultSessionDurationMinutes: Number(payload.defaultSessionDurationMinutes ?? 60) || 60,
      country: String(payload.country ?? 'France') || 'France',
      devise: payload.devise ?? 'EUR',
      invoiceNumberFormat: payload.invoiceNumberFormat ?? 'AAAA-XXXXXX',
      numberingConfiguration: payload.numberingConfiguration ?? 'Numérotation globale au cabinet',
      alwaysShowSocialSecurityAndMutuelle: Boolean(payload.alwaysShowSocialSecurityAndMutuelle),
      hideVatMention: false,
      addressLine1: String(payload.addressLine1 ?? ''),
      addressLine2: String(payload.addressLine2 ?? ''),
      postalCode: String(payload.postalCode ?? ''),
      city: String(payload.city ?? ''),
      phoneMobile: String(payload.phoneMobile ?? ''),
      phoneLandline: String(payload.phoneLandline ?? ''),
      phoneFax: String(payload.phoneFax ?? ''),
      email: String(payload.email ?? ''),
      website: String(payload.website ?? ''),
      vatNumber: '',
      logoData: String(payload.logoData ?? ''),
      openingHoursJson: JSON.stringify(openingHours)
    });

    this.serviceTypes.set(
      Array.isArray(payload.serviceTypes)
        ? payload.serviceTypes.map((item, index) => ({
          id: Number(item?.id) || 0,
          label: String(item?.label ?? ''),
          amountHt: Number(item?.amountHt) || 0,
          vatRate: 0,
          displayOrder: index + 1,
          tempKey: this.createTempKey('srv')
        }))
        : []
    );

    this.paymentMethods.set(
      Array.isArray(payload.paymentMethods)
        ? payload.paymentMethods.map((item, index) => ({
          id: Number(item?.id) || 0,
          label: String(item?.label ?? ''),
          isActive: Boolean(item?.isActive),
          displayOrder: index + 1,
          tempKey: this.createTempKey('pay')
        }))
        : []
    );

    this.consultationProfiles.set(this.toEditableConsultationProfiles(payload.consultationProfiles));
    this.officeUserDelegations.set(this.toEditableOfficeUserDelegations(payload.officeUserDelegations));
  }

  private buildOfficeDraftPayload(): CreateOfficePayload {
    const payload = this.buildOfficePayload();
    return {
      ...payload,
      hideVatMention: false,
      vatNumber: '',
      serviceTypes: payload.serviceTypes.map((item) => ({ ...item, vatRate: 0 }))
    };
  }

  private async persistOfficeDraft(): Promise<void> {
    if (this.editingOfficeId() || !this.isOfficeModalOpen()) {
      return;
    }

    if (this.isPersistingOfficeDraft) {
      this.pendingOfficeDraftSave = true;
      return;
    }

    this.isPersistingOfficeDraft = true;
    this.officeDraftSaveState.set('saving');

    try {
      await this.api.saveNewOfficeDraft(this.officeCreateStep(), this.buildOfficeDraftPayload());
      this.lastOfficeDraftSavedAt.set(Date.now());
      this.officeDraftSaveState.set('saved');
    } catch {
      this.officeDraftSaveState.set('error');
    } finally {
      this.isPersistingOfficeDraft = false;
      if (this.pendingOfficeDraftSave) {
        this.pendingOfficeDraftSave = false;
        void this.persistOfficeDraft();
      }
    }
  }

  async deleteOffice(officeId: number): Promise<void> {
    if (!confirm('Êtes-vous sûr de vouloir supprimer ce cabinet ?')) {
      return;
    }

    this.isDeletingOffice.set(officeId);
    this.officesError.set('');
    this.officesSuccess.set('');

    try {
      await this.api.deleteOffice(officeId);
      this.offices.set(this.offices().filter((o) => o.id !== officeId));
      this.officesSuccess.set('Cabinet supprimé avec succès');

      setTimeout(() => {
        this.officesSuccess.set('');
      }, 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur lors de la suppression';
      this.officesError.set(message);
      console.error('Error deleting office:', err);
    } finally {
      this.isDeletingOffice.set(null);
    }
  }

  async reorderOffices(officeIds: number[]): Promise<void> {
    try {
      const offices = await this.api.reorderOffices(officeIds);
      this.offices.set(offices);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur lors de la réorganisation';
      this.officesError.set(message);
      console.error('Error reordering offices:', err);
    }
  }

  onOfficeLogoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    // Max 2MB
    if (file.size > 2 * 1024 * 1024) {
      this.officesError.set('Le fichier dépasse 2MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e: ProgressEvent<FileReader>) => {
      const result = e.target?.result;
      if (typeof result === 'string') {
        this.officeForm.patchValue({ logoData: result });
      }
    };

    reader.readAsDataURL(file);
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
    const dayRanges = draft[day] ?? [];
    const nextRanges = [...dayRanges, { start: '09:00', end: '12:00' }];
    const next = { ...draft, [day]: nextRanges };
    this.officeOpeningHoursDraft.set(next);
    this.officeForm.patchValue({ openingHoursJson: JSON.stringify(next) });
  }

  removeOfficeOpeningRange(day: OfficeWeekDay, index: number): void {
    const draft = this.officeOpeningHoursDraft();
    const dayRanges = draft[day] ?? [];

    if (index < 0 || index >= dayRanges.length) {
      return;
    }

    const nextRanges = dayRanges.filter((_, rangeIndex) => rangeIndex !== index);
    const next = { ...draft, [day]: nextRanges };
    this.officeOpeningHoursDraft.set(next);
    this.officeForm.patchValue({ openingHoursJson: JSON.stringify(next) });
  }

  updateOfficeOpeningRange(day: OfficeWeekDay, index: number, field: 'start' | 'end', value: string): void {
    const draft = this.officeOpeningHoursDraft();
    const dayRanges = draft[day] ?? [];

    if (index < 0 || index >= dayRanges.length) {
      return;
    }

    const nextRanges = dayRanges.map((range, rangeIndex) => {
      if (rangeIndex !== index) {
        return range;
      }

      return {
        ...range,
        [field]: value
      };
    });

    const next = { ...draft, [day]: nextRanges };
    this.officeOpeningHoursDraft.set(next);
    this.officeForm.patchValue({ openingHoursJson: JSON.stringify(next) });
  }

  officeOpeningHoursSummary(hours?: OfficeOpeningHours): string {
    const openingHours = this.ensureOfficeOpeningHours(hours);
    const daysWithRanges = this.officeWeekDays.filter((day) => openingHours[day].length > 0);

    if (daysWithRanges.length === 0) {
      return 'Aucun horaire défini';
    }

    return daysWithRanges
      .map((day) => {
        const ranges = openingHours[day]
          .map((range) => `${range.start}-${range.end}`)
          .join(', ');
        return `${this.officeDayLabel(day)}: ${ranges}`;
      })
      .join(' | ');
  }

  private buildOfficePayload(): CreateOfficePayload {
    const raw = this.officeForm.getRawValue();
    return {
      name: raw.name.trim(),
      defaultSessionDurationMinutes: Number(raw.defaultSessionDurationMinutes) || 60,
      country: raw.country.trim(),
      devise: raw.devise as 'EUR' | 'USD' | 'CHF' | 'GBP' | 'CAD',
      invoiceNumberFormat: raw.invoiceNumberFormat,
      numberingConfiguration: raw.numberingConfiguration,
      alwaysShowSocialSecurityAndMutuelle: raw.alwaysShowSocialSecurityAndMutuelle,
      hideVatMention: raw.hideVatMention,
      addressLine1: raw.addressLine1.trim(),
      addressLine2: raw.addressLine2.trim(),
      postalCode: raw.postalCode.trim(),
      city: raw.city.trim(),
      phoneMobile: raw.phoneMobile.trim(),
      phoneLandline: raw.phoneLandline.trim(),
      phoneFax: raw.phoneFax.trim(),
      email: raw.email.trim(),
      website: raw.website.trim(),
      vatNumber: raw.vatNumber.trim(),
      logoData: raw.logoData.trim(),
      openingHours: this.officeOpeningHoursDraft(),
      consultationProfiles: this.toOfficeConsultationProfiles(),
      officeUserDelegations: this.toOfficeUserDelegationsPayload(),
      serviceTypes: this.serviceTypes().map((item, index) => ({
        id: typeof item.id === 'number' && item.id > 0 ? item.id : null,
        label: item.label.trim(),
        amountHt: Number(item.amountHt) || 0,
        vatRate: Number(item.vatRate) || 0,
        displayOrder: index + 1
      })),
      paymentMethods: this.paymentMethods().map((item, index) => ({
        id: typeof item.id === 'number' && item.id > 0 ? item.id : null,
        label: item.label.trim(),
        isActive: item.isActive,
        displayOrder: index + 1
      }))
    };
  }

  private toEditableConsultationProfiles(profiles: OfficeConsultationProfile[] | undefined): EditableConsultationProfile[] {
    if (!Array.isArray(profiles)) {
      return [];
    }

    return profiles.map((profile, profileIndex) => ({
      tempKey: this.createTempKey('profile'),
      id: String(profile?.id ?? '').trim() || this.createTempKey('profile-id'),
      name: String(profile?.name ?? '').trim() || `Profil ${profileIndex + 1}`,
      reasons: Array.isArray(profile?.reasons)
        ? profile.reasons.map((reason, reasonIndex) => ({
          tempKey: this.createTempKey('reason'),
          label: String(reason ?? '').trim() || `Motif ${reasonIndex + 1}`
        }))
        : []
    }));
  }

  private toOfficeConsultationProfiles(): OfficeConsultationProfile[] {
    return this.consultationProfiles()
      .map((profile, profileIndex) => ({
        id: profile.id,
        name: profile.name.trim() || `Profil ${profileIndex + 1}`,
        reasons: profile.reasons
          .map((reason) => reason.label.trim())
          .filter((reason) => reason.length > 0),
        displayOrder: profileIndex + 1
      }))
      .filter((profile) => profile.name.length > 0);
  }

  private toEditableOfficeUserDelegations(
    delegations: Array<{ userId: number; profileId: string }> | undefined
  ): EditableOfficeUserDelegation[] {
    if (!Array.isArray(delegations)) {
      return [];
    }

    const editableDelegations: EditableOfficeUserDelegation[] = [];
    for (const delegation of delegations) {
      const userId = Number(delegation?.userId);
      const profileId = String(delegation?.profileId ?? '').trim();
      if (!Number.isInteger(userId) || userId <= 0 || !profileId) {
        continue;
      }

      editableDelegations.push({
        tempKey: this.createTempKey('delegation'),
        userId,
        profileId
      });
    }

    return editableDelegations;
  }

  private toOfficeUserDelegationsPayload(): Array<{ userId: number; profileId: string }> {
    const seenUsers = new Set<number>();

    return this.officeUserDelegations()
      .map((item) => {
        const userId = Number(item.userId);
        const profileId = String(item.profileId ?? '').trim();
        if (!Number.isInteger(userId) || userId <= 0 || !profileId) {
          return null;
        }

        if (seenUsers.has(userId)) {
          return null;
        }

        seenUsers.add(userId);
        return { userId, profileId };
      })
      .filter((item): item is { userId: number; profileId: string } => item !== null);
  }

  private createDefaultOfficeOpeningHours(): OfficeOpeningHours {
    return {
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: []
    };
  }

  private ensureOfficeOpeningHours(openingHours?: OfficeOpeningHours): OfficeOpeningHours {
    const defaults = this.createDefaultOfficeOpeningHours();

    if (!openingHours) {
      return defaults;
    }

    for (const day of this.officeWeekDays) {
      const ranges = openingHours[day];
      defaults[day] = Array.isArray(ranges)
        ? ranges
          .map((range) => ({
            start: typeof range?.start === 'string' ? range.start : '09:00',
            end: typeof range?.end === 'string' ? range.end : '12:00'
          }))
          .filter((range) => range.start && range.end)
        : [];
    }

    return defaults;
  }
}