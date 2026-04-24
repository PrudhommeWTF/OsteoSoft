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
import Chart from 'chart.js/auto';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { AgendaSettings, DashboardEvent, DashboardPayload } from '../../core/api.types';
import { WeekCalendar } from './week-calendar';

@Component({
  selector: 'app-home-page',
  imports: [RouterLink, WeekCalendar],
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomePage implements AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly injector = inject(Injector);

  readonly monthlyChartHost = viewChild<ElementRef<HTMLCanvasElement>>('monthlyChartHost');
  readonly sexChartHost = viewChild<ElementRef<HTMLCanvasElement>>('sexChartHost');
  readonly ageChartHost = viewChild<ElementRef<HTMLCanvasElement>>('ageChartHost');

  readonly isLoading = signal(true);
  readonly recentPatients = signal<DashboardPayload['recentPatients']>([]);
  readonly pendingPayments = signal<DashboardPayload['pendingPayments']>([]);
  readonly calendarEvents = signal<DashboardEvent[]>([]);
  readonly calendarSettings = signal<AgendaSettings | null>(null);
  readonly defaultAgendaView = signal<string>('Semaine');

  readonly hasMonthlyChartData = computed(() =>
    (this.pendingPayload()?.monthlyConsultations ?? []).some((point) => Number(point.count) > 0)
  );
  readonly hasSexChartData = computed(() =>
    (this.pendingPayload()?.patientsBySex ?? []).some((point) => Number(point.count) > 0)
  );
  readonly hasAgeChartData = computed(() =>
    (this.pendingPayload()?.patientsByAgeRange ?? []).some((point) => Number(point.count) > 0)
  );

  private readonly pendingPayload = signal<DashboardPayload | null>(null);

  private monthlyChart: Chart<'line'> | null = null;
  private sexChart: Chart<'doughnut'> | null = null;
  private ageChart: Chart<'bar'> | null = null;

  async ngAfterViewInit(): Promise<void> {
    await this.load();
  }

  ngOnDestroy(): void {
    this.monthlyChart?.destroy();
    this.sexChart?.destroy();
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
      this.calendarEvents.set(payload.events);
      this.calendarSettings.set(payload.agendaSettings);
      this.defaultAgendaView.set(profile.defaultAgendaView || 'Semaine');
      this.pendingPayload.set(payload);
      this.isLoading.set(false);
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


  private renderCharts(payload: DashboardPayload): void {
    this.monthlyChart?.destroy();
    this.sexChart?.destroy();
    this.ageChart?.destroy();

    const monthlyEl = this.monthlyChartHost()?.nativeElement;
    const sexEl = this.sexChartHost()?.nativeElement;
    const ageEl = this.ageChartHost()?.nativeElement;

    if (this.hasMonthlyChartData() && monthlyEl) {
      this.monthlyChart = new Chart(monthlyEl, {
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

    if (this.hasSexChartData() && sexEl) {
      this.sexChart = new Chart(sexEl, {
        type: 'doughnut',
        data: {
          labels: payload.patientsBySex.map((point) => point.label),
          datasets: [
            {
              data: payload.patientsBySex.map((point) => point.count),
              backgroundColor: ['#4d92d1', '#f08a5d', '#7f8c8d', '#8bc34a']
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

    if (this.hasAgeChartData() && ageEl) {
      this.ageChart = new Chart(ageEl, {
        type: 'bar',
        data: {
          labels: payload.patientsByAgeRange.map((point) => point.label),
          datasets: [
            {
              label: 'Patients',
              data: payload.patientsByAgeRange.map((point) => point.count),
              backgroundColor: '#3ca374'
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
  }
}
