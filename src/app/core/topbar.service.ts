import { Injectable, signal } from '@angular/core';

export type TopbarAction = {
  id: string;
  label: string;
  icon?: string;
  btnClass: string;
  disabled?: () => boolean;
  loading?: () => boolean;
  loadingLabel?: string;
  onClick: () => void;
};

@Injectable({ providedIn: 'root' })
export class TopbarService {
  readonly actions = signal<TopbarAction[]>([]);
  readonly pageTitle = signal<string>('');
  readonly pageSubtitle = signal<string>('');
  /** Incremented each time the topbar "Nouveau RDV" is clicked. Pages listen via effect. */
  readonly openCreateAppointmentRequest = signal<number>(0);

  set(actions: TopbarAction[]): void {
    this.actions.set(actions);
  }

  clear(): void {
    this.actions.set([]);
  }

  setPage(title: string, subtitle?: string): void {
    this.pageTitle.set(title);
    this.pageSubtitle.set(subtitle ?? '');
  }

  clearPage(): void {
    this.pageTitle.set('');
    this.pageSubtitle.set('');
  }
}
