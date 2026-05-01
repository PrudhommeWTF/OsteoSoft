export type AuthUser = {
  id: number;
  username: string;
  role: string;
  profileId?: string | null;
  profileLabel?: string | null;
  officeIds?: number[];
  offices?: OfficeOption[];
  rights?: AccessRightsByDomain;
  mustChangePassword?: boolean;
};

export type OfficeOption = {
  id: number;
  name: string;
  paymentMethods?: string[];
};

export type SetupStatus = {
  requiresSetup: boolean;
  hasEncryptionKey: boolean;
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
  defaultAgendaView: string;
  defaultYearsForStatistics: number;
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
  defaultAgendaView: string;
  defaultYearsForStatistics: number;
  invoiceMentions: string;
  includeFreeConsultations: boolean;
  showConsultationHour: boolean;
};

export type MyUserProfile = AccessManagedUser;

export type UpdateMyUserProfilePayload = Omit<
  UserAccountPayload,
  'isActive' | 'profileId' | 'role' | 'officeId' | 'officeIds'
>;

export type BackupRestoreTempPassword = {
  userId: number;
  username: string;
  tempPassword: string;
};

export type BackupRestoreResult = {
  tempPasswords: BackupRestoreTempPassword[];
};

export type Practitioner = {
  id: number;
  username: string;
  displayName?: string;
  role: string;
};

export type ConsultationReasonItem = {
  label: string;
  value: string;
  important: boolean;
};

export type PractitionersPayload = {
  practitioners: Practitioner[];
};

export type ConsultationContextPayload = {
  officeId: number | null;
  officeName: string | null;
  practitioners: Practitioner[];
  profiles: OfficeConsultationProfile[];
  serviceTypes?: Array<{ label: string; amountHt: number; vatRate: number; displayOrder: number }>;
  paymentMethods?: string[];
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
  patientId?: number | null;
  patientFirstName?: string;
  patientLastName?: string;
  isPrivate?: boolean;
  privateReason?: string;
  practitioner?: string;
  startsAt: string;
  reason: string;
  status: 'A confirmer' | 'En attente' | 'Termine';
  localCalendarId?: number | null;
  consultationId?: number | null;
  officeId?: number | null;
};

export type Patient = {
  id: number;
  fullName: string;
  phone: string;
  lastVisit: string;
  sex: 'Non renseigne' | 'Femme' | 'Homme';
  age: number | null;
  city: string;
  consultationCount: number;
};

export type MaritalStatus =
  | 'Non renseigne'
  | 'Celibataire'
  | 'Marie(e)'
  | 'Pacse(e)'
  | 'Divorce(e)'
  | 'Veuf(ve)';

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
  maritalStatus: MaritalStatus;
  childrenCount: number;
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
  consultationDocuments?: ConsultationDocumentUploadPayload[];
  consultationLinkStrategy?: 'attach-existing' | 'create-new';
};

export type ConsultationDocumentUploadPayload = {
  documentRef?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  comment: string;
  contentBase64: string;
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

export type CreatedPatientConsultationResult = {
  id: number;
  officeId: number | null;
  appointmentId: number | null;
  linkedToExisting: boolean;
};

export type CreatePatientResult = {
  patient: CreatedPatient;
  consultation: CreatedPatientConsultationResult | null;
  documents: PatientDocumentSummary[];
};

export type InvoiceSummaryTile = {
  label: string;
  value: string;
  trend: string;
};

export type BillingOperation = {
  id: string;
  sourceType: 'invoice' | 'expense' | 'deposit';
  sourceId: number;
  occurredAt: string;
  title: string;
  debitCents: number;
  creditCents: number;
  currency: string;
  officeId: number | null;
  ownerUserId: number | null;
  retrocessionPercent: number;
  retrocessionRecipient: string;
  invoiceNumber: string;
  remainingAmountCents: number;
  depositId: number | null;
  depositType: 'cheque' | 'especes' | null;
  paymentRef:
    | { type: 'patient'; patientId: number }
    | { type: 'expense'; expenseId: number }
    | { type: 'deposit'; depositId: number };
};

export type BillingUserOption = {
  id: number;
  displayName: string;
};

export type BillingOperationsPayload = {
  operations: BillingOperation[];
  summary: InvoiceSummaryTile[];
  stats: {
    debitCents: number;
    creditCents: number;
    netCents: number;
    operationCount: number;
  };
  offices: OfficeOption[];
  users: BillingUserOption[];
  selectedOwnerUserId: number | null;
  selectedOfficeId: number | null;
  from: string;
  to: string;
};

export type BillingInsightsPayload = {
  range: {
    fromIso: string;
    toIso: string;
    previousFromIso: string;
    previousToIso: string;
  };
  kpis: {
    current: {
      creditsCents: number;
      debitsCents: number;
      netCents: number;
      operationCount: number;
    };
    previous: {
      creditsCents: number;
      debitsCents: number;
      netCents: number;
      operationCount: number;
    };
    trends: {
      creditsPercent: number;
      debitsPercent: number;
      netPercent: number;
      operationsPercent: number;
    };
  };
  receivables: {
    totalOutstandingCents: number;
    totalOutstandingCount: number;
    aging: {
      current: { count: number; amountCents: number };
      late1to30: { count: number; amountCents: number };
      late31to60: { count: number; amountCents: number };
      late61plus: { count: number; amountCents: number };
    };
    topDebtors: Array<{
      patientName: string;
      totalOutstandingCents: number;
      invoiceCount: number;
    }>;
  };
  paymentMethods: Array<{
    label: string;
    count: number;
  }>;
  summary: InvoiceSummaryTile[];
};

export type BillingForecastPayload = {
  generatedAt: string;
  officeIds: number[];
  trailing90Days: {
    creditsCents: number;
    debitsCents: number;
    netCents: number;
    averageDailyNetCents: number;
  };
  overdueOutstandingCents: number;
  horizons: Record<string, {
    expectedReceiptsCents: number;
    projectedNetRunRateCents: number;
    horizonEndIso: string;
  }>;
};

export type BillingAlertsPayload = {
  generatedAt: string;
  summary: {
    overdueCriticalCount: number;
    dueSoonCount: number;
    highExpensesCount: number;
    unassignedOwnerCount: number;
  };
  overdueCritical: Array<{
    invoiceId: number;
    invoiceNumber: string;
    patientName: string;
    dueAt: string;
    daysLate: number;
    remainingAmountCents: number;
    officeId: number | null;
  }>;
  dueSoon: Array<{
    invoiceId: number;
    invoiceNumber: string;
    patientName: string;
    dueAt: string;
    remainingAmountCents: number;
    officeId: number | null;
  }>;
  highExpenses: Array<{
    expenseId: number;
    occurredAt: string;
    title: string;
    amountCents: number;
    currency: string;
    officeId: number | null;
  }>;
  unassignedOwnerOperations: Array<{
    id: string;
    sourceType: 'invoice' | 'expense' | 'deposit';
    occurredAt: string;
    title: string;
    officeId: number | null;
  }>;
};

export type BillingExpensePayload = {
  occurredAt: string;
  officeId: number | null;
  ownerUserId: number | null;
  title: string;
  amount: number;
  currency: string;
  paymentMethod?: string;
  notes?: string;
};

export type BillingInvoiceLineItemPayload = {
  label: string;
  quantity: number;
  unitAmountHtCents: number;
  vatRate: number;
  displayOrder?: number;
};

export type BillingInvoicePaymentPayload = {
  paidAt: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  bankName?: string;
  chequeNumber?: string;
  reference?: string;
  notes?: string;
};

export type BillingInvoicePaymentsUpdatePayload = {
  payments: BillingInvoicePaymentPayload[];
};

export type BillingGroupedInvoicePaymentPayload = {
  invoiceIds: number[];
  payment: BillingInvoicePaymentPayload;
};

export type BillingGroupedInvoicePaymentResult = {
  reference: string;
  totalAmountCents: number;
  allocatedAmountCents: number;
  unallocatedAmountCents: number;
  allocations: Array<{
    invoiceId: number;
    invoiceNumber: string;
    allocatedAmountCents: number;
  }>;
};

export type BillingInvoiceCreatePayload = {
  patientId: number;
  consultationId: number | null;
  officeId: number | null;
  invoiceNumber: string;
  amountCents: number;
  status: 'payee' | 'impayee' | 'partiellement_payee';
  paymentMethod: string;
  issuedAt: string;
  currency?: string;
  notes: string;
  lineItems?: BillingInvoiceLineItemPayload[];
  payments?: BillingInvoicePaymentPayload[];
};

export type BillingInvoiceDetail = {
  id: number;
  patientId: number;
  patientName: string;
  consultationId: number | null;
  consultationStartedAt: string | null;
  officeId: number | null;
  officeName: string;
  invoiceNumber: string;
  amountCents: number;
  paidAmountCents: number;
  remainingAmountCents: number;
  status: 'payee' | 'impayee' | 'partiellement_payee' | 'annulee';
  issuedAt: string;
  dueAt: string;
  notes: string;
  paymentMethod: string;
  lineItems: Array<{
    id: number;
    label: string;
    quantity: number;
    unitAmountHtCents: number;
    vatRate: number;
    displayOrder: number;
  }>;
  payments: Array<{
    id: number;
    paidAt: string;
    amountCents: number;
    currency: string;
    paymentMethod: string;
    bankName: string;
    chequeNumber: string;
    reference: string;
    notes: string;
  }>;
};

export type BillingDepositPayload = {
  occurredAt: string;
  officeId: number | null;
  ownerUserId: number | null;
  type: 'cheque' | 'especes';
  depositCode?: string;
  bankName?: string;
  accountLabel?: string;
  title?: string;
  amount?: number;
  currency: string;
  notes?: string;
  operationIds: string[];
};

export type BillingDepositListItem = {
  id: number;
  type: 'cheque' | 'especes';
  code: string;
  occurredAt: string;
  bankName: string;
  accountLabel: string;
  chequeCount: number;
  amountCents: number;
  currency: string;
  officeId: number | null;
  officeName: string;
  title: string;
  notes: string;
  operationIds: string[];
};

export type BillingDepositCandidate = {
  operationId: string;
  sourceId: number;
  patientId: number | null;
  consultationId: number | null;
  occurredAt: string;
  patientName: string;
  invoiceNumber: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  officeId: number | null;
  groupRef: string | null;
  bankName: string;
  chequeNumber: string;
  paidAt: string | null;
};

export type BillingDepositDetail = {
  deposit: BillingDepositListItem;
  office: {
    id: number | null;
    name: string;
    address1: string;
    address2: string;
    postalCode: string;
    city: string;
    country: string;
    phone: string;
    email: string;
  };
  items: Array<{
    operationId: string;
    occurredAt: string;
    patientName: string;
    invoiceNumber: string;
    amountCents: number;
    currency: string;
    groupRef: string | null;
    bankName: string;
    chequeNumber: string;
    paidAt: string | null;
  }>;
};

export type BillingBulkUpdatePayload = {
  operationIds: string[];
  ownerUserId?: number | null;
  retrocessionPercent?: number | null;
  retrocessionRecipient?: string | null;
  delete?: boolean;
};

export type DashboardEvent = {
  id: number;
  patientId: number;
  title: string;
  start: string;
  patient: string;
  isNewPatient?: boolean;
  isPrivate?: boolean;
  privateReason?: string;
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
  themeMode: 'system' | 'light' | 'dark';
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
  patientId: number;
  consultationId: number | null;
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
  patientsByAgeRangeAndSex: StatisticsAgeSexPoint[];
  recentPatients: RecentPatient[];
  pendingPayments: PendingPayment[];
  agendaSettings: AgendaSettings;
  localCalendars: LocalAgendaCalendar[];
  officeOpeningHoursById?: Record<number, OfficeOpeningHours>;
};

export type StatisticsScopeMode = 'active-office' | 'consolidated';

export type StatisticsGranularity = 'month' | 'quarter' | 'year';

export type StatisticsFilters = {
  scopeMode?: StatisticsScopeMode;
  officeId?: number | null;
  years?: number;
  yearlyBreakdownYears?: number[];
  consultationGranularity?: StatisticsGranularity;
  userId?: number | null;
};

export type StatisticsUserOption = {
  id: number;
  displayName: string;
};

export type StatisticsValuePoint = {
  label: string;
  value: number;
};

export type StatisticsAgeSexPoint = {
  label: string;
  femaleCount: number;
  maleCount: number;
  unknownCount: number;
  totalCount: number;
};

export type StatisticsPatientRankItem = {
  rank: number;
  patientId: number;
  lastName: string;
  firstName: string;
  fullName: string;
  age: number | null;
  count: number;
};

export type StatisticsConsultationReasonRankItem = {
  rank: number;
  profile: string;
  reason: string;
  consultationCount: number;
};

export type StatisticsCityRankItem = {
  rank: number;
  city: string;
  postalCode: string;
  patientCount: number;
};

export type StatisticsAntecedentRankItem = {
  rank: number;
  category: string;
  label: string;
  patientCount: number;
};

export type StatisticsReferralRankItem = {
  rank: number;
  source: string;
  patientCount: number;
};

export type StatisticsYearSeries = {
  year: number;
  points: StatisticsValuePoint[];
};

export type StatisticsScopePayload = {
  mode: StatisticsScopeMode;
  offices: OfficeOption[];
  selectedOfficeId: number | null;
  users: StatisticsUserOption[];
  selectedUserId: number | null;
  canViewPeerStatistics: boolean;
};

export type StatisticsPatientsPayload = {
  bySex: DistributionPoint[];
  byAgeRangeAndSex: StatisticsAgeSexPoint[];
  topFollowedPatients: StatisticsPatientRankItem[];
  topMissedAppointments: StatisticsPatientRankItem[];
  topConsultationReasons: StatisticsConsultationReasonRankItem[];
  topCities: StatisticsCityRankItem[];
  topAntecedents: StatisticsAntecedentRankItem[];
  topReferrals: StatisticsReferralRankItem[];
};

export type StatisticsConsultationsPayload = {
  evolution: StatisticsValuePoint[];
  monthlyByYear: StatisticsYearSeries[];
  byType: DistributionPoint[];
  byUser: DistributionPoint[];
};

export type StatisticsPaymentsPayload = {
  revenueEvolution: StatisticsValuePoint[];
  revenueMonthlyByYear: StatisticsYearSeries[];
  profitEvolution: StatisticsValuePoint[];
  profitMonthlyByYear: StatisticsYearSeries[];
  paymentMethods: DistributionPoint[];
};

export type StatisticsUserPayload = {
  user: StatisticsUserOption;
  revenueEvolution: StatisticsValuePoint[];
  revenueMonthlyByYear: StatisticsYearSeries[];
  profitEvolution: StatisticsValuePoint[];
  profitMonthlyByYear: StatisticsYearSeries[];
  consultationEvolution: StatisticsValuePoint[];
  consultationMonthlyByYear: StatisticsYearSeries[];
  paymentMethods: DistributionPoint[];
};

export type StatisticsPayload = {
  scope: StatisticsScopePayload;
  filters: {
    years: number;
    availableYears: number[];
    selectedYears: number[];
    consultationGranularity: StatisticsGranularity;
  };
  patients: StatisticsPatientsPayload;
  consultations: StatisticsConsultationsPayload;
  payments: StatisticsPaymentsPayload;
  userStats: StatisticsUserPayload | null;
};

export type AppConfig = {
  app_name: string;
  version?: string;
};

export type AntecedentTypesPayload = {
  types: string[];
};

export type PatientAntecedentRecord = {
  id: number;
  datePrecision: 'date' | 'month' | 'year';
  date: string;
  category: string;
  description: string;
  important: boolean;
  sortKey: number;
};

export type PatientAntecedentsPayload = {
  antecedents: PatientAntecedentRecord[];
};

export type NewPatientDraft = {
  step: number;
  payload: CreatePatientPayload;
  updatedAt: string;
};

export type NewPatientDraftPayload = {
  draft: NewPatientDraft | null;
};

export type NewOfficeDraft = {
  step: number;
  payload: CreateOfficePayload;
  updatedAt: string;
};

export type NewOfficeDraftPayload = {
  draft: NewOfficeDraft | null;
};

export type NewConsultationDraft = {
  step: number;
  payload: CreatePatientConsultationPayload;
  updatedAt: string;
};

export type NewConsultationDraftPayload = {
  draft: NewConsultationDraft | null;
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
  maritalStatus: MaritalStatus;
  childrenCount: number;
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
  consentSigned: boolean;
  consentSignedAt: string | null;
  consentFormVersion: string;
  consentWithdrawnAt: string | null;
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
  reasonItems: ConsultationReasonItem[];
  motifMainHtml: string;
  testsHtml: string;
  schemaHtml: string;
  treatmentsHtml: string;
  remarksHtml: string;
  status: string;
  billingInvoiceId?: number | null;
};

export type ConsultationUpdatePayload = {
  startedAt: string;
  practitioner: string;
  title: string;
  important: boolean;
  heightCm: number | null;
  weightKg: number | null;
  evaBefore: number;
  evaAfter: number;
  profile: string;
  reasonItems: ConsultationReasonItem[];
  motifMainHtml: string;
  testsHtml: string;
  schemaHtml: string;
  treatmentsHtml: string;
  remarksHtml: string;
};

export type CreatePatientConsultationPayload = ConsultationUpdatePayload & {
  officeId?: number | null;
  consultationDocuments?: ConsultationDocumentUploadPayload[];
};

export type PatientDocumentSummary = {
  id: number;
  documentRef: string;
  consultationId: number | null;
  officeId: number | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  comment: string;
  createdAt: string;
  link: string;
};

export type PatientDocumentDetail = PatientDocumentSummary & {
  patientId: number;
  contentBase64: string;
};

export type CreatePatientDocumentPayload = {
  consultationId?: number | null;
  officeId?: number | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  comment: string;
  contentBase64: string;
};

export type UpdatePatientDocumentPayload = {
  title: string;
  comment: string;
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
  systemKey?: 'cb' | 'especes' | 'cheque' | null;
  isSystem?: boolean;
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

export type DataImportFormat = 'csv' | 'xlsx';

export type DataImportDataset = 'patients' | 'directory-contacts' | 'mixed';

export type DataImportPayload = {
  officeId: number;
  format: DataImportFormat;
  dataset: DataImportDataset;
  fileName: string;
  contentBase64: string;
};

export type DataImportErrorItem = {
  row: string;
  message: string;
};

export type DataImportResult = {
  importedPatients: number;
  importedContacts: number;
  importedConsultations: number;
  skippedRows: number;
  errorCount: number;
  errors: DataImportErrorItem[];
};

export type DataCleanupKind = 'cities' | 'banks' | 'referred-by' | 'primary-doctors';

export type DataCleanupItem = {
  key: string;
  count: number;
  value: string;
  postalCode?: string;
};

export type DataCleanupItemsPayload = {
  kind: DataCleanupKind;
  items: DataCleanupItem[];
};

export type DataCleanupChangePayload = {
  sourceValue: string;
  replacementValue: string;
  sourcePostalCode?: string;
  replacementPostalCode?: string;
};

export type DataCleanupApplyPayload = {
  kind: DataCleanupKind;
  changes: DataCleanupChangePayload[];
};

export type DataCleanupApplyResult = {
  kind: DataCleanupKind;
  updatedCount: number;
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
  maritalStatus?: MaritalStatus;
  childrenCount?: number;
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

export type OfficeConsultationProfile = {
  id: string;
  name: string;
  reasons: string[];
  displayOrder: number;
};

export type OfficeUserDelegation = {
  userId: number;
  profileId: string;
  username: string;
  displayName: string;
  profileLabel: string;
};

export type OfficeUserDelegationPayload = {
  userId: number;
  profileId: string;
};

export type OfficeLetterTemplate = {
  title: string;
  content: string;
};

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
  invoiceTemplateLayoutJson: string;
  openingHours?: OfficeOpeningHours;
  consultationProfiles: OfficeConsultationProfile[];
  paymentReminderLetterTemplate: OfficeLetterTemplate;
  patientLetterTemplates: OfficeLetterTemplate[];
  officeUserDelegations: OfficeUserDelegation[];
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
  invoiceTemplateLayoutJson: string;
  openingHours?: OfficeOpeningHours;
  consultationProfiles: OfficeConsultationProfile[];
  paymentReminderLetterTemplate: OfficeLetterTemplate;
  patientLetterTemplates: OfficeLetterTemplate[];
  officeUserDelegations: OfficeUserDelegationPayload[];
  serviceTypes: ServiceTypeSetting[];
  paymentMethods: PaymentMethodSetting[];
};

export type CreateSetupOfficePayload = CreateOfficePayload & {
  adminPassword: string;
  encryptionKey?: string;
};

export type UpdateOfficePayload = CreateOfficePayload & {
  isActive?: boolean;
};

export type OfficesPayload = {
  offices: Office[];
};
