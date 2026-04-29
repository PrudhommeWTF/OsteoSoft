import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJs,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip
} from 'chart.js';

import {
  DistributionPoint,
  StatisticsAgeSexPoint,
  StatisticsAntecedentRankItem,
  StatisticsCityRankItem,
  StatisticsConsultationReasonRankItem,
  StatisticsGranularity,
  StatisticsPatientRankItem,
  StatisticsPayload,
  StatisticsReferralRankItem,
  StatisticsScopeMode,
  StatisticsValuePoint,
  StatisticsYearSeries
} from '../../core/api.types';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BsTooltipDirective } from '../../core/bs-tooltip.directive';

type StatisticsCardId =
  | 'patients-sex'
  | 'patients-age'
  | 'patients-followed'
  | 'patients-missed'
  | 'patients-reasons'
  | 'patients-cities'
  | 'patients-antecedents'
  | 'patients-referrals'
  | 'consultations-evolution'
  | 'consultations-monthly'
  | 'consultations-type'
  | 'consultations-users'
  | 'payments-revenue-evolution'
  | 'payments-revenue-monthly'
  | 'payments-profit-evolution'
  | 'payments-profit-monthly'
  | 'payments-methods'
  | 'user-revenue-evolution'
  | 'user-revenue-monthly'
  | 'user-profit-evolution'
  | 'user-profit-monthly'
  | 'user-consultations-evolution'
  | 'user-consultations-monthly'
  | 'user-payment-methods';

type StatisticsCardDefinition = {
  id: StatisticsCardId;
  section: 'Patients' | 'Consultations' | 'Paiements' | 'Utilisateurs';
  title: string;
  icon: string;
  layout: 'half' | 'full';
};

type StatisticsCardState = {
  id: StatisticsCardId;
  collapsed: boolean;
};

type StatisticsSection = StatisticsCardDefinition['section'];

const STATISTICS_CARD_DEFINITIONS: Record<StatisticsCardId, StatisticsCardDefinition> = {
  'patients-sex': { id: 'patients-sex', section: 'Patients', title: 'Patients par sexe', icon: 'fa-solid fa-venus-mars', layout: 'half' },
  'patients-age': { id: 'patients-age', section: 'Patients', title: 'Patients par tranche d age', icon: 'fa-solid fa-chart-column', layout: 'half' },
  'patients-followed': { id: 'patients-followed', section: 'Patients', title: 'Top 10 des patients les plus suivis', icon: 'fa-solid fa-user-clock', layout: 'half' },
  'patients-missed': { id: 'patients-missed', section: 'Patients', title: 'Top 10 des patients ayant manque des rendez-vous', icon: 'fa-solid fa-calendar-xmark', layout: 'half' },
  'patients-reasons': { id: 'patients-reasons', section: 'Patients', title: 'Top 10 des motifs de consultation', icon: 'fa-solid fa-notes-medical', layout: 'half' },
  'patients-cities': { id: 'patients-cities', section: 'Patients', title: 'Top 10 des villes les plus representees', icon: 'fa-solid fa-city', layout: 'half' },
  'patients-antecedents': { id: 'patients-antecedents', section: 'Patients', title: 'Top 10 des antecedents les plus frequents', icon: 'fa-solid fa-heart-pulse', layout: 'half' },
  'patients-referrals': { id: 'patients-referrals', section: 'Patients', title: 'Top 10 des referrals', icon: 'fa-solid fa-share-nodes', layout: 'half' },
  'consultations-evolution': { id: 'consultations-evolution', section: 'Consultations', title: 'Evolution du nombre de consultations', icon: 'fa-solid fa-chart-line', layout: 'half' },
  'consultations-monthly': { id: 'consultations-monthly', section: 'Consultations', title: 'Consultations par mois et par annee', icon: 'fa-solid fa-wave-square', layout: 'half' },
  'consultations-type': { id: 'consultations-type', section: 'Consultations', title: 'Types de consultations', icon: 'fa-solid fa-chart-pie', layout: 'half' },
  'consultations-users': { id: 'consultations-users', section: 'Consultations', title: 'Consultations par utilisateur', icon: 'fa-solid fa-user-group', layout: 'half' },
  'payments-revenue-evolution': { id: 'payments-revenue-evolution', section: 'Paiements', title: 'Evolution du chiffre d affaires', icon: 'fa-solid fa-arrow-trend-up', layout: 'half' },
  'payments-revenue-monthly': { id: 'payments-revenue-monthly', section: 'Paiements', title: 'Chiffre d affaires par mois', icon: 'fa-solid fa-calendar-days', layout: 'half' },
  'payments-profit-evolution': { id: 'payments-profit-evolution', section: 'Paiements', title: 'Evolution des benefices', icon: 'fa-solid fa-sack-dollar', layout: 'half' },
  'payments-profit-monthly': { id: 'payments-profit-monthly', section: 'Paiements', title: 'Benefices par mois', icon: 'fa-solid fa-coins', layout: 'half' },
  'payments-methods': { id: 'payments-methods', section: 'Paiements', title: 'Repartition des types de paiement', icon: 'fa-solid fa-credit-card', layout: 'half' },
  'user-revenue-evolution': { id: 'user-revenue-evolution', section: 'Utilisateurs', title: 'Evolution du chiffre d affaires utilisateur', icon: 'fa-solid fa-chart-column', layout: 'half' },
  'user-revenue-monthly': { id: 'user-revenue-monthly', section: 'Utilisateurs', title: 'Chiffre d affaires mensuel utilisateur', icon: 'fa-solid fa-money-bill-trend-up', layout: 'half' },
  'user-profit-evolution': { id: 'user-profit-evolution', section: 'Utilisateurs', title: 'Evolution des benefices utilisateur', icon: 'fa-solid fa-scale-balanced', layout: 'half' },
  'user-profit-monthly': { id: 'user-profit-monthly', section: 'Utilisateurs', title: 'Benefices mensuels utilisateur', icon: 'fa-solid fa-wallet', layout: 'half' },
  'user-consultations-evolution': { id: 'user-consultations-evolution', section: 'Utilisateurs', title: 'Evolution des consultations utilisateur', icon: 'fa-solid fa-stethoscope', layout: 'half' },
  'user-consultations-monthly': { id: 'user-consultations-monthly', section: 'Utilisateurs', title: 'Consultations mensuelles utilisateur', icon: 'fa-solid fa-calendar-check', layout: 'half' },
  'user-payment-methods': { id: 'user-payment-methods', section: 'Utilisateurs', title: 'Types de paiement utilisateur', icon: 'fa-solid fa-chart-pie', layout: 'half' }
};

const DEFAULT_CARD_ORDER: StatisticsCardId[] = [
  'patients-sex',
  'patients-age',
  'patients-followed',
  'patients-missed',
  'patients-reasons',
  'patients-cities',
  'patients-antecedents',
  'patients-referrals',
  'consultations-evolution',
  'consultations-monthly',
  'consultations-type',
  'consultations-users',
  'payments-revenue-evolution',
  'payments-revenue-monthly',
  'payments-profit-evolution',
  'payments-profit-monthly',
  'payments-methods',
  'user-revenue-evolution',
  'user-revenue-monthly',
  'user-profit-evolution',
  'user-profit-monthly',
  'user-consultations-evolution',
  'user-consultations-monthly',
  'user-payment-methods'
];

const EMPTY_DISTRIBUTION: DistributionPoint[] = [];
const EMPTY_PATIENT_ROWS: StatisticsPatientRankItem[] = [];
const EMPTY_REASON_ROWS: StatisticsConsultationReasonRankItem[] = [];
const EMPTY_CITY_ROWS: StatisticsCityRankItem[] = [];
const EMPTY_ANTECEDENT_ROWS: StatisticsAntecedentRankItem[] = [];
const EMPTY_REFERRAL_ROWS: StatisticsReferralRankItem[] = [];
const EMPTY_VALUE_POINTS: StatisticsValuePoint[] = [];
const EMPTY_YEAR_SERIES: StatisticsYearSeries[] = [];
const EMPTY_AGE_POINTS: StatisticsAgeSexPoint[] = [];
const CHART_CARD_IDS: ReadonlySet<StatisticsCardId> = new Set<StatisticsCardId>([
  'patients-sex',
  'patients-age',
  'consultations-evolution',
  'consultations-monthly',
  'consultations-type',
  'consultations-users',
  'payments-revenue-evolution',
  'payments-revenue-monthly',
  'payments-profit-evolution',
  'payments-profit-monthly',
  'payments-methods',
  'user-revenue-evolution',
  'user-revenue-monthly',
  'user-profit-evolution',
  'user-profit-monthly',
  'user-consultations-evolution',
  'user-consultations-monthly',
  'user-payment-methods'
]);

ChartJs.register(
  LineController,
  DoughnutController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  BarElement,
  Tooltip,
  Legend,
  Filler
);

@Component({
  selector: 'app-statistiques-page',
  imports: [RouterLink, BsTooltipDirective],
  templateUrl: './statistiques.page.html',
  styleUrl: './statistiques.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StatistiquesPage implements AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly eurFormatter = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2
  });

  readonly pageRoot = viewChild<ElementRef<HTMLElement>>('pageRoot');

  readonly isLoading = signal(true);
  readonly errorMessage = signal('');
  readonly payload = signal<StatisticsPayload | null>(null);
  readonly scopeMode = signal<StatisticsScopeMode>('active-office');
  readonly selectedOfficeId = signal<number | null>(this.auth.activeOfficeId());
  readonly years = signal(5);
  readonly consultationGranularity = signal<StatisticsGranularity>('month');
  readonly selectedYears = signal<number[]>(this.buildFallbackYears(5));
  readonly selectedUserId = signal<number | null>(null);
  readonly activeSection = signal<StatisticsSection>('Patients');
  readonly draggedCardId = signal<StatisticsCardId | null>(null);
  readonly maximizedCardId = signal<StatisticsCardId | null>(null);
  readonly cards = signal<StatisticsCardState[]>(DEFAULT_CARD_ORDER.map((id) => ({ id, collapsed: false })));

  readonly officeOptions = computed(() => this.payload()?.scope.offices ?? []);
  readonly userOptions = computed(() => this.payload()?.scope.users ?? []);
  readonly canViewPeerStatistics = computed(() => this.payload()?.scope.canViewPeerStatistics ?? false);
  readonly availableYears = computed(() => this.payload()?.filters.availableYears ?? this.buildFallbackYears(this.years()));
  readonly selectedUserLabel = computed(() => {
    const targetId = this.selectedUserId();
    return this.userOptions().find((user) => user.id === targetId)?.displayName ?? 'Utilisateur';
  });
  readonly orderedCards = computed(() => this.cards().map((state) => ({ ...STATISTICS_CARD_DEFINITIONS[state.id], collapsed: state.collapsed })));
  readonly sectionTabs = computed(() => {
    const counts = this.orderedCards().reduce<Record<StatisticsSection, number>>((acc, card) => {
      acc[card.section] += 1;
      return acc;
    }, {
      Patients: 0,
      Consultations: 0,
      Paiements: 0,
      Utilisateurs: 0
    });

    return [
      { section: 'Patients' as const, icon: 'fa-solid fa-user-group', count: counts.Patients },
      { section: 'Consultations' as const, icon: 'fa-solid fa-stethoscope', count: counts.Consultations },
      { section: 'Paiements' as const, icon: 'fa-solid fa-sack-dollar', count: counts.Paiements },
      { section: 'Utilisateurs' as const, icon: 'fa-solid fa-users', count: counts.Utilisateurs }
    ];
  });
  readonly visibleCards = computed(() => this.orderedCards().filter((card) => card.section === this.activeSection()));

  readonly patientStats = computed(() => this.payload()?.patients ?? null);
  readonly consultationStats = computed(() => this.payload()?.consultations ?? null);
  readonly paymentStats = computed(() => this.payload()?.payments ?? null);
  readonly userStats = computed(() => this.payload()?.userStats ?? null);

  readonly EMPTY_DISTRIBUTION = EMPTY_DISTRIBUTION;
  readonly EMPTY_PATIENT_ROWS = EMPTY_PATIENT_ROWS;
  readonly EMPTY_REASON_ROWS = EMPTY_REASON_ROWS;
  readonly EMPTY_CITY_ROWS = EMPTY_CITY_ROWS;
  readonly EMPTY_ANTECEDENT_ROWS = EMPTY_ANTECEDENT_ROWS;
  readonly EMPTY_REFERRAL_ROWS = EMPTY_REFERRAL_ROWS;
  readonly EMPTY_VALUE_POINTS = EMPTY_VALUE_POINTS;
  readonly EMPTY_YEAR_SERIES = EMPTY_YEAR_SERIES;
  readonly EMPTY_AGE_POINTS = EMPTY_AGE_POINTS;

  private readonly charts = new Map<string, ChartJs>();
  private readonly activeOfficeSyncEffect = effect(() => {
    if (this.scopeMode() !== 'active-office') {
      return;
    }

    const activeOfficeId = this.auth.activeOfficeId();
    if (this.selectedOfficeId() === activeOfficeId) {
      return;
    }

    this.selectedOfficeId.set(activeOfficeId);
    void this.loadStatistics();
  });

  async ngAfterViewInit(): Promise<void> {
    await this.initialize();
  }

  ngOnDestroy(): void {
    this.destroyCharts();
  }

  async refresh(): Promise<void> {
    await this.loadStatistics();
  }

  async onScopeModeChange(rawValue: string): Promise<void> {
    const nextMode: StatisticsScopeMode = rawValue === 'consolidated' ? 'consolidated' : 'active-office';
    this.scopeMode.set(nextMode);
    if (nextMode === 'consolidated') {
      this.selectedOfficeId.set(null);
    } else if (this.selectedOfficeId() == null) {
      this.selectedOfficeId.set(this.auth.activeOfficeId());
    }
    await this.loadStatistics();
  }

  async onOfficeChange(rawValue: string): Promise<void> {
    const value = Number(rawValue);
    const nextOfficeId = Number.isInteger(value) && value > 0 ? value : null;
    if (nextOfficeId === this.selectedOfficeId()) {
      return;
    }

    this.auth.setActiveOfficeId(nextOfficeId);
  }

  async onYearsChange(rawValue: string): Promise<void> {
    const value = Number(rawValue);
    const normalized = Number.isInteger(value) && value > 0 ? Math.min(Math.max(value, 1), 10) : 5;
    this.years.set(normalized);
    this.selectedYears.set(this.buildFallbackYears(normalized));
    await this.loadStatistics();
  }

  async onGranularityChange(rawValue: string): Promise<void> {
    const nextGranularity: StatisticsGranularity = rawValue === 'quarter' || rawValue === 'year' ? rawValue : 'month';
    this.consultationGranularity.set(nextGranularity);
    await this.loadStatistics();
  }

  async onUserChange(rawValue: string): Promise<void> {
    const value = Number(rawValue);
    this.selectedUserId.set(Number.isInteger(value) && value > 0 ? value : null);
    await this.loadStatistics();
  }

  showSection(section: StatisticsSection): void {
    this.activeSection.set(section);
    const payload = this.payload();
    if (!payload) {
      return;
    }

    afterNextRender(
      () => this.renderCharts(payload),
      { injector: this.injector }
    );
  }

  isSectionActive(section: StatisticsSection): boolean {
    return this.activeSection() === section;
  }

  async toggleYear(year: number): Promise<void> {
    const current = this.selectedYears();
    const isSelected = current.includes(year);

    if (isSelected && current.length === 1) {
      return;
    }

    const next = isSelected
      ? current.filter((value) => value !== year)
      : [...current, year].sort((left, right) => right - left);

    this.selectedYears.set(next);
    await this.loadStatistics();
  }

  toggleCard(cardId: StatisticsCardId): void {
    this.cards.update((items) => items.map((item) => item.id === cardId ? { ...item, collapsed: !item.collapsed } : item));
    if (this.maximizedCardId() === cardId) {
      this.maximizedCardId.set(null);
    }
    queueMicrotask(() => {
      const payload = this.payload();
      if (payload) {
        this.renderCharts(payload);
      }
    });
  }

  onCardDragStart(cardId: StatisticsCardId): void {
    this.draggedCardId.set(cardId);
  }

  onCardDragEnd(): void {
    this.draggedCardId.set(null);
  }

  allowCardDrop(event: DragEvent): void {
    event.preventDefault();
  }

  onCardDragOver(event: DragEvent, targetCardId: StatisticsCardId): void {
    event.preventDefault();
    this.reorderDraggedCard(targetCardId);
  }

  onCardDrop(event: DragEvent, targetCardId: StatisticsCardId): void {
    event.preventDefault();
    this.reorderDraggedCard(targetCardId);
    this.draggedCardId.set(null);
  }

  isDraggedCard(cardId: StatisticsCardId): boolean {
    return this.draggedCardId() === cardId;
  }

  isChartCard(cardId: StatisticsCardId): boolean {
    return CHART_CARD_IDS.has(cardId);
  }

  toggleCardMaximization(cardId: StatisticsCardId): void {
    this.maximizedCardId.update((current) => current === cardId ? null : cardId);
    queueMicrotask(() => this.resizeCharts());
  }

  clearCardMaximization(): void {
    if (!this.maximizedCardId()) {
      return;
    }

    this.maximizedCardId.set(null);
    queueMicrotask(() => this.resizeCharts());
  }

  isCardMaximized(cardId: StatisticsCardId): boolean {
    return this.maximizedCardId() === cardId;
  }

  private reorderDraggedCard(targetCardId: StatisticsCardId): void {
    const draggedCardId = this.draggedCardId();
    if (!draggedCardId || draggedCardId === targetCardId) {
      return;
    }

    this.cards.update((items) => {
      const draggedSection = STATISTICS_CARD_DEFINITIONS[draggedCardId].section;
      const targetSection = STATISTICS_CARD_DEFINITIONS[targetCardId].section;
      if (draggedSection !== this.activeSection() || targetSection !== this.activeSection()) {
        return items;
      }

      const draggedIndex = items.findIndex((item) => item.id === draggedCardId);
      const targetIndex = items.findIndex((item) => item.id === targetCardId);
      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return items;
      }

      const next = [...items];
      const [moved] = next.splice(draggedIndex, 1);
      const adjustedTargetIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
      if (adjustedTargetIndex === draggedIndex) {
        return items;
      }
      next.splice(adjustedTargetIndex, 0, moved);
      return next;
    });
  }

  private resizeCharts(): void {
    for (const chart of this.charts.values()) {
      chart.resize();
    }
  }

  formatAge(age: number | null): string {
    return age == null ? '-' : `${age} ans`;
  }

  formatCurrency(cents: number): string {
    return this.eurFormatter.format(cents / 100);
  }

  isYearSelected(year: number): boolean {
    return this.selectedYears().includes(year);
  }

  hasDistributionData(points: DistributionPoint[]): boolean {
    return points.some((point) => point.count > 0);
  }

  hasYearSeriesData(series: StatisticsYearSeries[]): boolean {
    return series.some((year) => year.points.some((point) => point.value > 0));
  }

  hasValueSeriesData(points: StatisticsValuePoint[]): boolean {
    return points.some((point) => point.value > 0);
  }

  hasAgeSeriesData(points: StatisticsAgeSexPoint[]): boolean {
    return points.some((point) => point.totalCount > 0);
  }

  isUserCard(cardId: StatisticsCardId): boolean {
    return cardId.startsWith('user-');
  }

  getUserCardEmptyMessage(): string {
    return this.canViewPeerStatistics()
      ? 'Aucune statistique utilisateur disponible pour la sélection courante.'
      : 'Les statistiques utilisateur sont limitées à votre propre périmètre.';
  }

  private async initialize(): Promise<void> {
    try {
      const profile = await this.api.getMyUserProfile();
      const defaultYears = Number(profile?.defaultYearsForStatistics ?? 5);
      const normalizedYears = Number.isInteger(defaultYears) ? Math.min(Math.max(defaultYears, 1), 10) : 5;
      this.years.set(normalizedYears);
      this.selectedYears.set(this.buildFallbackYears(normalizedYears));
    } catch {
      this.years.set(5);
      this.selectedYears.set(this.buildFallbackYears(5));
    }

    await this.loadStatistics();
  }

  private async loadStatistics(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');

    try {
      const payload = await this.api.getStatistics({
        scopeMode: this.scopeMode(),
        officeId: this.scopeMode() === 'active-office' ? this.selectedOfficeId() : null,
        years: this.years(),
        yearlyBreakdownYears: this.selectedYears(),
        consultationGranularity: this.consultationGranularity(),
        userId: this.selectedUserId()
      });

      this.payload.set(payload);
      this.selectedYears.set(payload.filters.selectedYears);
      this.selectedUserId.set(payload.scope.selectedUserId);
      if (payload.scope.mode === 'active-office') {
        this.selectedOfficeId.set(payload.scope.selectedOfficeId);
      }

      afterNextRender(
        () => this.renderCharts(payload),
        { injector: this.injector }
      );
    } catch {
      this.payload.set(null);
      this.destroyCharts();
      this.errorMessage.set('Impossible de charger les statistiques pour la selection courante.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private renderCharts(payload: StatisticsPayload): void {
    this.destroyCharts();

    this.createDoughnutChart('patients-sex-chart', payload.patients.bySex, ['#3478f6', '#f25f5c', '#7f8c8d']);
    this.createStackedAgeChart('patients-age-chart', payload.patients.byAgeRangeAndSex);
    this.createLineChart('consultations-evolution-chart', payload.consultations.evolution, 'Consultations', '#3478f6');
    this.createMultiYearLineChart('consultations-monthly-combined', payload.consultations.monthlyByYear, 'Consultations');
    this.createDoughnutChart('consultations-type-chart', payload.consultations.byType, ['#f59e0b', '#0b8a74']);
    this.createDoughnutChart('consultations-users-chart', payload.consultations.byUser, ['#3478f6', '#0b8a74', '#f25f5c', '#7f8c8d', '#8e6cff', '#f59e0b']);
    this.createLineChart('payments-revenue-evolution-chart', payload.payments.revenueEvolution, 'Chiffre d affaires', '#3478f6');
    this.createMultiYearLineChart('payments-revenue-monthly-combined', payload.payments.revenueMonthlyByYear, 'CA');
    this.createLineChart('payments-profit-evolution-chart', payload.payments.profitEvolution, 'Benefices', '#0b8a74');
    this.createMultiYearLineChart('payments-profit-monthly-combined', payload.payments.profitMonthlyByYear, 'Benefices');
    this.createDoughnutChart('payments-methods-chart', payload.payments.paymentMethods, ['#3478f6', '#0b8a74', '#f25f5c', '#f59e0b', '#7f8c8d']);

    if (payload.userStats) {
      this.createLineChart('user-revenue-evolution-chart', payload.userStats.revenueEvolution, 'Chiffre d affaires', '#4d92d1');
      this.createMultiYearLineChart('user-revenue-monthly-combined', payload.userStats.revenueMonthlyByYear, 'CA');
      this.createLineChart('user-profit-evolution-chart', payload.userStats.profitEvolution, 'Benefices', '#3ca374');
      this.createMultiYearLineChart('user-profit-monthly-combined', payload.userStats.profitMonthlyByYear, 'Benefices');
      this.createLineChart('user-consultations-evolution-chart', payload.userStats.consultationEvolution, 'Consultations', '#f25f5c');
      this.createMultiYearLineChart('user-consultations-monthly-combined', payload.userStats.consultationMonthlyByYear, 'Consultations');
      this.createDoughnutChart('user-payment-methods-chart', payload.userStats.paymentMethods, ['#4d92d1', '#3ca374', '#f25f5c', '#f59e0b', '#7f8c8d']);
    }
  }

  private createDoughnutChart(chartKey: string, points: DistributionPoint[], colors: string[]): void {
    if (!this.hasDistributionData(points)) {
      return;
    }

    const canvas = this.findCanvas(chartKey);
    if (!canvas) {
      return;
    }

    const chart = new ChartJs(canvas, {
      type: 'doughnut',
      data: {
        labels: points.map((point) => point.label),
        datasets: [{
          data: points.map((point) => point.count),
          backgroundColor: colors,
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom'
          }
        }
      }
    });

    this.charts.set(chartKey, chart);
  }

  private createLineChart(chartKey: string, points: StatisticsValuePoint[], label: string, color: string): void {
    if (!this.hasValueSeriesData(points)) {
      return;
    }

    const canvas = this.findCanvas(chartKey);
    if (!canvas) {
      return;
    }

    const chart = new ChartJs(canvas, {
      type: 'line',
      data: {
        labels: points.map((point) => point.label),
        datasets: [{
          label,
          data: points.map((point) => point.value),
          borderColor: color,
          backgroundColor: `${color}22`,
          fill: true,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true
          }
        },
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

    this.charts.set(chartKey, chart);
  }

  private createBarChart(chartKey: string, points: StatisticsValuePoint[], label: string, color: string): void {
    if (!this.hasValueSeriesData(points)) {
      return;
    }

    const canvas = this.findCanvas(chartKey);
    if (!canvas) {
      return;
    }

    const chart = new ChartJs(canvas, {
      type: 'bar',
      data: {
        labels: points.map((point) => point.label),
        datasets: [{
          label,
          data: points.map((point) => point.value),
          backgroundColor: color
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
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

    this.charts.set(chartKey, chart);
  }

  private createMultiYearLineChart(chartKey: string, series: StatisticsYearSeries[], datasetPrefix: string): void {
    if (!this.hasYearSeriesData(series)) {
      return;
    }

    const canvas = this.findCanvas(chartKey);
    if (!canvas) {
      return;
    }

    const labels = series[0]?.points.map((point) => point.label) ?? [];
    const palette = ['#3478f6', '#0b8a74', '#f25f5c', '#f59e0b', '#7f8c8d', '#8e6cff', '#00a8cc', '#6a4c93'];
    const datasets = series.map((yearSeries, index) => ({
      label: `${datasetPrefix} ${yearSeries.year}`,
      data: yearSeries.points.map((point) => point.value),
      borderColor: palette[index % palette.length],
      backgroundColor: `${palette[index % palette.length]}22`,
      fill: false,
      tension: 0.3
    }));

    const chart = new ChartJs(canvas, {
      type: 'line',
      data: {
        labels,
        datasets
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

    this.charts.set(chartKey, chart);
  }

  private createStackedAgeChart(chartKey: string, points: StatisticsAgeSexPoint[]): void {
    if (!this.hasAgeSeriesData(points)) {
      return;
    }

    const canvas = this.findCanvas(chartKey);
    if (!canvas) {
      return;
    }

    const chart = new ChartJs(canvas, {
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
            label: 'Non renseigne',
            data: points.map((point) => point.unknownCount),
            backgroundColor: '#7f8c8d'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true },
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

    this.charts.set(chartKey, chart);
  }

  private findCanvas(chartKey: string): HTMLCanvasElement | null {
    const root = this.pageRoot()?.nativeElement;
    if (!root) {
      return null;
    }

    return root.querySelector(`canvas[data-chart-key="${chartKey}"]`);
  }

  private destroyCharts(): void {
    for (const chart of this.charts.values()) {
      chart.destroy();
    }
    this.charts.clear();
  }

  private buildFallbackYears(years: number): number[] {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: Math.min(Math.max(years, 1), 10) }, (_value, index) => currentYear - index);
  }
}