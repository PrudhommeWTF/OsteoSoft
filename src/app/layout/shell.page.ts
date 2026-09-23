import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { ApiService } from '../core/api.service';
import { ChangelogEntry, Patient } from '../core/api.types';
import { AuthService } from '../core/auth.service';
import { ConfigService } from '../core/config.service';
import { SystemUpdateService } from '../core/system-update.service';
import { ThemeService } from '../core/theme.service';
import { TopbarService } from '../core/topbar.service';
import { BsTooltipDirective } from '../core/bs-tooltip.directive';

type NavItem = {
  label: string;
  icon: string;
  path?: string;
  badge?: string;
  exact?: boolean;
  disabled?: boolean;
  requiredPermission?: string;
  adminOnly?: boolean;
  group: 'pilotage' | 'cabinet';
};

const PAGE_TITLE_MAP: Record<string, string> = {
  Accueil: 'Tableau de bord',
  Facturation: 'Facturation & comptabilité',
};

@Component({
  selector: 'app-shell-page',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, BsTooltipDirective],
  templateUrl: './shell.page.html',
  styleUrl: './shell.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ShellPage implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly configService = inject(ConfigService);
  readonly topbar = inject(TopbarService);
  readonly themeService = inject(ThemeService);
  readonly updates = inject(SystemUpdateService);

  readonly isMenuOpen = signal(false);
  readonly isOfficeDropdownOpen = signal(false);
  readonly isCreditsModalOpen = signal(false);
  readonly isChangelogModalOpen = signal(false);
  readonly changelogEntries = signal<ChangelogEntry[]>([]);

  readonly username = this.authService.username;
  readonly role = this.authService.role;
  readonly profileLabel = this.authService.profileLabel;
  readonly offices = this.authService.offices;
  readonly activeOfficeId = this.authService.activeOfficeId;

  readonly now = signal(new Date());

  readonly topbarSearch = signal('');
  readonly topbarSearchResults = signal<Patient[]>([]);
  readonly isSearchingPatients = signal(false);

  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private searchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private searchRequestId = 0;

  readonly currentPageTitle = signal<string>('Tableau de bord');
  readonly currentUrl = signal<string>(this.router.url);

  readonly topbarSubtitle = computed(() => {
    const date = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(this.now());

    const officeId = this.activeOfficeId();
    const officeName = this.offices().find((o) => o.id === officeId)?.name;
    const context = officeId === null ? 'vue globale' : (officeName ?? '');

    return context ? `${date} · ${context}` : date;
  });

  readonly initials = computed(() => {
    const label = this.profileLabel() || this.username() || '';
    const clean = label.replace(/^(Dr\.?\s+|Pr\.?\s+|M\.?\s+|Mme\.?\s+)/i, '');
    const parts = clean.trim().split(/\s+/);
    if (parts.length >= 2) {
      return ((parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '')).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase() || '??';
  });

  readonly activeOfficeName = computed(() => {
    const id = this.activeOfficeId();
    if (id === null) return 'Tous mes cabinets';
    return this.offices().find((o) => o.id === id)?.name ?? 'Cabinet';
  });

  readonly activeOfficeSubLabel = computed(() => {
    const id = this.activeOfficeId();
    if (id === null) return `${this.offices().length} cabinets`;
    return '';
  });

  readonly isDark = computed(() => this.themeService.effectiveTheme() === 'dark');

  readonly navItems = signal<NavItem[]>([
    { path: '/accueil', label: 'Accueil', icon: 'fa-solid fa-house', exact: true, requiredPermission: 'read-dashboard', group: 'pilotage' },
    { path: '/agenda', label: 'Agenda', icon: 'fa-solid fa-calendar-days', exact: true, requiredPermission: 'read-agenda', badge: '...', group: 'pilotage' },
    { path: '/patients', label: 'Listing patients', icon: 'fa-solid fa-list-ul', exact: false, requiredPermission: 'read-patient-list', badge: '...', group: 'pilotage' },
    { path: '/facturation', label: 'Facturation', icon: 'fa-solid fa-file-invoice-dollar', requiredPermission: 'read-billing-kpis', group: 'pilotage' },
    { path: '/statistiques', label: 'Statistiques', icon: 'fa-solid fa-chart-column', requiredPermission: 'read-advanced-statistics', group: 'pilotage' },
    { path: '/repertoire', label: 'Répertoire', icon: 'fa-solid fa-address-book', exact: true, requiredPermission: 'read-directory', group: 'cabinet' },
    { path: '/parametres', label: 'Paramètres', icon: 'fa-solid fa-gear', exact: true, adminOnly: true, group: 'cabinet' },
    { path: '/administration-cabinet', label: 'Administration', icon: 'fa-solid fa-building', exact: true, requiredPermission: 'read-office-settings', group: 'cabinet' },
  ]);

  readonly isAdmin = computed(() => this.role() === 'admin' || this.authService.isSuperAdmin());

  /** Libelle de la cloche quand une nouvelle version est publiee (administrateurs). */
  readonly updateNotice = computed(() => {
    const info = this.updates.info();
    return this.isAdmin() && info?.updateAvailable ? `Version ${info.latest} disponible` : '';
  });

  readonly visibleNavItems = computed(() => {
    const isAdmin = this.isAdmin();

    return this.navItems().filter((item) => {
      if (isAdmin && item.path === '/administration-cabinet') return false;
      if (item.adminOnly && !isAdmin) return false;
      if (!item.requiredPermission) return true;
      return this.authService.hasPermission(item.requiredPermission);
    });
  });

  readonly pilotageNavItems = computed(() => this.visibleNavItems().filter((i) => i.group === 'pilotage'));
  readonly cabinetNavItems = computed(() => this.visibleNavItems().filter((i) => i.group === 'cabinet'));

  ngOnInit(): void {
    this.clockTimer = setInterval(() => this.now.set(new Date()), 1000);

    // Track page title from router
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((e) => {
        this.currentUrl.set((e as NavigationEnd).urlAfterRedirects);
        let route = this.router.routerState.root;
        while (route.firstChild) route = route.firstChild;
        const routeTitle = route.snapshot.title ?? '';
        this.currentPageTitle.set(PAGE_TITLE_MAP[routeTitle] ?? routeTitle);
      });

    // Set initial page title
    let route = this.router.routerState.root;
    while (route.firstChild) route = route.firstChild;
    const routeTitle = route.snapshot.title ?? '';
    this.currentPageTitle.set(PAGE_TITLE_MAP[routeTitle] ?? routeTitle);

    // Load badges
    this.api.getChangelog().then((entries) => this.changelogEntries.set(entries)).catch(() => this.changelogEntries.set([]));
    void this.refreshAgendaBadge();
    void this.refreshPatientsBadge();
    void this.refreshBillingBadge();
    // Verification gardee en cache cote serveur : pas d'appel GitHub a chaque ouverture.
    if (this.isAdmin()) {
      void this.updates.check();
    }
  }

  ngOnDestroy(): void {
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    if (this.searchDebounceId !== null) clearTimeout(this.searchDebounceId);
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.isOfficeDropdownOpen.set(false);
  }

  toggleOfficeDropdown(event: Event): void {
    event.stopPropagation();
    this.isOfficeDropdownOpen.update((v) => !v);
  }

  selectOffice(officeId: number | null, event: Event): void {
    event.stopPropagation();
    this.isOfficeDropdownOpen.set(false);
    this.authService.setActiveOfficeId(officeId);
    void this.refreshAgendaBadge();
    void this.refreshBillingBadge();
  }

  toggleMenu(): void {
    this.isMenuOpen.update((v) => !v);
  }

  closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  toggleQuickTheme(): void {
    this.themeService.toggleQuickTheme();
  }

  async navigateToNewPatient(): Promise<void> {
    await this.router.navigate(['/patients/nouveau']);
  }

  async navigateToNewAppointment(): Promise<void> {
    await this.router.navigate(['/agenda']);
    this.topbar.openCreateAppointmentRequest.update((n) => n + 1);
  }

  onTopbarSearchChange(value: string): void {
    this.topbarSearch.set(value);
    const term = value.trim();

    if (this.searchDebounceId !== null) {
      clearTimeout(this.searchDebounceId);
      this.searchDebounceId = null;
    }

    if (term.length < 2) {
      this.topbarSearchResults.set([]);
      this.isSearchingPatients.set(false);
      return;
    }

    this.isSearchingPatients.set(true);
    this.searchDebounceId = setTimeout(() => void this.searchPatients(term), 220);
  }

  clearSearchResults(): void {
    this.topbarSearchResults.set([]);
  }

  async openPatientFromSearch(patientId: number): Promise<void> {
    this.topbarSearch.set('');
    this.topbarSearchResults.set([]);
    this.isSearchingPatients.set(false);
    await this.router.navigate(['/patients', patientId]);
    this.closeMenu();
  }

  formatPatientName(fullName: string): string {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length <= 1) return fullName;
    const [lastName, ...firstNameParts] = parts;
    return `${lastName.toUpperCase()} ${firstNameParts.join(' ')}`;
  }

  getPatientInitials(fullName: string): string {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return fullName.slice(0, 2).toUpperCase();
  }

  async logout(): Promise<void> {
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }

  openChangelogModal(): void {
    this.isChangelogModalOpen.set(true);
  }

  closeChangelogModal(): void {
    this.isChangelogModalOpen.set(false);
  }

  openCreditsModal(): void {
    this.isCreditsModalOpen.set(true);
  }

  closeCreditsModal(): void {
    this.isCreditsModalOpen.set(false);
  }

  private async searchPatients(term: string): Promise<void> {
    const requestId = ++this.searchRequestId;
    try {
      const patients = await this.api.getPatients(term);
      if (requestId !== this.searchRequestId) return;
      this.topbarSearchResults.set(patients.slice(0, 8));
    } catch {
      if (requestId === this.searchRequestId) this.topbarSearchResults.set([]);
    } finally {
      if (requestId === this.searchRequestId) this.isSearchingPatients.set(false);
    }
  }

  private updateNavBadge(label: string, badge: string): void {
    this.navItems.update((items) => items.map((item) => (item.label === label ? { ...item, badge } : item)));
  }

  private async refreshAgendaBadge(): Promise<void> {
    try {
      const payload = await this.api.getAppointments(this.activeOfficeId());
      const value = Math.max(0, Math.trunc(Number(payload?.stats?.consultationsToday ?? 0)));
      this.updateNavBadge('Agenda', value > 0 ? String(value) : '');
    } catch {
      this.updateNavBadge('Agenda', '');
    }
  }

  private async refreshPatientsBadge(): Promise<void> {
    try {
      const count = await this.api.getPatientCount();
      this.updateNavBadge('Listing patients',String(count));
    } catch {
      this.updateNavBadge('Listing patients','');
    }
  }

  private async refreshBillingBadge(): Promise<void> {
    try {
      const revenue = await this.api.getBillingMonthlyRevenue(this.activeOfficeId());
      const amount = Math.round(Number(revenue.amountCents ?? 0) / 100);
      this.updateNavBadge('Facturation', amount > 0 ? `${amount} €` : '');
    } catch {
      this.updateNavBadge('Facturation', '');
    }
  }
}
