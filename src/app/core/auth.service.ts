import { computed, Injectable, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import { ApiService } from './api.service';
import { AuthUser, OfficeOption } from './api.types';

export type LoginResult = 'success' | 'invalid-credentials' | 'account-locked' | 'server-unreachable';

const ACTIVE_OFFICE_STORAGE_KEY = 'osteosoft:active-office-id';
const SUPER_ADMIN_PROFILE_ID = 'super-admin';

type SessionState = {
  authenticated: boolean;
  username: string;
  role: string;
  profileId: string | null;
  profileLabel: string | null;
  offices: OfficeOption[];
  officeIds: number[];
  activeOfficeId: number | null;
  permissions: Set<string>;
  checked: boolean;
  mustChangePassword: boolean;
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly session = signal<SessionState>({
    authenticated: false,
    username: '',
    role: '',
    profileId: null,
    profileLabel: null,
    offices: [],
    officeIds: [],
    activeOfficeId: null,
    permissions: new Set<string>(),
    checked: false,
    mustChangePassword: false
  });

  readonly isAuthenticated = computed(() => this.session().authenticated);
  readonly username = computed(() => this.session().username);
  readonly role = computed(() => this.session().role);
  readonly profileId = computed(() => this.session().profileId);
  readonly profileLabel = computed(() => this.session().profileLabel);
  readonly offices = computed(() => this.session().offices);
  readonly officeIds = computed(() => this.session().officeIds);
  readonly activeOfficeId = computed(() => this.session().activeOfficeId);
  readonly isSuperAdmin = computed(() => this.session().profileId === SUPER_ADMIN_PROFILE_ID);
  readonly mustChangePassword = computed(() => this.session().mustChangePassword);

  setActiveOfficeId(value: number | null): void {
    const session = this.session();
    const parsedValue = value == null ? null : Number(value);
    const normalized = Number.isInteger(parsedValue) && (parsedValue as number) > 0
      ? (parsedValue as number)
      : null;
    const next = normalized !== null && session.officeIds.includes(normalized)
      ? normalized
      : (session.officeIds[0] ?? null);

    this.session.update((current) => ({
      ...current,
      activeOfficeId: next
    }));

    this.persistActiveOfficeId(next);
  }

  hasPermission(permissionId: string): boolean {
    const session = this.session();
    if (session.role === 'admin' || session.profileId === SUPER_ADMIN_PROFILE_ID) {
      return true;
    }

    return session.permissions.has(permissionId);
  }

  async login(username: string, password: string, remember: boolean): Promise<LoginResult> {
    try {
      const user = await this.api.login(username, password, remember);
      this.setSessionFromUser(user);
      return 'success';
    } catch (error) {
      this.clearSession();

      if (error instanceof HttpErrorResponse && error.status === 401) {
        return 'invalid-credentials';
      }

      if (error instanceof HttpErrorResponse && error.status === 429) {
        return 'account-locked';
      }

      return 'server-unreachable';
    }
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } finally {
      this.clearSession();
    }
  }

  async ensureSessionChecked(): Promise<boolean> {
    if (this.session().checked) {
      return this.session().authenticated;
    }

    try {
      const user = await this.api.me();
      this.setSessionFromUser(user);
      return true;
    } catch {
      this.clearSession();
      return false;
    }
  }

  async refreshSession(): Promise<void> {
    try {
      const user = await this.api.me();
      this.setSessionFromUser(user);
    } catch {
      this.clearSession();
    }
  }

  invalidateSession(): void {
    this.clearSession();
  }

  private setSessionFromUser(user: AuthUser): void {
    const permissions = new Set<string>();
    const rights = user.rights ?? {};

    for (const domainRights of Object.values(rights)) {
      if (!domainRights || typeof domainRights !== 'object') {
        continue;
      }

      for (const [permissionId, enabled] of Object.entries(domainRights)) {
        if (enabled) {
          permissions.add(permissionId);
        }
      }
    }

    const offices = this.normalizeOfficeOptions(user);
    const officeIds = offices
      .map((office) => Number(office.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const persistedActiveOfficeId = this.readPersistedActiveOfficeId();
    const activeOfficeId = persistedActiveOfficeId !== null && officeIds.includes(persistedActiveOfficeId)
      ? persistedActiveOfficeId
      : (officeIds[0] ?? null);

    this.persistActiveOfficeId(activeOfficeId);

    this.session.set({
      authenticated: true,
      username: user.username,
      role: user.role,
      profileId: user.profileId ?? null,
      profileLabel: user.profileLabel ?? null,
      offices,
      officeIds,
      activeOfficeId,
      permissions,
      checked: true,
      mustChangePassword: user.mustChangePassword === true
    });
  }

  private clearSession(): void {
    this.session.set({
      authenticated: false,
      username: '',
      role: '',
      profileId: null,
      profileLabel: null,
      offices: [],
      officeIds: [],
      activeOfficeId: null,
      permissions: new Set<string>(),
      checked: true,
      mustChangePassword: false
    });

    this.persistActiveOfficeId(null);
  }

  private normalizeOfficeOptions(user: AuthUser): OfficeOption[] {
    const fromOffices = Array.isArray(user.offices)
      ? user.offices
      : [];

    if (fromOffices.length > 0) {
      return fromOffices
        .map((office) => ({
          id: Number(office.id),
          name: String(office.name ?? '').trim()
        }))
        .filter((office) => Number.isInteger(office.id) && office.id > 0 && office.name.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    }

    const fallbackIds = Array.isArray(user.officeIds)
      ? user.officeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    return fallbackIds.map((id) => ({ id, name: `Cabinet #${id}` }));
  }

  private readPersistedActiveOfficeId(): number | null {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(ACTIVE_OFFICE_STORAGE_KEY);
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  private persistActiveOfficeId(officeId: number | null): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      if (officeId == null) {
        window.localStorage.removeItem(ACTIVE_OFFICE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(ACTIVE_OFFICE_STORAGE_KEY, String(officeId));
      }
    } catch {
      // Ignore localStorage failures.
    }
  }
}
