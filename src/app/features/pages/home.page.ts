import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  inject,
  signal,
  viewChild
} from '@angular/core';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJs,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip
} from 'chart.js';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { AgendaSettings, DashboardEvent, DashboardPayload, StatisticsAgeSexPoint } from '../../core/api.types';
import { WeekCalendar } from './week-calendar';

type PaginationItem =
  | { key: string; kind: 'page'; page: number }
  | { key: string; kind: 'ellipsis' };
type PendingPayment = DashboardPayload['pendingPayments'][number];
type PendingPaymentRow = PendingPayment & { amountLabel: string };

ChartJs.register(
  LineController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler
);

@Component({
  selector: 'app-home-page',
  imports: [RouterLink, WeekCalendar],
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomePage implements AfterViewInit, OnDestroy {
  private static readonly PENDING_PAYMENTS_PAGE_SIZE = 10;
  private static readonly PENDING_PAYMENTS_MAX_VISIBLE_PAGES = 7;

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly eurFormatter = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR'
  });

  readonly monthlyChartHost = viewChild<ElementRef<HTMLCanvasElement>>('monthlyChartHost');
  readonly ageChartHost = viewChild<ElementRef<HTMLCanvasElement>>('ageChartHost');

  readonly isLoading = signal(true);
  readonly recentPatients = signal<DashboardPayload['recentPatients']>([]);
  readonly pendingPayments = signal<DashboardPayload['pendingPayments']>([]);
  readonly pendingPaymentsPage = signal(1);
  readonly calendarEvents = signal<DashboardEvent[]>([]);
  readonly calendarSettings = signal<AgendaSettings | null>(null);
  readonly defaultAgendaView = signal<string>('Semaine');
  readonly showBackupReminderModal = signal(false);
  readonly backupOverdueDays = signal(0);
  readonly canManageBackup = computed(() => this.auth.hasPermission('manage-data-backup-restore'));
  readonly pendingPaymentsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.pendingPayments().length / HomePage.PENDING_PAYMENTS_PAGE_SIZE))
  );
  readonly pendingPaymentsPageItems = computed<PendingPaymentRow[]>(() => {
    const page = this.pendingPaymentsPage();
    const start = (page - 1) * HomePage.PENDING_PAYMENTS_PAGE_SIZE;
    return this.pendingPayments()
      .slice(start, start + HomePage.PENDING_PAYMENTS_PAGE_SIZE)
      .map((payment) => ({
        ...payment,
        amountLabel: this.eurFormatter.format(payment.amountEur)
      }));
  });
  readonly hasPendingPaymentsPagination = computed(() => this.pendingPaymentsTotalPages() > 1);
  readonly pendingPaymentsPaginationItems = computed<PaginationItem[]>(() => {
    const total = this.pendingPaymentsTotalPages();
    const current = this.pendingPaymentsPage();

    if (total <= HomePage.PENDING_PAYMENTS_MAX_VISIBLE_PAGES) {
      return Array.from({ length: total }, (_value, index) => ({
        key: `page-${index + 1}`,
        kind: 'page' as const,
        page: index + 1
      }));
    }

    const pages = new Set<number>([1, total, current - 1, current, current + 1]);

    if (current <= 3) {
      pages.add(2);
      pages.add(3);
      pages.add(4);
    }

    if (current >= total - 2) {
      pages.add(total - 1);
      pages.add(total - 2);
      pages.add(total - 3);
    }

    const sortedPages = Array.from(pages)
      .filter((page) => page >= 1 && page <= total)
      .sort((left, right) => left - right);

    const items: PaginationItem[] = [];
    let previousPage = 0;

    for (const page of sortedPages) {
      if (previousPage > 0 && page - previousPage > 1) {
        items.push({ key: `ellipsis-${previousPage}-${page}`, kind: 'ellipsis' });
      }
      items.push({ key: `page-${page}`, kind: 'page', page });
      previousPage = page;
    }

    return items;
  });

  readonly hasMonthlyChartData = computed(() =>
    (this.pendingPayload()?.monthlyConsultations ?? []).some((point) => Number(point.count) > 0)
  );
  readonly hasAgeChartData = computed(() =>
    (this.pendingPayload()?.patientsByAgeRangeAndSex ?? []).some((point) => Number(point.totalCount) > 0)
  );

  private readonly pendingPayload = signal<DashboardPayload | null>(null);

  private monthlyChart: ChartJs<'line'> | null = null;
  private ageChart: ChartJs<'bar'> | null = null;

  async ngAfterViewInit(): Promise<void> {
    await this.load();
  }

  ngOnDestroy(): void {
    this.monthlyChart?.destroy();
    this.ageChart?.destroy();

  }

  private async load(): Promise<void> {
    try {
      const [payload, profile] = await Promise.all([
        this.api.getDashboard(),
        this.api.getMyUserProfile()
      ]);
      this.recentPatients.set(payload.recentPatients);
      this.pendingPayments.set(payload.pendingPayments);
      this.pendingPaymentsPage.set(1);
      this.calendarEvents.set(payload.events);
      this.calendarSettings.set(payload.agendaSettings);
      this.defaultAgendaView.set(profile.defaultAgendaView || 'Semaine');
      this.pendingPayload.set(payload);
      this.isLoading.set(false);

      this.checkBackupReminder(payload.lastBackupAt, payload.backupReminderFrequency);

      afterNextRender(
        () => {
          const p = this.pendingPayload();
          if (p) {
            this.renderCharts(p);
          }
        },
        { injector: this.injector }
      );
    } catch {
      this.isLoading.set(false);
    }
  }

  private checkBackupReminder(lastBackupAt: string | null, frequency: string): void {
    const frequencyDays: Record<string, number> = {
      'Toutes les semaines': 7,
      'Tous les mois': 30,
      'Tous les 3 mois': 90
    };
    const thresholdDays = frequencyDays[frequency] ?? 30;

    if (!lastBackupAt) {
      this.backupOverdueDays.set(thresholdDays);
      this.showBackupReminderModal.set(true);
      return;
    }

    const lastDate = new Date(lastBackupAt);
    const now = new Date();
    const diffMs = now.getTime() - lastDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays >= thresholdDays) {
      this.backupOverdueDays.set(diffDays);
      this.showBackupReminderModal.set(true);
    }
  }

  dismissBackupReminderModal(): void {
    this.showBackupReminderModal.set(false);
  }


  private renderCharts(payload: DashboardPayload): void {
    this.monthlyChart?.destroy();
    this.ageChart?.destroy();

    const monthlyEl = this.monthlyChartHost()?.nativeElement;
    const ageEl = this.ageChartHost()?.nativeElement;

    if (this.hasMonthlyChartData() && monthlyEl) {
      this.monthlyChart = new ChartJs(monthlyEl, {
        type: 'line',
        data: {
          labels: payload.monthlyConsultations.map((point) => point.month),
          datasets: [
            {
              label: 'Consultations',
              data: payload.monthlyConsultations.map((point) => point.count),
              borderColor: '#2878b5',
              backgroundColor: 'rgba(40, 120, 181, 0.15)',
              fill: true,
              tension: 0.3
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                precision: 0
              }
            }
          }
        }
      });
    }

    if (this.hasAgeChartData() && ageEl) {
      const points = this.normalizeAgeSexPoints(payload);
      this.ageChart = new ChartJs(ageEl, {
        type: 'bar',
        data: {
          labels: points.map((point) => point.label),
          datasets: [
            {
              label: 'Femmes',
              data: points.map((point) => point.femaleCount),
              backgroundColor: '#f25f5c'
            },
            {
              label: 'Hommes',
              data: points.map((point) => point.maleCount),
              backgroundColor: '#3478f6'
            },
            {
              label: 'Non renseigné',
              data: points.map((point) => point.unknownCount),
              backgroundColor: '#7f8c8d'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              stacked: true
            },
            y: {
              stacked: true,
              beginAtZero: true,
              ticks: {
                precision: 0
              }
            }
          }
        }
      });
    }
  }

  private normalizeAgeSexPoints(payload: DashboardPayload): StatisticsAgeSexPoint[] {
    const points = payload.patientsByAgeRangeAndSex ?? [];
    if (points.length > 0) {
      return points;
    }

    return payload.patientsByAgeRange.map((point) => ({
      label: point.label,
      femaleCount: 0,
      maleCount: 0,
      unknownCount: point.count,
      totalCount: point.count
    }));
  }

  goToPendingPaymentsPage(page: number): void {
    const boundedPage = Math.min(Math.max(page, 1), this.pendingPaymentsTotalPages());
    this.pendingPaymentsPage.set(boundedPage);
  }
}
