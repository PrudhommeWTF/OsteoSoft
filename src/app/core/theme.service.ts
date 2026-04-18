import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';
type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'osteosoft:theme-mode';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly mode = signal<ThemeMode>('system');
  private readonly prefersDark = signal(false);
  private mediaQuery: MediaQueryList | null = null;
  private mediaListener: ((event: MediaQueryListEvent) => void) | null = null;

  readonly themeMode = this.mode.asReadonly();
  readonly effectiveTheme = computed<EffectiveTheme>(() => {
    const selectedMode = this.mode();
    if (selectedMode === 'dark') {
      return 'dark';
    }

    if (selectedMode === 'light') {
      return 'light';
    }

    return this.prefersDark() ? 'dark' : 'light';
  });

  init(): void {
    this.attachSystemListener();

    const stored = this.readStoredThemeMode();
    if (stored) {
      this.mode.set(stored);
    }

    this.applyThemeToDom();
  }

  setThemeMode(mode: ThemeMode, options?: { persist?: boolean }): void {
    this.mode.set(mode);
    this.applyThemeToDom();

    if (options?.persist !== false) {
      this.persistThemeMode(mode);
    }
  }

  toggleQuickTheme(): void {
    const effective = this.effectiveTheme();
    const next = effective === 'dark' ? 'light' : 'dark';
    this.setThemeMode(next, { persist: true });
  }

  private attachSystemListener(): void {
    const win = this.document.defaultView;
    if (!win || typeof win.matchMedia !== 'function') {
      this.prefersDark.set(false);
      return;
    }

    this.mediaQuery = win.matchMedia('(prefers-color-scheme: dark)');
    this.prefersDark.set(this.mediaQuery.matches);
    this.mediaListener = (event: MediaQueryListEvent) => {
      this.prefersDark.set(event.matches);
      if (this.mode() === 'system') {
        this.applyThemeToDom();
      }
    };

    this.mediaQuery.addEventListener('change', this.mediaListener);
  }

  private applyThemeToDom(): void {
    const root = this.document.documentElement;
    const effective = this.effectiveTheme();

    root.setAttribute('data-theme', effective);
    root.setAttribute('data-bs-theme', effective);
    root.style.colorScheme = effective;
  }

  private readStoredThemeMode(): ThemeMode | null {
    const win = this.document.defaultView;
    if (!win?.localStorage) {
      return null;
    }

    const raw = win.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw;
    }

    return null;
  }

  private persistThemeMode(mode: ThemeMode): void {
    const win = this.document.defaultView;
    if (!win?.localStorage) {
      return;
    }

    win.localStorage.setItem(STORAGE_KEY, mode);
  }
}
