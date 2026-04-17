import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  AccessManagedUser,
  AgendaSettingsPayload,
  AccessManagedUsersPayload,
  AccessProfile,
  AccessProfilesPayload,
  AppConfig,
  AntecedentTypesPayload,
  Appointment,
  AppointmentsPayload,
  AuthUser,
  ConsultationRecord,
  ConsultationContextPayload,
  AppointmentConsultationConflict,
  ConsultationMetaSummary,
  CreateAppointmentPayload,
  CreatePatientPayload,
  CreateOfficePayload,
  DirectoryContact,
  DirectoryContactPayload,
  DirectoryContactsPayload,
  CreatedPatient,
  DashboardPayload,
  GeneralSettingsPayload,
  InvoiceSummaryTile,
  LocationPair,
  MyUserProfile,
  NewOfficeDraft,
  NewOfficeDraftPayload,
  NewPatientDraft,
  NewPatientDraftPayload,
  Office,
  OfficesPayload,
  PatientDetail,
  PatientAuditLog,
  Practitioner,
  PractitionersPayload,
  Patient,
  PeoplePickerContact,
  UserAccountPayload,
  SystemAuditLog,
  UpdateAppointmentConsultationMetaPayload,
  UpdateAccessProfileRightsPayload,
  UpdateOfficePayload,
  UserAgendaPreferences,
  UpdateMyUserProfilePayload,
  UpdatePatientPayload
} from './api.types';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://localhost:3000/api';

  async login(username: string, password: string, remember: boolean): Promise<AuthUser> {
    const response = await firstValueFrom(
      this.http.post<{ user: AuthUser }>(`${this.baseUrl}/auth/login`, {
        username,
        password,
        remember
      })
    );

    return response.user;
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post<void>(`${this.baseUrl}/auth/logout`, {}));
  }

  async me(): Promise<AuthUser> {
    const response = await firstValueFrom(this.http.get<{ user: AuthUser }>(`${this.baseUrl}/auth/me`));
    return response.user;
  }

  async getAppointments(officeId?: number | null): Promise<AppointmentsPayload> {
    let params = new HttpParams();
    if (Number.isInteger(officeId) && Number(officeId) > 0) {
      params = params.set('officeId', String(officeId));
    }

    return firstValueFrom(this.http.get<AppointmentsPayload>(`${this.baseUrl}/appointments`, { params }));
  }

  async createAppointment(payload: CreateAppointmentPayload): Promise<Appointment> {
    const response = await firstValueFrom(
      this.http.post<{ appointment: Appointment }>(`${this.baseUrl}/appointments`, payload)
    );

    return response.appointment;
  }

  async getPatients(search: string): Promise<Patient[]> {
    const params = new HttpParams().set('search', search);
    const response = await firstValueFrom(
      this.http.get<{ patients: Patient[] }>(`${this.baseUrl}/patients`, { params })
    );

    return response.patients;
  }

  async searchPeopleContacts(search: string): Promise<PeoplePickerContact[]> {
    const params = new HttpParams().set('search', search);
    const response = await firstValueFrom(
      this.http.get<{ contacts: PeoplePickerContact[] }>(`${this.baseUrl}/people/search`, { params })
    );

    return response.contacts;
  }

  async getPatientReferralSuggestions(search: string): Promise<string[]> {
    const params = new HttpParams().set('search', search);
    const response = await firstValueFrom(
      this.http.get<{ referrals: string[] }>(`${this.baseUrl}/patients/referrals`, { params })
    );

    return response.referrals;
  }

  async getPatientLocations(): Promise<LocationPair[]> {
    const params = new HttpParams().set('limit', '5000');
    const response = await firstValueFrom(
      this.http.get<{ locations: LocationPair[] }>(`${this.baseUrl}/patients/locations`, { params })
    );

    return response.locations;
  }

  async getDirectoryContacts(filters?: {
    search?: string;
    officeId?: number | null;
    kind?: 'person' | 'company' | 'all';
    isActive?: boolean | null;
  }): Promise<DirectoryContactsPayload> {
    let params = new HttpParams();
    if (filters?.search?.trim()) {
      params = params.set('search', filters.search.trim());
    }
    if (Number.isInteger(filters?.officeId) && Number(filters?.officeId) > 0) {
      params = params.set('officeId', String(filters?.officeId));
    }
    if (filters?.kind === 'person' || filters?.kind === 'company') {
      params = params.set('kind', filters.kind);
    }
    if (filters?.isActive === true || filters?.isActive === false) {
      params = params.set('isActive', String(filters.isActive));
    }

    return firstValueFrom(this.http.get<DirectoryContactsPayload>(`${this.baseUrl}/directory/contacts`, { params }));
  }

  async getDirectoryContactCount(): Promise<number> {
    const response = await firstValueFrom(
      this.http.get<{ count: number }>(`${this.baseUrl}/directory/contacts/count`)
    );

    return Number(response.count ?? 0);
  }

  async createDirectoryContact(payload: DirectoryContactPayload): Promise<DirectoryContact> {
    const response = await firstValueFrom(
      this.http.post<{ contact: DirectoryContact }>(`${this.baseUrl}/directory/contacts`, payload)
    );
    return response.contact;
  }

  async updateDirectoryContact(contactId: number, payload: DirectoryContactPayload): Promise<DirectoryContact> {
    const response = await firstValueFrom(
      this.http.put<{ contact: DirectoryContact }>(`${this.baseUrl}/directory/contacts/${contactId}`, payload)
    );
    return response.contact;
  }

  async deleteDirectoryContact(contactId: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/directory/contacts/${contactId}`));
  }

  async exportDirectoryContacts(officeId?: number | null): Promise<Blob> {
    let params = new HttpParams();
    if (Number.isInteger(officeId) && Number(officeId) > 0) {
      params = params.set('officeId', String(officeId));
    }

    return firstValueFrom(
      this.http.get(`${this.baseUrl}/directory/contacts/export`, {
        params,
        responseType: 'blob'
      })
    );
  }

  async createPatient(payload: CreatePatientPayload): Promise<CreatedPatient> {
    const response = await firstValueFrom(
      this.http.post<{ patient: CreatedPatient }>(`${this.baseUrl}/patients`, payload)
    );

    return response.patient;
  }

  async getPatientCount(): Promise<number> {
    const response = await firstValueFrom(
      this.http.get<{ count: number }>(`${this.baseUrl}/patients/count`)
    );
    return response.count;
  }

  async getInvoiceSummary(): Promise<InvoiceSummaryTile[]> {
    const response = await firstValueFrom(
      this.http.get<{ summary: InvoiceSummaryTile[] }>(`${this.baseUrl}/invoices/summary`)
    );

    return response.summary;
  }

  async getDashboard(officeId?: number | null): Promise<DashboardPayload> {
    let params = new HttpParams();
    if (Number.isInteger(officeId) && Number(officeId) > 0) {
      params = params.set('officeId', String(officeId));
    }

    return firstValueFrom(this.http.get<DashboardPayload>(`${this.baseUrl}/dashboard`, { params }));
  }

  async getConfig(): Promise<AppConfig> {
    return firstValueFrom(this.http.get<AppConfig>(`${this.baseUrl}/config`));
  }

  async getAntecedentTypes(): Promise<string[]> {
    const response = await firstValueFrom(
      this.http.get<AntecedentTypesPayload>(`${this.baseUrl}/antecedent-types`)
    );

    return response.types;
  }

  async getNewPatientDraft(): Promise<NewPatientDraft | null> {
    const response = await firstValueFrom(
      this.http.get<NewPatientDraftPayload>(`${this.baseUrl}/patient-drafts/new-patient`)
    );

    return response.draft;
  }

  async saveNewPatientDraft(step: number, payload: CreatePatientPayload): Promise<void> {
    await firstValueFrom(
      this.http.put<void>(`${this.baseUrl}/patient-drafts/new-patient`, { step, payload })
    );
  }

  async deleteNewPatientDraft(): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/patient-drafts/new-patient`));
  }

  async getNewOfficeDraft(): Promise<NewOfficeDraft | null> {
    const response = await firstValueFrom(
      this.http.get<NewOfficeDraftPayload>(`${this.baseUrl}/office-drafts/new-office`)
    );

    return response.draft;
  }

  async saveNewOfficeDraft(step: number, payload: CreateOfficePayload): Promise<void> {
    await firstValueFrom(
      this.http.put<void>(`${this.baseUrl}/office-drafts/new-office`, { step, payload })
    );
  }

  async deleteNewOfficeDraft(): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/office-drafts/new-office`));
  }

  async getPractitioners(): Promise<Practitioner[]> {
    const response = await firstValueFrom(
      this.http.get<PractitionersPayload>(`${this.baseUrl}/practitioners`)
    );

    return response.practitioners;
  }

  async getConsultationContext(officeId?: number | null): Promise<ConsultationContextPayload> {
    let params = new HttpParams();
    if (Number.isInteger(officeId) && Number(officeId) > 0) {
      params = params.set('officeId', String(officeId));
    }

    return firstValueFrom(this.http.get<ConsultationContextPayload>(`${this.baseUrl}/consultation-context`, { params }));
  }

  async updateAppointmentConsultationMeta(
    appointmentId: number,
    payload: UpdateAppointmentConsultationMetaPayload
  ): Promise<ConsultationMetaSummary> {
    const response = await firstValueFrom(
      this.http.patch<{ consultation: ConsultationMetaSummary }>(
        `${this.baseUrl}/appointments/${appointmentId}/consultation-meta`,
        payload
      )
    );

    return response.consultation;
  }

  async getPatientIdByAppointment(appointmentId: number): Promise<number> {
    const response = await firstValueFrom(
      this.http.get<{ patientId: number }>(`${this.baseUrl}/appointments/${appointmentId}/patient`)
    );

    return Number(response.patientId);
  }

  async getPatientDetail(id: number): Promise<PatientDetail> {
    const response = await firstValueFrom(
      this.http.get<{ patient: PatientDetail }>(`${this.baseUrl}/patients/${id}`)
    );
    return response.patient;
  }

  async getPatientConsultations(id: number): Promise<ConsultationRecord[]> {
    const response = await firstValueFrom(
      this.http.get<{ consultations: ConsultationRecord[] }>(`${this.baseUrl}/patients/${id}/consultations`)
    );
    return response.consultations;
  }

  async getPatientAuditLogs(id: number): Promise<PatientAuditLog[]> {
    const response = await firstValueFrom(
      this.http.get<{ logs: PatientAuditLog[] }>(`${this.baseUrl}/patients/${id}/audit-logs`)
    );
    return response.logs;
  }

  async updatePatient(id: number, payload: UpdatePatientPayload): Promise<void> {
    await firstValueFrom(this.http.put<void>(`${this.baseUrl}/patients/${id}`, payload));
  }

  async getAccessProfiles(): Promise<AccessProfile[]> {
    const response = await firstValueFrom(
      this.http.get<AccessProfilesPayload>(`${this.baseUrl}/access-profiles`)
    );

    return response.profiles;
  }

  async createAccessProfile(label: string, description: string): Promise<AccessProfile> {
    const response = await firstValueFrom(
      this.http.post<{ profile: AccessProfile }>(`${this.baseUrl}/access-profiles`, {
        label,
        description
      })
    );

    return response.profile;
  }

  async updateAccessProfileRights(profileId: string, payload: UpdateAccessProfileRightsPayload): Promise<void> {
    await firstValueFrom(
      this.http.put<void>(`${this.baseUrl}/access-profiles/${encodeURIComponent(profileId)}/rights`, payload)
    );
  }

  async updateCurrentUserAccessProfile(profileId: string): Promise<void> {
    await firstValueFrom(this.http.put<void>(`${this.baseUrl}/auth/me/access-profile`, { profileId }));
  }

  async getUsers(): Promise<AccessManagedUser[]> {
    const response = await firstValueFrom(
      this.http.get<AccessManagedUsersPayload>(`${this.baseUrl}/users`)
    );

    return response.users;
  }

  async updateUserAccessProfile(userId: number, profileId: string): Promise<void> {
    await firstValueFrom(
      this.http.put<void>(`${this.baseUrl}/users/${userId}/access-profile`, { profileId })
    );
  }

  async createUserAccount(payload: UserAccountPayload): Promise<AccessManagedUser> {
    const response = await firstValueFrom(
      this.http.post<{ user: AccessManagedUser }>(`${this.baseUrl}/users`, payload)
    );

    return response.user;
  }

  async updateUserAccount(userId: number, payload: UserAccountPayload): Promise<void> {
    await firstValueFrom(
      this.http.put<void>(`${this.baseUrl}/users/${userId}`, payload)
    );
  }

  async deleteUserAccount(userId: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/users/${userId}`));
  }

  async downloadDataBackup(): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`${this.baseUrl}/data-management/backup`, {
        responseType: 'blob'
      })
    );
  }

  async restoreDataBackup(payload: unknown): Promise<void> {
    await firstValueFrom(
      this.http.post<void>(`${this.baseUrl}/data-management/restore`, payload)
    );
  }

  async getAuditLogs(limit = 100): Promise<SystemAuditLog[]> {
    const params = new HttpParams().set('limit', String(limit));
    const response = await firstValueFrom(
      this.http.get<{ logs: SystemAuditLog[] }>(`${this.baseUrl}/audit-logs`, { params })
    );

    return response.logs;
  }

  async getGeneralSettings(): Promise<GeneralSettingsPayload> {
    const response = await firstValueFrom(
      this.http.get<{ settings: GeneralSettingsPayload }>(`${this.baseUrl}/settings/general`)
    );

    return response.settings;
  }

  async updateGeneralSettings(payload: GeneralSettingsPayload): Promise<GeneralSettingsPayload> {
    const response = await firstValueFrom(
      this.http.put<{ settings: GeneralSettingsPayload }>(`${this.baseUrl}/settings/general`, payload)
    );

    return response.settings;
  }

  async getAgendaSettings(): Promise<AgendaSettingsPayload> {
    const response = await firstValueFrom(
      this.http.get<{ settings: AgendaSettingsPayload }>(`${this.baseUrl}/settings/agenda`)
    );

    return response.settings;
  }

  async updateAgendaSettings(payload: AgendaSettingsPayload): Promise<AgendaSettingsPayload> {
    const response = await firstValueFrom(
      this.http.put<{ settings: AgendaSettingsPayload }>(`${this.baseUrl}/settings/agenda`, payload)
    );

    return response.settings;
  }

  async getMyAgendaPreferences(): Promise<UserAgendaPreferences> {
    const response = await firstValueFrom(
      this.http.get<{ preferences: UserAgendaPreferences }>(`${this.baseUrl}/profile/agenda-preferences`)
    );

    return response.preferences;
  }

  async updateMyAgendaPreferences(payload: UserAgendaPreferences): Promise<UserAgendaPreferences> {
    const response = await firstValueFrom(
      this.http.put<{ preferences: UserAgendaPreferences }>(`${this.baseUrl}/profile/agenda-preferences`, payload)
    );

    return response.preferences;
  }

  async getMyUserProfile(): Promise<MyUserProfile> {
    const response = await firstValueFrom(
      this.http.get<{ profile: MyUserProfile }>(`${this.baseUrl}/profile/me`)
    );

    return response.profile;
  }

  async updateMyUserProfile(payload: UpdateMyUserProfilePayload): Promise<void> {
    await firstValueFrom(this.http.put<void>(`${this.baseUrl}/profile/me`, payload));
  }

  async getOffices(): Promise<Office[]> {
    const response = await firstValueFrom(
      this.http.get<OfficesPayload>(`${this.baseUrl}/offices`)
    );

    return response.offices;
  }

  async createOffice(payload: CreateOfficePayload): Promise<Office> {
    const response = await firstValueFrom(
      this.http.post<{ office: Office }>(`${this.baseUrl}/offices`, payload)
    );

    return response.office;
  }

  async updateOffice(id: number, payload: UpdateOfficePayload): Promise<Office> {
    const response = await firstValueFrom(
      this.http.put<{ office: Office }>(`${this.baseUrl}/offices/${id}`, payload)
    );

    return response.office;
  }

  async deleteOffice(id: number): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ message: string }>(`${this.baseUrl}/offices/${id}`)
    );
  }

  async reorderOffices(officeIds: number[]): Promise<Office[]> {
    const response = await firstValueFrom(
      this.http.post<OfficesPayload>(`${this.baseUrl}/offices/reorder`, { officeIds })
    );

    return response.offices;
  }

  async downloadPatientRgpdExport(patientId: number): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`${this.baseUrl}/patients/${patientId}/export`, {
        responseType: 'blob'
      })
    );
  }
}
