import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiService } from './api.service';
import { SystemUpdateInfo, SystemUpdateStatus, UpdateChannel } from './api.types';

/** Intervalle de suivi pendant une installation. */
const POLL_MS = 3000;
/** Au-dela, on arrete de suivre (le serveur declare lui-meme l'etat interrompu). */
const POLL_MAX_MS = 20 * 60 * 1000;

/** Message lisible d'une erreur d'API (message du serveur si present). */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message = String(error.error?.message ?? '').trim();
    if (message) return message;
    if (error.status === 0) return 'Serveur injoignable.';
  }
  return fallback;
}

/**
 * Etat des mises a jour, partage entre la cloche de la barre du haut et l'ecran
 * Parametres > Mises a jour. Le serveur garde la verification GitHub en cache :
 * `check()` a chaque ouverture ne multiplie pas les appels sortants.
 */
@Injectable({ providedIn: 'root' })
export class SystemUpdateService {
  private readonly api = inject(ApiService);

  readonly info = signal<SystemUpdateInfo | null>(null);
  readonly isChecking = signal(false);
  readonly checkError = signal('');

  /** Suivi d'une installation lancee depuis cet onglet. */
  readonly progress = signal<SystemUpdateStatus | null>(null);
  /** Version en service vue au dernier suivi (change apres redemarrage). */
  readonly runningVersion = signal<string | null>(null);
  readonly isPolling = signal(false);

  readonly updateAvailable = computed(() => Boolean(this.info()?.updateAvailable));
  /** Le serveur a redemarre sur une autre version que celle chargee dans le navigateur. */
  readonly reloadNeeded = computed(() => {
    const running = this.runningVersion();
    const loaded = this.info()?.current;
    return Boolean(running && loaded && running !== loaded);
  });

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollStartedAt = 0;

  async check(refresh = false): Promise<void> {
    this.isChecking.set(true);
    this.checkError.set('');
    try {
      const info = await this.api.getSystemUpdate(refresh);
      this.info.set(info);
      if (info.status.state === 'running') {
        this.startPolling();
      }
    } catch (error) {
      this.checkError.set(apiErrorMessage(error, 'Vérification des mises à jour impossible.'));
    } finally {
      this.isChecking.set(false);
    }
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    await this.api.setUpdateChannel(channel);
    await this.check();
  }

  async install(password: string): Promise<string> {
    const result = await this.api.triggerSystemUpdate(password);
    this.progress.set({ state: 'running', message: `Mise à jour vers ${result.tag} demandée.` });
    this.startPolling();
    return result.tag;
  }

  startPolling(): void {
    if (this.pollTimer) return;
    this.pollStartedAt = Date.now();
    this.isPolling.set(true);
    this.scheduleNextPoll(0);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling.set(false);
  }

  private scheduleNextPoll(delay: number): void {
    this.pollTimer = setTimeout(() => void this.pollOnce(), delay);
  }

  private async pollOnce(): Promise<void> {
    try {
      const status = await this.api.getSystemUpdateStatus();
      this.runningVersion.set(status.current);
      this.progress.set({ state: status.state, message: status.message, ts: status.ts });
      if (status.state === 'done' || status.state === 'error') {
        this.pollTimer = null;
        this.isPolling.set(false);
        return;
      }
    } catch {
      // Service en cours de redemarrage : on reessaie.
    }
    if (Date.now() - this.pollStartedAt > POLL_MAX_MS) {
      this.pollTimer = null;
      this.isPolling.set(false);
      return;
    }
    this.scheduleNextPoll(POLL_MS);
  }
}
