export type AuthUser = {
  id: number;
  username: string;
  role: string;
  profileId?: string | null;
  profileLabel?: string | null;
  officeIds?: number[];
  offices?: OfficeOption[];
  rights?: AccessRightsByDomain;
};

export type OfficeOption = {
  id: number;
  name: string;
};

export type AccessManagedUser = {
  id: number;
  username: string;
  createdAt: string;
  role: string;
  isActive: boolean;
  profileId: string | null;
  profileLabel: string | null;
  officeId: number | null;
  officeIds: number[];
  cabinetName: string;
  lastName: string;
  firstName: string;
  email: string;
  mobilePhone: string;
  country: string;
  siret: string;
  adeliCode: string;
  rppsCode: string;
  apeNafCode: string;
  nameSuffixText: string;
  letterHeader: string;
  letterFooter: string;
  signatureText: string;
  colorHex: string;
  bankName: string;
  iban: string;
  retrocessionPercent: number;
  retrocessionRecipient: string;
  defaultAgendaView: string;
  visibleCalendars: string;
  defaultService: string;
  invoiceMentions: string;
  includeFreeConsultations: boolean;
  showConsultationHour: boolean;
};

export type AccessManagedUsersPayload = {
  users: AccessManagedUser[];
};

export type UserAccountPayload = {
  isActive: boolean;
  profileId: string;
  role?: string;
  officeId: number | null;
  officeIds: number[];
  username: string;
  password?: string;
  lastName: string;
  firstName: string;
  email: string;
  mobilePhone: string;
  country: string;
  siret: string;
  adeliCode: string;
  rppsCode: string;
  apeNafCode: string;
  nameSuffixText: string;
  letterHeader: string;
  letterFooter: string;
  signatureText: string;
  colorHex: string;
  bankName: string;
  iban: string;
  retrocessionPercent: number;
  retrocessionRecipient: string;
  defaultAgendaView: string;
  visibleCalendars: string;
  defaultService: string;
  invoiceMentions: string;
  includeFreeConsultations: boolean;
  showConsultationHour: boolean;
};

export type Practitioner = {
  id: number;
  username: string;
  role: string;
};

export type PractitionersPayload = {
  practitioners: Practitioner[];
};

export type Appointment = {
  id: number;
  time: string;
  patient: string;
  reason: string;
  status: 'A confirmer' | 'En attente' | 'Termine';
};

export type AppointmentsPayload = {
  appointments: Appointment[];
  offices?: OfficeOption[];
  selectedOfficeId?: number | null;
  stats: {
    consultationsToday: number;
    newPatients: number;
    occupancyRate: string;
  };
};

export type CreateAppointmentPayload = {
  patientId: number;
  startsAt: string;
  reason: string;
  status: 'A confirmer' | 'En attente' | 'Termine';
  localCalendarId?: number | null;
  consultationId?: number | null;
};

export type Patient = {
  id: number;
  fullName: string;
  phone: string;
  lastVisit: string;
  sex: 'Non renseigne' | 'Femme' | 'Homme';
  age: number | null;
  consultationCount: number;
};

export type LocationPair = {
  postalCode: string;
  city: string;
};

export type DirectoryContact = {
  id: number;
  officeId: number;
  officeName: string;
  kind: 'person' | 'company';
  firstName: string;
  lastName: string;
  organization: string;
  displayName: string;
  role: string;
  email: string;
  mobilePhone: string;
  landlinePhone: string;
  address1: string;
  address2: string;
  postalCode: string;
  city: string;
  country: string;
  notes: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DirectoryContactPayload = {
  officeId: number;
  kind: 'person' | 'company';
  firstName: string;
  lastName: string;
  organization: string;
  role: string;
  email: string;
  mobilePhone: string;
  landlinePhone: string;
  address1: string;
  address2: string;
  postalCode: string;
  city: string;
  country: string;
  notes: string;
  isActive: boolean;
};

export type DirectoryContactsPayload = {
  contacts: DirectoryContact[];
  offices: OfficeOption[];
  selectedOfficeId?: number | null;
};

export type CreatePatientPayload = {
  lastName: string;
  firstName: string;
  sex: 'Non renseigne' | 'Femme' | 'Homme';
  birthDate: string;
  mobilePhone: string;
  landlinePhone: string;
  email: string;
  address1: string;
  address2: string;
  postalCode: string;
  city: string;
  country: string;
  occupationOrSchool: string;
  hobbies: string;
  primaryDoctor: string;
  socialSecurityNumber: string;
  referredBy: string;
  manualPreference: 'Non renseigne' | 'Droitier' | 'Gaucher';
  generalRemarks: string;
  relatedPeople: string;
  isDeceased: boolean;
  medicalHistory: string;
  consultationNote: string;
  consultationLinkStrategy?: 'attach-existing' | 'create-new';
};

export type PeoplePickerContact = {
  id: number;
  fullName: string;
  role: string;
  city?: string;
};

export type CreatedPatient = {
  id: number;
  fullName: string;
};

export type InvoiceSummaryTile = {
  label: string;
  value: string;
  trend: string;
};

export type DashboardEvent = {
  id: number;
  patientId: number;
  title: string;
  start: string;
  patient: string;
  reason: string;
  status: string;
  calendarId: number | null;
  calendarColor: string | null;
  practitionerColor: string | null;
  patientSex: 'Non renseigne' | 'Femme' | 'Homme';
  patientMobilePhone: string;
  patientLandlinePhone: string;
  appointmentComment: string;
  patientRemarks: string;
  consultationType: string;
  consultationId: number | null;
  consultationTitle: string;
  consultationPractitioner: string;
};

export type UpdateAppointmentConsultationMetaPayload = {
  title: string;
  practitioner: string;
  linkStrategy?: 'attach-existing' | 'create-new';
};

export type ConsultationMetaSummary = {
  id: number;
  title: string;
  practitioner: string;
  linkedToExisting?: boolean;
};

export type AppointmentConsultationConflict = {
  existingConsultation: {
    id: number;
    title: string;
    practitioner: string;
    startedAt: string;
  };
};

export type LocalAgendaCalendar = {
  id: number | null;
  name: string;
  description: string;
  colorHex: string;
  visibility: 'all' | 'selected';
  visibleUserIds: number[];
  visibleUsernames: string[];
  officeId: number | null;
  displayOrder: number;
};

export type AgendaSettings = {
  dayStartHour?: number;
  dayEndHour?: number;
  lunchStartHour: number;
  lunchEndHour: number;
  defaultSessionDurationMinutes: number;
  slotDurationMinutes: number;
  displayHeight: number;
  showWeekend: boolean;
  autoConsultationType: boolean;
  showPatientSex: boolean;
  showPatientMobilePhone: boolean;
  showPatientLandlinePhone: boolean;
  showAppointmentComment: boolean;
  patientRemarksDisplay: 'hidden' | 'edit' | 'readonly';
  appointmentColorMode: 'calendar' | 'user';
};

export type AgendaSettingsPayload = {
  settings: AgendaSettings;
  localCalendars: LocalAgendaCalendar[];
};

export type UserAgendaPreferences = {
  slotDurationMinutes: number;
  displayHeight: number;
  pdfDisplayMode: 'browser' | 'download';
  consultationOrder: 'Chronologique' | 'Antichronologique';
  groupConsultationsByYearFrom: number;
  patientAutoSaveFrequency: 'Jamais' | 'Toutes les 2 minutes' | 'Toutes les 5 minutes' | 'Toutes les 10 minutes';
  showWeekend: boolean;
  showPatientSex: boolean;
  showPatientMobilePhone: boolean;
  showPatientLandlinePhone: boolean;
  showAppointmentComment: boolean;
  patientRemarksDisplay: 'hidden' | 'edit' | 'readonly';
  appointmentColorMode: 'calendar' | 'user';
};

export type MonthlyConsultationPoint = {
  month: string;
  count: number;
};

export type DistributionPoint = {
  label: string;
  count: number;
};

export type RecentPatient = {
  id: number;
  fullName: string;
  phone: string;
  lastVisit: string;
};

export type PendingPayment = {
  invoiceNumber: string;
  patientName: string;
  amountEur: number;
  dueAt: string;
  status: string;
};

export type DashboardPayload = {
  events: DashboardEvent[];
  monthlyConsultations: MonthlyConsultationPoint[];
  patientsBySex: DistributionPoint[];
  patientsByAgeRange: DistributionPoint[];
  recentPatients: RecentPatient[];
  pendingPayments: PendingPayment[];
  agendaSettings: AgendaSettings;
  localCalendars: LocalAgendaCalendar[];
};

export type AppConfig = {
  app_name: string;
  version: string;
};

export type AntecedentTypesPayload = {
  types: string[];
};

export type NewPatientDraft = {
  step: number;
  payload: CreatePatientPayload;
  updatedAt: string;
};

export type NewPatientDraftPayload = {
  draft: NewPatientDraft | null;
};

export type PatientDetail = {
  id: number;
  fullName: string;
  lastName: string;
  firstName: string;
  sex: 'Non renseigne' | 'Femme' | 'Homme';
  birthDate: string;
  age: number | null;
  lastVisit: string;
  consultationCount: number;
  phone: string;
  mobilePhone: string;
  landlinePhone: string;
  email: string;
  address1: string;
  address2: string;
  postalCode: string;
  city: string;
  country: string;
  occupationOrSchool: string;
  hobbies: string;
  primaryDoctor: string;
  socialSecurityNumber: string;
  referredBy: string;
  manualPreference: 'Non renseigne' | 'Droitier' | 'Gaucher';
  generalRemarks: string;
  medicalHistory: string;
  relatedPeople: string;
  isDeceased: boolean;
};

export type ConsultationRecord = {
  id: number;
  type: 'consultation' | 'appointment';
  startedAt: string;
  practitioner: string;
  title: string;
  important: boolean;
  heightCm: number | null;
  weightKg: number | null;
  evaBefore: number;
  evaAfter: number;
  profile: string;
  motifMainHtml: string;
  testsHtml: string;
  schemaHtml: string;
  treatmentsHtml: string;
  remarksHtml: string;
  status: string;
};

export type PatientAuditFieldChange = {
  field: string;
  before: string;
  after: string;
};

export type PatientAuditLog = {
  id: number;
  createdAt: string;
  username: string;
  changes: PatientAuditFieldChange[];
};

export type SystemAuditLog = {
  id: number;
  createdAt: string;
  username: string;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
};

export type ServiceTypeSetting = {
  id: number | null;
  label: string;
  amountHt: number;
  vatRate: number;
  displayOrder: number;
};

export type PaymentMethodSetting = {
  id: number | null;
  label: string;
  isActive: boolean;
  displayOrder: number;
};

export type InvoiceNumberFormat =
  | 'AAAA-XXXXXX'
  | 'AAAAMM-XXXXXX'
  | 'AAAAMMJJ-XXXXXX'
  | 'AAAAMM-XXXX : RAZ mensuelle (déconseillé)'
  | 'AAAA-XXXX : RAZ annuel';

export type InvoiceNumberingConfiguration = 'Numérotation globale au cabinet' | 'Numérotation par praticien';

export type GeneralSettingsPayload = {
  backupReminderFrequency: 'Toutes les semaines' | 'Tous les 15 jours' | 'Tous les mois' | 'Tous les 2 mois';
};

export type UpdatePatientPayload = {
  lastName?: string;
  firstName?: string;
  sex?: 'Non renseigne' | 'Femme' | 'Homme';
  birthDate?: string;
  mobilePhone?: string;
  landlinePhone?: string;
  email?: string;
  address1?: string;
  address2?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  occupationOrSchool?: string;
  hobbies?: string;
  primaryDoctor?: string;
  socialSecurityNumber?: string;
  referredBy?: string;
  manualPreference?: 'Non renseigne' | 'Droitier' | 'Gaucher';
  generalRemarks?: string;
  relatedPeople?: string;
  medicalHistory?: string;
};

export type AccessRightsByDomain = Record<string, Record<string, boolean>>;

export type AccessProfile = {
  id: string;
  label: string;
  description: string;
  immutable: boolean;
  rights: AccessRightsByDomain;
};

export type AccessProfilesPayload = {
  profiles: AccessProfile[];
};

export type CreateAccessProfilePayload = {
  label: string;
  description: string;
};

export type UpdateAccessProfileRightsPayload = {
  rights: AccessRightsByDomain;
};

export type OfficeWeekDay =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export type OfficeOpeningRange = {
  start: string;
  end: string;
};

export type OfficeOpeningHours = Record<OfficeWeekDay, OfficeOpeningRange[]>;

export type Office = {
  id: number;
  name: string;
  defaultSessionDurationMinutes: number;
  country: string;
  devise: 'EUR' | 'USD' | 'CHF' | 'GBP' | 'CAD';
  invoiceNumberFormat: InvoiceNumberFormat;
  numberingConfiguration: InvoiceNumberingConfiguration;
  alwaysShowSocialSecurityAndMutuelle: boolean;
  hideVatMention: boolean;
  addressLine1?: string;
  addressLine2?: string;
  postalCode?: string;
  city?: string;
  phoneMobile?: string;
  phoneLandline?: string;
  phoneFax?: string;
  email?: string;
  website?: string;
  vatNumber?: string;
  logoData?: string;
  openingHours?: OfficeOpeningHours;
  serviceTypes: ServiceTypeSetting[];
  paymentMethods: PaymentMethodSetting[];
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateOfficePayload = {
  name: string;
  defaultSessionDurationMinutes: number;
  country: string;
  devise: 'EUR' | 'USD' | 'CHF' | 'GBP' | 'CAD';
  invoiceNumberFormat: InvoiceNumberFormat;
  numberingConfiguration: InvoiceNumberingConfiguration;
  alwaysShowSocialSecurityAndMutuelle: boolean;
  hideVatMention: boolean;
  addressLine1?: string;
  addressLine2?: string;
  postalCode?: string;
  city?: string;
  phoneMobile?: string;
  phoneLandline?: string;
  phoneFax?: string;
  email?: string;
  website?: string;
  vatNumber?: string;
  logoData?: string;
  openingHours?: OfficeOpeningHours;
  serviceTypes: ServiceTypeSetting[];
  paymentMethods: PaymentMethodSetting[];
};

export type UpdateOfficePayload = CreateOfficePayload & {
  isActive?: boolean;
};

export type OfficesPayload = {
  offices: Office[];
};
