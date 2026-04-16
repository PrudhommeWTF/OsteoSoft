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

  set(actions: TopbarAction[]): void {
    this.actions.set(actions);
  }

  clear(): void {
    this.actions.set([]);
  }
}
