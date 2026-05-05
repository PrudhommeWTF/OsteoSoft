import { Injectable, inject, signal } from '@angular/core';

import { ApiService } from './api.service';
import { AppConfig } from './api.types';

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly apiService = inject(ApiService);

  readonly config = signal<AppConfig | null>(null);
  readonly isLoaded = signal(false);

  constructor() {
    this.loadConfig();
  }

  private async loadConfig() {
    try {
      const config = await this.apiService.getConfig();
      this.config.set(config);
    } catch (error) {
      console.error('Failed to load config:', error);
      // Set default config if API fails
      this.config.set({
        app_name: 'OsteoSoft',
        version: '0.0.2'
      });
    } finally {
      this.isLoaded.set(true);
    }
  }

  getAppName(): string {
    return this.config()?.app_name ?? 'OsteoSoft';
  }

  getVersion(): string {
    return this.config()?.version ?? '0.0.2';
  }

  getFullTitle(): string {
    return `${this.getAppName()} v${this.getVersion()}`;
  }
}
