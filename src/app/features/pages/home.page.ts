import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
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
import { DashboardEvent, DashboardPayload, StatisticsAgeSexPoint } from '../../core/api.types';
import { TopbarService } from '../../core/topbar.service';

type PendingPayment = DashboardPayload['pendingPayments'][number];
type PendingPaymentRow = PendingPayment & { amountLabel: string; dueDateLabel: string };

type AgeBracket = { label: string; femaleW: string; maleW: string; unknownW: string; total: number };

/** Small badge in the top-right of each KPI card */
type KpiBadge = {
  text: string;
  icon: string | null;
  cls: 'kpi-badge--ok' | 'kpi-badge--danger' | 'kpi-badge--neutral';
};

type TeamMember = {
  id: number;
  displayName: string;
  role: string;
  cabinet: string;
  retro: string | null; // null = don't show; '—' or 'XX%' when visible
  isYou: boolean;
};

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
  imports: [RouterLink],
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomePage implements AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly authService = inject(AuthService);
  private readonly topbar = inject(TopbarService);
  private readonly injector = inject(Injector);
  private readonly eurFormatter = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0
  });

  readonly monthlyChartHost = viewChild<ElementRef<HTMLCanvasElement>>('monthlyChartHost');

  readonly isLoading = signal(true);
  readonly greetingFirstName = signal('');
  readonly currentUserUsername = signal('');
  readonly todayEvents = signal<DashboardEvent[]>([]);
  readonly nextAppointment = signal<DashboardEvent | null>(null);
  readonly teamMembers = signal<TeamMember[]>([]);
  readonly agendaSessionMinutes = signal(60);


  /* KPI counters (animated) */
  readonly kpiConsultationsToday = signal(0);
  readonly kpiUpcomingAppointments = signal(0);
  readonly kpiActivePatients = signal(0);
  readonly kpiMonthlyRevenue = signal(0);
  readonly kpiMonthlyRevenueLabel = computed(() =>
    new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(this.kpiMonthlyRevenue()) + ' €'
  );

  /* KPI trend badges */
  // Badge 1: today vs daily average of last 30 days (last complete month / 30)
  readonly kpiBadge1 = computed((): KpiBadge => this.computeTodayVs30dAvg());
  // Badge 2: fixed label showing the 7-day scope of the KPI
  readonly kpiBadge2 = computed((): KpiBadge => ({ text: '7 prochains jours', icon: 'fa-clock', cls: 'kpi-badge--neutral' }));
  // Badge 3: new patients acquired this month
  readonly kpiBadge3 = computed((): KpiBadge => this.computeNewPatientsThisMonth());
  // Badge 4: month-over-month consultation evolution
  readonly kpiBadge4 = computed((): KpiBadge => this.computeMonthTrend());

  /* Pending payments */
  readonly pendingPayments = signal<DashboardPayload['pendingPayments']>([]);
  readonly pendingPaymentsPage = signal(1);
  private static readonly PAGE_SIZE = 5;

  readonly pendingTotalCount = computed(() => this.pendingPayments().length);
  readonly pendingTotalAmount = computed(() =>
    this.pendingPayments().reduce((sum, p) => sum + (p.amountEur ?? 0), 0)
  );
  readonly pendingBadgeLabel = computed(() => {
    const count = this.pendingTotalCount();
    const amount = this.pendingTotalAmount();
    if (count === 0) return '';
    const amountStr = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(amount) + ' €';
    return `${count} · ${amountStr}`;
  });

  readonly pendingPaymentsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.pendingPayments().length / HomePage.PAGE_SIZE))
  );

  readonly pendingPaymentsPageItems = computed<PendingPaymentRow[]>(() => {
    const page = this.pendingPaymentsPage();
    const start = (page - 1) * HomePage.PAGE_SIZE;
    return this.pendingPayments()
      .slice(start, start + HomePage.PAGE_SIZE)
      .map((p) => ({
        ...p,
        amountLabel: this.eurFormatter.format(p.amountEur),
        dueDateLabel: this.formatDueAt(p.dueAt)
      }));
  });

  readonly hasPendingPaymentsPagination = computed(() => this.pendingPaymentsTotalPages() > 1);

  /* Monthly chart */
  readonly hasMonthlyChartData = computed(() =>
    (this.pendingPayload()?.monthlyConsultations ?? []).some((pt) => Number(pt.count) > 0)
  );

  readonly monthlyTotal = computed(() =>
    (this.pendingPayload()?.monthlyConsultations ?? []).reduce((sum, pt) => sum + pt.count, 0)
  );

  /* Age/sex distribution — HTML bars */
  readonly ageBrackets = computed((): AgeBracket[] => {
    const p = this.pendingPayload();
    if (!p) return [];
    const pts = this.normalizeAgeSexPoints(p);
    if (pts.length === 0) return [];
    const maxTotal = Math.max(...pts.map((pt) => pt.totalCount), 1);
    return pts.map((pt) => ({
      label: pt.label,
      femaleW: `${((pt.femaleCount / maxTotal) * 100).toFixed(1)}%`,
      maleW: `${((pt.maleCount / maxTotal) * 100).toFixed(1)}%`,
      unknownW: `${((pt.unknownCount / maxTotal) * 100).toFixed(1)}%`,
      total: pt.totalCount
    }));
  });

  readonly hasAgeBrackets = computed(() => this.ageBrackets().some((b) => b.total > 0));

  private readonly pendingPayload = signal<DashboardPayload | null>(null);
  private monthlyChart: ChartJs<'bar'> | null = null;

  readonly todayLong = computed(() =>
    new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(new Date())
  );

  /** Label smart pour le prochain RDV : heure seule si aujourd'hui, sinon jour/date + heure */
  readonly nextAppointmentLabel = computed(() => {
    const ev = this.nextAppointment();
    if (!ev) return '';
    const start = new Date(ev.start);
    if (isNaN(start.getTime())) return this.formatTime(ev.start);

    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const evMidnight = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const diffDays = Math.round((evMidnight.getTime() - todayMidnight.getTime()) / 86_400_000);

    const timeStr = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    if (diffDays === 0) return timeStr;
    if (diffDays === 1) return `Demain · ${timeStr}`;
    if (diffDays < 7) {
      const dow = start.toLocaleDateString('fr-FR', { weekday: 'long' });
      return `${dow.charAt(0).toUpperCase() + dow.slice(1)} · ${timeStr}`;
    }
    const date = start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    return `${date} · ${timeStr}`;
  });

  async ngAfterViewInit(): Promise<void> {
    this.topbar.setPage('Tableau de bord');
    await this.load();
  }

  ngOnDestroy(): void {
    this.monthlyChart?.destroy();
    this.topbar.clearPage();
  }

  formatTime(isoOrTime: string): string {
    if (!isoOrTime) return '';
    const dateStr = isoOrTime.includes('T') ? isoOrTime : `1970-01-01T${isoOrTime}`;
    const d = new Date(dateStr);
    return isNaN(d.getTime())
      ? isoOrTime
      : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  formatDuration(minutes: number): string {
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
    }
    return `${minutes} min`;
  }

  formatDueAt(dueAt: string): string {
    if (!dueAt) return '';
    const d = new Date(dueAt);
    return isNaN(d.getTime())
      ? dueAt
      : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  getEventInitials(patientName: string): string {
    const parts = (patientName ?? '').trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return patientName.slice(0, 2).toUpperCase();
  }

  getPractitionerInitials(name: string): string {
    return this.getEventInitials(name);
  }

  getStatusClass(status: string): string {
    const s = status?.toLowerCase() ?? '';
    if (s === 'termine' || s === 'réglé' || s === 'regle') return 'badge-ok';
    if (s === 'en attente' || s === 'a confirmer' || s === 'à confirmer') return 'badge-warn';
    if (s === 'annulé' || s === 'annule' || s === 'en retard') return 'badge-danger';
    return 'badge-neutral';
  }

  getStatusLabel(status: string): string {
    const map: Record<string, string> = {
      Termine: 'Terminé',
      'A confirmer': 'À confirmer',
      'En attente': 'En attente',
      'En retard': 'En retard',
      'Annulé': 'Annulé',
    };
    return map[status] ?? status;
  }

  getPaymentStatusClass(status: string): string {
    const s = status?.toLowerCase() ?? '';
    if (s === 'regle' || s === 'réglé') return 'badge-ok';
    if (s === 'en attente') return 'badge-warn';
    if (s === 'en retard') return 'badge-danger';
    return 'badge-neutral';
  }

  goToPendingPaymentsPage(page: number): void {
    this.pendingPaymentsPage.set(Math.min(Math.max(page, 1), this.pendingPaymentsTotalPages()));
  }

  private async load(): Promise<void> {
    try {
      const officeId = this.authService.activeOfficeId();
      const isAdmin = this.authService.role() === 'admin';

      const [dashboard, patientCount, billing, profile, teamData] = await Promise.all([
        this.api.getDashboard(officeId),
        this.api.getPatientCount(),
        this.api.getBillingMonthlyRevenue(officeId),
        this.api.getMyUserProfile(),
        isAdmin ? this.api.getUsers() : this.api.getPractitioners()
      ]);

      this.greetingFirstName.set(profile.firstName || profile.username || '');
      const myUsername = profile.username || '';
      this.currentUserUsername.set(myUsername);

      // Build team rows — both AccessManagedUser (admin) and Practitioner have the needed fields now
      const members: TeamMember[] = (teamData as Array<{
        id: number; username: string; firstName?: string; lastName?: string;
        displayName?: string; role: string; cabinetName?: string; retrocessionPercent?: number;
      }>).map((u) => {
        const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ');
        const displayName = u.displayName || fullName || u.username;
        const cabinet = u.cabinetName ?? '';
        const isYou = u.username === myUsername;
        let retro: string | null = null;
        if (isAdmin) {
          const pct = u.retrocessionPercent ?? 0;
          retro = isYou ? '—' : pct > 0 ? `${pct}%` : '—';
        }
        return { id: u.id, displayName, role: u.role, cabinet, retro, isYou };
      });
      this.teamMembers.set(members);

      if (dashboard.agendaSettings?.defaultSessionDurationMinutes) {
        this.agendaSessionMinutes.set(dashboard.agendaSettings.defaultSessionDurationMinutes);
      }

      // Sort all events chronologically
      const allSorted = [...dashboard.events].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

      // ── Today's events — use LOCAL date to avoid UTC-day boundary issues ──
      const now = new Date();
      const todayDateStr = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
      ].join('-');

      const todayEvs = allSorted.filter((e) => {
        if (!e.start) return false;
        // ISO strings start with "YYYY-MM-DD"; time-only strings have no date prefix
        return e.start.includes('T')
          ? e.start.slice(0, 10) === todayDateStr
          : true; // time-only → treat as today (API may return relative times)
      });
      this.todayEvents.set(todayEvs);

      // Next upcoming appointment (any date, status not Termine)
      const nextEv = allSorted.find((e) => {
        const start = new Date(e.start);
        return !isNaN(start.getTime()) && start > now && e.status !== 'Termine';
      });
      this.nextAppointment.set(nextEv ?? null);

      // ── KPI values ──
      // "Consultations du jour" = all appointments scheduled for today
      const consultationsToday = todayEvs.length;

      // "RDV à venir" = upcoming appointments across the whole returned period
      const rdvAVenir = allSorted.filter((e) => {
        const start = new Date(e.start);
        return !isNaN(start.getTime()) && start > now && e.status !== 'Termine';
      }).length;

      const revenue = Math.round(Number(billing.amountCents ?? 0) / 100);

      this.pendingPayments.set(dashboard.pendingPayments);
      this.pendingPaymentsPage.set(1);
      this.pendingPayload.set(dashboard);
      this.isLoading.set(false);

      afterNextRender(
        () => {
          this.animateKpi((v) => this.kpiConsultationsToday.set(v), consultationsToday);
          this.animateKpi((v) => this.kpiUpcomingAppointments.set(v), rdvAVenir);
          this.animateKpi((v) => this.kpiActivePatients.set(v), patientCount);
          this.animateKpi((v) => this.kpiMonthlyRevenue.set(v), revenue);
          const p = this.pendingPayload();
          if (p) this.renderCharts(p);
        },
        { injector: this.injector }
      );
    } catch {
      this.isLoading.set(false);
    }
  }

  private animateKpi(setter: (v: number) => void, target: number, duration = 900): void {
    // Always call setter, even for 0, to ensure the signal reflects the loaded value
    const start = performance.now();
    if (target === 0) {
      setter(0);
      return;
    }
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setter(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private computeTodayVs30dAvg(): KpiBadge {
    const monthly = this.pendingPayload()?.monthlyConsultations ?? [];
    // Need a completed month before the current one to estimate daily average
    if (monthly.length < 2) return { text: 'Moy. 30j', icon: null, cls: 'kpi-badge--neutral' };
    // Use the second-to-last entry as the last complete month
    const lastCompleteCount = monthly[monthly.length - 2].count;
    const dailyAvg = lastCompleteCount / 30;
    const today = this.kpiConsultationsToday();
    const delta = today - Math.round(dailyAvg);
    if (dailyAvg === 0) return { text: 'Moy. 30j', icon: null, cls: 'kpi-badge--neutral' };
    const sign = delta >= 0 ? '+' : '';
    return {
      text: `${sign}${delta} vs moy. 30j`,
      icon: delta > 0 ? 'fa-arrow-up' : delta < 0 ? 'fa-arrow-down' : null,
      cls: delta > 0 ? 'kpi-badge--ok' : delta < 0 ? 'kpi-badge--danger' : 'kpi-badge--neutral'
    };
  }

  private computeNewPatientsThisMonth(): KpiBadge {
    const payload = this.pendingPayload();
    if (!payload) return { text: 'Nouveaux', icon: null, cls: 'kpi-badge--neutral' };
    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = payload.events.filter(
      (e) => e.isNewPatient && e.start?.slice(0, 7) === currentMonthStr
    ).length;
    if (count === 0) return { text: 'Nouveaux', icon: null, cls: 'kpi-badge--neutral' };
    return {
      text: `+${count} ce mois`,
      icon: 'fa-arrow-up',
      cls: 'kpi-badge--ok'
    };
  }

  private computeMonthTrend(): KpiBadge {
    const monthly = this.pendingPayload()?.monthlyConsultations ?? [];
    // Need at least 2 data points
    if (monthly.length < 2) return { text: 'Ce mois', icon: null, cls: 'kpi-badge--neutral' };

    // Compare the last two entries (chronologically ordered by the API)
    const curr = monthly[monthly.length - 1].count;
    const prev = monthly[monthly.length - 2].count;

    if (prev === 0) return { text: 'Ce mois', icon: null, cls: 'kpi-badge--neutral' };

    const delta = Math.round(((curr - prev) / prev) * 100);
    const sign = delta >= 0 ? '+' : '';
    return {
      text: `${sign}${delta}% vs mois préc.`,
      icon: delta > 0 ? 'fa-arrow-up' : delta < 0 ? 'fa-arrow-down' : null,
      cls: delta > 0 ? 'kpi-badge--ok' : delta < 0 ? 'kpi-badge--danger' : 'kpi-badge--neutral'
    };
  }

  private renderCharts(payload: DashboardPayload): void {
    this.monthlyChart?.destroy();

    const monthlyEl = this.monthlyChartHost()?.nativeElement;

    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3f6fb0';
    const accentSoft = getComputedStyle(document.documentElement).getPropertyValue('--accent-soft').trim() || '#e8f0f9';

    if (this.hasMonthlyChartData() && monthlyEl) {
      const currentMonth = new Date().toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '').toLowerCase();
      const colors = payload.monthlyConsultations.map((pt) =>
        pt.month.toLowerCase().startsWith(currentMonth) ? accentColor : accentSoft
      );

      this.monthlyChart = new ChartJs(monthlyEl, {
        type: 'bar',
        data: {
          labels: payload.monthlyConsultations.map((pt) => pt.month),
          datasets: [
            {
              label: 'Consultations',
              data: payload.monthlyConsultations.map((pt) => pt.count),
              backgroundColor: colors,
              borderRadius: 4,
              borderSkipped: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 11 } } },
            y: { beginAtZero: true, ticks: { precision: 0, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } }
          }
        }
      });
    }
  }

  private normalizeAgeSexPoints(payload: DashboardPayload): StatisticsAgeSexPoint[] {
    const pts = payload.patientsByAgeRangeAndSex ?? [];
    if (pts.length > 0) return pts;
    return payload.patientsByAgeRange.map((pt) => ({
      label: pt.label,
      femaleCount: 0,
      maleCount: 0,
      unknownCount: pt.count,
      totalCount: pt.count
    }));
  }
}
