import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { UpdateChannel } from '../../core/api.types';
import { SystemUpdateService, apiErrorMessage } from '../../core/system-update.service';

const DATE_TIME = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
const DATE_ONLY = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' });

/**
 * Parametres > Mises a jour : version en service, canal, version disponible et
 * ses notes, installation en un clic (super-administrateur, mot de passe
 * redemande) et suivi jusqu'au redemarrage.
 */
@Component({
  selector: 'app-update-panel',
  imports: [FormsModule],
  templateUrl: './update-panel.component.html',
  styleUrl: './update-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UpdatePanelComponent implements OnInit, OnDestroy {
  readonly updates = inject(SystemUpdateService);

  readonly password = signal('');
  readonly isInstalling = signal(false);
  readonly installError = signal('');
  readonly channelError = signal('');
  readonly isSavingChannel = signal(false);

  readonly info = this.updates.info;
  readonly progress = computed(() => this.updates.progress() ?? this.runningFromServer());

  /** Installation en cours signalee par le serveur (lancee depuis un autre onglet par exemple). */
  private readonly runningFromServer = computed(() => {
    const status = this.info()?.status;
    return status && status.state === 'running' ? status : null;
  });

  /** Dernier resultat connu, affiche hors suivi en direct. */
  readonly lastResult = computed(() => {
    if (this.updates.progress()) return null;
    const status = this.info()?.status;
    return status && (status.state === 'done' || status.state === 'error') ? status : null;
  });

  readonly isBusy = computed(() => this.progress()?.state === 'running' || this.isInstalling());

  readonly checkedAtLabel = computed(() => this.formatDateTime(this.info()?.checkedAt));
  readonly publishedAtLabel = computed(() => {
    const value = this.info()?.publishedAt;
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : DATE_ONLY.format(date);
  });

  ngOnInit(): void {
    void this.updates.check();
  }

  ngOnDestroy(): void {
    // Le suivi continue dans le service (la cloche de la barre du haut en profite).
    this.password.set('');
  }

  refresh(): void {
    void this.updates.check(true);
  }

  async changeChannel(channel: UpdateChannel): Promise<void> {
    if (channel === this.info()?.channel) return;
    this.isSavingChannel.set(true);
    this.channelError.set('');
    try {
      await this.updates.setChannel(channel);
    } catch (error) {
      this.channelError.set(apiErrorMessage(error, 'Changement de canal impossible.'));
    } finally {
      this.isSavingChannel.set(false);
    }
  }

  async install(): Promise<void> {
    const password = this.password();
    if (!password || this.isBusy()) return;
    this.isInstalling.set(true);
    this.installError.set('');
    try {
      await this.updates.install(password);
      this.password.set('');
    } catch (error) {
      this.installError.set(apiErrorMessage(error, 'Déclenchement de la mise à jour impossible.'));
    } finally {
      this.isInstalling.set(false);
    }
  }

  reload(): void {
    window.location.reload();
  }

  private formatDateTime(value: string | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : DATE_TIME.format(date);
  }
}
