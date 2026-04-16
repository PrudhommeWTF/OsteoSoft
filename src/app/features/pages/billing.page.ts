import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { ApiService } from '../../core/api.service';
import { InvoiceSummaryTile } from '../../core/api.types';

@Component({
  selector: 'app-billing-page',
  templateUrl: './billing.page.html',
  styleUrl: './pages.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BillingPage {
  private readonly api = inject(ApiService);

  readonly tiles = signal<InvoiceSummaryTile[]>([]);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.tiles.set(await this.api.getInvoiceSummary());
  }
}
