import { Injectable, inject, signal } from '@angular/core';

import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class SetupService {
  private readonly api = inject(ApiService);

  readonly requiresSetup = signal(false);
  private _checked = false;

  async ensureChecked(): Promise<boolean> {
    if (!this._checked) {
      try {
        const status = await this.api.getSetupStatus();
        this.requiresSetup.set(status.requiresSetup);
      } catch {
        // If API is unavailable do not block the app
      }
      this._checked = true;
    }

    return this.requiresSetup();
  }

  markComplete(): void {
    this.requiresSetup.set(false);
    this._checked = true;
  }

  invalidate(): void {
    this._checked = false;
  }
}
