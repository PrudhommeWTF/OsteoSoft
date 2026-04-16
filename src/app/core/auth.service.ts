import { computed, Injectable, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import { ApiService } from './api.service';
import { AuthUser } from './api.types';

export type LoginResult = 'success' | 'invalid-credentials' | 'server-unreachable';

type SessionState = {
  authenticated: boolean;
  username: string;
  role: string;
  permissions: Set<string>;
  checked: boolean;
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly session = signal<SessionState>({
    authenticated: false,
    username: '',
    role: '',
    permissions: new Set<string>(),
    checked: false
  });

  readonly isAuthenticated = computed(() => this.session().authenticated);
  readonly username = computed(() => this.session().username);
  readonly role = computed(() => this.session().role);

  hasPermission(permissionId: string): boolean {
    const session = this.session();
    if (session.role === 'admin') {
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

    this.session.set({
      authenticated: true,
      username: user.username,
      role: user.role,
      permissions,
      checked: true
    });
  }

  private clearSession(): void {
    this.session.set({
      authenticated: false,
      username: '',
      role: '',
      permissions: new Set<string>(),
      checked: true
    });
  }
}
