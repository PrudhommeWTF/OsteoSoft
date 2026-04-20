import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';

import JSZip from 'jszip';

import { ApiService } from '../../core/api.service';

type BackupEnvelope = {
  manifest?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  data: Record<string, unknown>;
};

type RestoreProgressStep = 'idle' | 'reading' | 'validating' | 'checksum' | 'ready' | 'uploading' | 'applying' | 'done' | 'error';
type RestoreStepStatus = 'pending' | 'active' | 'done' | 'error';

@Component({
  selector: 'app-installation-page',
  imports: [RouterLink],
  templateUrl: './installation.page.html',
  styleUrl: './installation.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstallationPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly isLoadingStatus = signal(true);
  readonly isRestoring = signal(false);
  readonly selectedBackupFileName = signal('');
  readonly selectedBackupPayload = signal<BackupEnvelope | null>(null);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly restoreProgressStep = signal<RestoreProgressStep>('idle');
  readonly restoreProgressLabel = signal('');
  readonly restoreProgressPercent = signal(0);
  readonly restoreLastOperationalStep = signal<RestoreProgressStep>('idle');
  readonly restoreTimeline: Array<{ id: RestoreProgressStep; label: string }> = [
    { id: 'reading', label: 'Lecture du fichier' },
    { id: 'validating', label: 'Validation de la structure' },
    { id: 'checksum', label: 'Verification du checksum' },
    { id: 'ready', label: 'Sauvegarde prete' },
    { id: 'uploading', label: 'Envoi vers le serveur' },
    { id: 'applying', label: 'Application des donnees' },
    { id: 'done', label: 'Restauration terminee' }
  ];

  async ngOnInit(): Promise<void> {
    this.errorMessage.set('');

    try {
      const setup = await this.api.getSetupStatus();
      if (!setup.requiresSetup) {
        await this.router.navigateByUrl('/login');
        return;
      }
    } catch {
      this.errorMessage.set('Impossible de verifier le statut d\'installation.');
    } finally {
      this.isLoadingStatus.set(false);
    }
  }

  async onBackupFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.item(0) ?? null;

    this.errorMessage.set('');
    this.successMessage.set('');
    this.resetRestoreProgress();

    if (!file) {
      this.selectedBackupFileName.set('');
      this.selectedBackupPayload.set(null);
      return;
    }

    this.selectedBackupFileName.set(file.name);

    try {
      this.setRestoreProgress('reading', 'Lecture du fichier de sauvegarde...', 15);
      const payload = await this.readBackupEnvelope(file);
      this.setRestoreProgress('validating', 'Validation de la structure de sauvegarde...', 45);

      if (payload.manifest) {
        this.setRestoreProgress('checksum', 'Verification de l\'integrite (checksum SHA-256)...', 70);
        await this.verifyEnvelopeChecksum(payload);
      }

      this.selectedBackupPayload.set(payload);
      this.setRestoreProgress('ready', 'Sauvegarde validee. Prete pour restauration.', 100);
      this.successMessage.set('Sauvegarde chargee. Vous pouvez lancer la restauration.');
    } catch (error) {
      this.selectedBackupPayload.set(null);
      this.setRestoreProgress('error', 'Echec de validation de la sauvegarde.', 100);
      this.errorMessage.set(error instanceof Error ? error.message : 'Le fichier selectionne est invalide.');
    }
  }

  async restoreBackup(): Promise<void> {
    const payload = this.selectedBackupPayload();
    if (!payload) {
      this.errorMessage.set('Veuillez selectionner un fichier de sauvegarde valide.');
      return;
    }

    const confirmation = globalThis.confirm('La restauration va initialiser l\'application avec cette sauvegarde. Continuer ?');
    if (!confirmation) {
      return;
    }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.isRestoring.set(true);
    this.setRestoreProgress('uploading', 'Envoi de la sauvegarde au serveur...', 20);

    try {
      this.setRestoreProgress('applying', 'Application de la sauvegarde sur la base...', 65);
      await this.api.restoreSetupBackup(payload);
      this.setRestoreProgress('done', 'Restauration terminee avec succes.', 100);
      this.successMessage.set('Restauration terminee. Vous pouvez vous connecter.');
      this.selectedBackupPayload.set(null);
      await this.router.navigateByUrl('/login');
    } catch (error) {
      this.setRestoreProgress('error', 'La restauration a echoue.', 100);
      if (error instanceof HttpErrorResponse) {
        const serverMessage = typeof error.error?.message === 'string' ? error.error.message : '';
        this.errorMessage.set(serverMessage || 'La restauration a echoue.');
      } else {
        this.errorMessage.set('La restauration a echoue.');
      }
    } finally {
      this.isRestoring.set(false);
    }
  }

  private async readBackupEnvelope(file: File): Promise<BackupEnvelope> {
    if (file.name.toLowerCase().endsWith('.json')) {
      const json = JSON.parse(await file.text());
      if (!json || typeof json !== 'object' || !json.data || typeof json.data !== 'object') {
        throw new Error('Sauvegarde JSON invalide.');
      }

      return json as BackupEnvelope;
    }

    if (!file.name.toLowerCase().endsWith('.zip')) {
      throw new Error('Format non supporte. Utilisez un fichier .zip ou .json.');
    }

    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const manifestText = await zip.file('manifest.json')?.async('string');
    const dataText = await zip.file('data.json')?.async('string');
    const metaText = await zip.file('meta.json')?.async('string');

    if (!manifestText || !dataText) {
      throw new Error('Archive invalide: manifest.json ou data.json manquant.');
    }

    const manifest = JSON.parse(manifestText);
    const data = JSON.parse(dataText);
    const meta = metaText ? JSON.parse(metaText) : undefined;

    if (!data || typeof data !== 'object') {
      throw new Error('Archive invalide: data.json ne contient pas de donnees valides.');
    }

    return {
      manifest,
      meta,
      data
    };
  }

  private resetRestoreProgress(): void {
    this.restoreProgressStep.set('idle');
    this.restoreProgressLabel.set('');
    this.restoreProgressPercent.set(0);
    this.restoreLastOperationalStep.set('idle');
  }

  private setRestoreProgress(step: RestoreProgressStep, label: string, percent: number): void {
    this.restoreProgressStep.set(step);
    this.restoreProgressLabel.set(label);
    this.restoreProgressPercent.set(Math.max(0, Math.min(100, Math.round(percent))));

    if (step !== 'idle' && step !== 'error') {
      this.restoreLastOperationalStep.set(step);
    }
  }

  getRestoreStepStatus(stepId: RestoreProgressStep): RestoreStepStatus {
    const currentStep = this.restoreProgressStep();
    const effectiveCurrent = currentStep === 'error' ? this.restoreLastOperationalStep() : currentStep;
    const currentIndex = this.getRestoreStepIndex(effectiveCurrent);
    const stepIndex = this.getRestoreStepIndex(stepId);

    if (currentStep === 'error' && stepId === effectiveCurrent) {
      return 'error';
    }

    if (stepIndex < currentIndex) {
      return 'done';
    }

    if (stepIndex === currentIndex) {
      return effectiveCurrent === 'done' ? 'done' : 'active';
    }

    return 'pending';
  }

  private getRestoreStepIndex(stepId: RestoreProgressStep): number {
    const index = this.restoreTimeline.findIndex((step) => step.id === stepId);
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  }

  private async verifyEnvelopeChecksum(payload: BackupEnvelope): Promise<void> {
    const manifest = payload.manifest;
    if (!manifest) {
      return;
    }

    const expectedChecksum = String(manifest['dataSha256'] ?? '').trim().toLowerCase();
    if (!expectedChecksum) {
      throw new Error('Manifest invalide: checksum dataSha256 manquant.');
    }

    const actualChecksum = await this.computeSha256Hex(JSON.stringify(payload.data));
    if (actualChecksum !== expectedChecksum) {
      throw new Error('Integrite invalide: le checksum de la sauvegarde ne correspond pas au manifest.');
    }
  }

  private async computeSha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const bytes = new Uint8Array(digest);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}
