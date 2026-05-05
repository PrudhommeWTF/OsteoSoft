import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ApiService } from '../core/api.service';
import { ChangelogEntry, Patient } from '../core/api.types';
import { AuthService } from '../core/auth.service';
import { ConfigService } from '../core/config.service';
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
};

type UtilityItem = {
  label: string;
  icon: string;
  path?: string;
};

type DependencyCredit = {
  name: string;
  version: string;
  website: string;
  scope: 'runtime' | 'dev';
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
  readonly configService = inject(ConfigService);
  readonly topbar = inject(TopbarService);
  readonly themeService = inject(ThemeService);

  readonly isMenuOpen = signal(false);
  readonly isCreditsModalOpen = signal(false);
  readonly isChangelogModalOpen = signal(false);
  readonly changelogEntries = signal<ChangelogEntry[]>([]);
  readonly username = this.authService.username;
  readonly role = this.authService.role;
  readonly profileLabel = this.authService.profileLabel;
  readonly offices = this.authService.offices;
  readonly activeOfficeId = this.authService.activeOfficeId;
  readonly now = signal(new Date());
  readonly sidebarSearch = signal('');
  readonly sidebarSearchResults = signal<Patient[]>([]);
  readonly isSearchingSidebarPatients = signal(false);
  readonly quickThemeToggleChecked = computed(() => this.themeService.effectiveTheme() === 'dark');

  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private sidebarSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private sidebarSearchRequestId = 0;

  readonly currentDateTime = computed(() =>
    new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(this.now())
  );

  readonly navItems = signal<NavItem[]>([
    { path: '/accueil', label: 'Accueil', icon: 'fa-solid fa-house', exact: true, requiredPermission: 'read-dashboard' },
    { path: '/patients/nouveau', label: 'Nouveau patient', icon: 'fa-solid fa-user-plus', exact: true, requiredPermission: 'create-patient-record' },
    { path: '/agenda', label: 'Agenda', icon: 'fa-solid fa-calendar-days', exact: true, requiredPermission: 'read-agenda' },
    { path: '/patients', label: 'Listing patients', icon: 'fa-solid fa-list-ul', badge: '...', exact: true, requiredPermission: 'read-patient-list' },
    { path: '/repertoire', label: 'Répertoire', icon: 'fa-solid fa-address-book', badge: '...', exact: true, requiredPermission: 'read-directory' },
    { path: '/facturation', label: 'Comptabilité', icon: 'fa-solid fa-file-invoice-dollar', badge: '...', requiredPermission: 'read-billing-kpis' },
    { path: '/statistiques', label: 'Statistiques', icon: 'fa-solid fa-chart-column', requiredPermission: 'read-advanced-statistics' },
    { path: '/administration-cabinet', label: 'Administration cabinet', icon: 'fa-solid fa-building', exact: true, requiredPermission: 'read-office-settings' },
    { path: '/parametres', label: 'Paramètres', icon: 'fa-solid fa-gear', exact: true, adminOnly: true }
  ]);

  readonly visibleNavItems = computed(() => {
    const isAdmin = this.role() === 'admin' || this.authService.isSuperAdmin();

    return this.navItems().filter((item) => {
      if (isAdmin && item.path === '/administration-cabinet') {
        return false;
      }

      if (item.adminOnly && !isAdmin) {
        return false;
      }

      if (!item.requiredPermission) {
        return true;
      }

      return this.authService.hasPermission(item.requiredPermission);
    });
  });

  ngOnInit(): void {
    this.clockTimer = setInterval(() => {
      this.now.set(new Date());
    }, 1000);

    this.api.getChangelog().then((entries) => {
      this.changelogEntries.set(entries);
    }).catch(() => {
      this.changelogEntries.set([]);
    });

    this.api.getPatientCount().then((count) => {
      this.navItems.update((items) =>
        items.map((item) =>
          item.label === 'Listing patients' ? { ...item, badge: String(count) } : item
        )
      );
    }).catch(() => {
      this.navItems.update((items) =>
        items.map((item) =>
          item.label === 'Listing patients' ? { ...item, badge: '?' } : item
        )
      );
    });

    void this.refreshAgendaBadge();

    this.api.getDirectoryContactCount().then((count) => {
      this.navItems.update((items) =>
        items.map((item) =>
          item.label === 'Répertoire' ? { ...item, badge: String(count) } : item
        )
      );
    }).catch(async () => {
      try {
        // Fallback for older API instances not yet exposing /count.
        const payload = await this.api.getDirectoryContacts();
        const count = Number(payload?.contacts?.length ?? 0);
        this.navItems.update((items) =>
          items.map((item) =>
            item.label === 'Répertoire' ? { ...item, badge: String(count) } : item
          )
        );
      } catch {
        this.navItems.update((items) =>
          items.map((item) =>
            item.label === 'Répertoire' ? { ...item, badge: '?' } : item
          )
        );
      }
    });

    void this.refreshBillingBadge();
  }

  ngOnDestroy(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }

    if (this.sidebarSearchDebounceId !== null) {
      clearTimeout(this.sidebarSearchDebounceId);
      this.sidebarSearchDebounceId = null;
    }
  }

  readonly utilityItems = signal<UtilityItem[]>([
    { label: 'Editer mon profil', icon: 'fa-solid fa-user-pen', path: '/mon-profil' },
    { label: 'Afficher l\'aide', icon: 'fa-solid fa-circle-question', path: '/aide' }
  ]);

  readonly dependencyCredits = signal<DependencyCredit[]>([
    { name: '@angular/common', version: '^21.2.0', website: 'https://www.npmjs.com/package/@angular/common', scope: 'runtime' },
    { name: '@angular/compiler', version: '^21.2.0', website: 'https://www.npmjs.com/package/@angular/compiler', scope: 'runtime' },
    { name: '@angular/core', version: '^21.2.0', website: 'https://www.npmjs.com/package/@angular/core', scope: 'runtime' },
    { name: '@angular/forms', version: '^21.2.0', website: 'https://www.npmjs.com/package/@angular/forms', scope: 'runtime' },
    { name: '@angular/platform-browser', version: '^21.2.0', website: 'https://www.npmjs.com/package/@angular/platform-browser', scope: 'runtime' },
    { name: '@angular/router', version: '^21.2.0', website: 'https://www.npmjs.com/package/@angular/router', scope: 'runtime' },
    { name: '@fortawesome/fontawesome-free', version: '^7.2.0', website: 'https://fontawesome.com', scope: 'runtime' },
    { name: 'argon2', version: '^0.44.0', website: 'https://www.npmjs.com/package/argon2', scope: 'runtime' },
    { name: 'better-sqlite3', version: '^12.9.0', website: 'https://www.npmjs.com/package/better-sqlite3', scope: 'runtime' },
    { name: 'bootstrap', version: '^5.3.8', website: 'https://getbootstrap.com', scope: 'runtime' },
    { name: 'bootstrap-datepicker', version: '^1.10.1', website: 'https://www.npmjs.com/package/bootstrap-datepicker', scope: 'runtime' },
    { name: 'chart.js', version: '^4.5.1', website: 'https://www.chartjs.org', scope: 'runtime' },
    { name: 'cookie-parser', version: '^1.4.7', website: 'https://www.npmjs.com/package/cookie-parser', scope: 'runtime' },
    { name: 'cors', version: '^2.8.6', website: 'https://www.npmjs.com/package/cors', scope: 'runtime' },
    { name: 'dotenv', version: '^17.4.2', website: 'https://www.npmjs.com/package/dotenv', scope: 'runtime' },
    { name: 'express', version: '^5.2.1', website: 'https://expressjs.com', scope: 'runtime' },
    { name: 'express-rate-limit', version: '^8.3.2', website: 'https://www.npmjs.com/package/express-rate-limit', scope: 'runtime' },
    { name: 'helmet', version: '^8.1.0', website: 'https://helmetjs.github.io', scope: 'runtime' },
    { name: 'jquery', version: '^3.7.1', website: 'https://jquery.com', scope: 'runtime' },
    { name: 'jsonwebtoken', version: '^9.0.3', website: 'https://www.npmjs.com/package/jsonwebtoken', scope: 'runtime' },
    { name: 'jspdf', version: '^4.2.1', website: 'https://www.npmjs.com/package/jspdf', scope: 'runtime' },
    { name: 'moment', version: '^2.29.4', website: 'https://momentjs.com', scope: 'runtime' },
    { name: 'rxjs', version: '~7.8.0', website: 'https://rxjs.dev', scope: 'runtime' },
    { name: 'tslib', version: '^2.3.0', website: 'https://www.npmjs.com/package/tslib', scope: 'runtime' },
    { name: 'xlsx', version: '^0.18.5', website: 'https://www.npmjs.com/package/xlsx', scope: 'runtime' },
    { name: 'zod', version: '^4.3.6', website: 'https://zod.dev', scope: 'runtime' },
    { name: '@angular/build', version: '^21.2.7', website: 'https://www.npmjs.com/package/@angular/build', scope: 'dev' },
    { name: '@angular/cli', version: '^21.2.7', website: 'https://www.npmjs.com/package/@angular/cli', scope: 'dev' },
    { name: '@angular/compiler-cli', version: '^21.2.0', website: 'https://www.npmjs.com/package/@angular/compiler-cli', scope: 'dev' },
    { name: 'concurrently', version: '^9.2.1', website: 'https://www.npmjs.com/package/concurrently', scope: 'dev' },
    { name: 'prettier', version: '^3.8.1', website: 'https://prettier.io', scope: 'dev' },
    { name: 'typescript', version: '~5.9.2', website: 'https://www.typescriptlang.org', scope: 'dev' }
  ]);

  readonly quickThemeAriaLabel = computed(() => {
    const effective = this.themeService.effectiveTheme();
    const mode = this.themeService.themeMode();
    if (mode === 'system') {
      return `Thème système actif (${effective}). Basculer vers ${effective === 'dark' ? 'clair' : 'sombre'}.`;
    }

    return `Thème ${effective}. Basculer vers ${effective === 'dark' ? 'clair' : 'sombre'}.`;
  });

  toggleMenu(): void {
    this.isMenuOpen.update((value) => !value);
  }

  onActiveOfficeChange(value: string): void {
    const parsed = Number(value);
    const nextOfficeId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    this.authService.setActiveOfficeId(nextOfficeId);
    void this.refreshAgendaBadge();
    void this.refreshBillingBadge();
  }

  closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  openCreditsModal(): void {
    this.isCreditsModalOpen.set(true);
  }

  closeCreditsModal(): void {
    this.isCreditsModalOpen.set(false);
  }

  openChangelogModal(): void {
    this.isChangelogModalOpen.set(true);
  }

  closeChangelogModal(): void {
    this.isChangelogModalOpen.set(false);
  }

  toggleQuickTheme(): void {
    this.themeService.toggleQuickTheme();
  }

  navigateToProfile(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeMenu();
    void this.router.navigate(['/mon-profil']);
  }

  onSidebarSearchChange(value: string): void {
    this.sidebarSearch.set(value);
    const term = value.trim();

    if (this.sidebarSearchDebounceId !== null) {
      clearTimeout(this.sidebarSearchDebounceId);
      this.sidebarSearchDebounceId = null;
    }

    if (term.length < 2) {
      this.sidebarSearchResults.set([]);
      this.isSearchingSidebarPatients.set(false);
      return;
    }

    this.isSearchingSidebarPatients.set(true);
    this.sidebarSearchDebounceId = setTimeout(() => {
      void this.searchSidebarPatients(term);
    }, 220);
  }

  clearSidebarSearchResults(): void {
    this.sidebarSearchResults.set([]);
  }

  async openPatientFromSidebar(patientId: number): Promise<void> {
    this.sidebarSearch.set('');
    this.sidebarSearchResults.set([]);
    this.isSearchingSidebarPatients.set(false);
    await this.router.navigate(['/patients', patientId]);
    this.closeMenu();
  }

  getSidebarPatientSexIcon(sex: Patient['sex']): string {
    if (sex === 'Homme') {
      return 'fa-solid fa-mars';
    }

    if (sex === 'Femme') {
      return 'fa-solid fa-venus';
    }

    return 'fa-solid fa-user';
  }

  getSidebarPatientSexClass(sex: Patient['sex']): string {
    if (sex === 'Homme') {
      return 'sex-male';
    }

    if (sex === 'Femme') {
      return 'sex-female';
    }

    return 'sex-unknown';
  }

  formatSidebarPatientName(fullName: string): string {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length <= 1) {
      return fullName;
    }

    const [lastName, ...firstNameParts] = parts;
    return `${lastName.toUpperCase()} ${firstNameParts.join(' ')}`;
  }

  formatSidebarPatientConsultationCount(value: number): string {
    return value <= 1 ? `${value} consultation` : `${value} consultations`;
  }

  formatSidebarPatientAge(age: number | null): string {
    if (age === null || age < 0) {
      return 'Âge non renseigné';
    }

    return `${age} ans`;
  }

  private async searchSidebarPatients(term: string): Promise<void> {
    const requestId = ++this.sidebarSearchRequestId;

    try {
      const patients = await this.api.getPatients(term);
      if (requestId !== this.sidebarSearchRequestId) {
        return;
      }

      this.sidebarSearchResults.set(patients.slice(0, 8));
    } catch {
      if (requestId === this.sidebarSearchRequestId) {
        this.sidebarSearchResults.set([]);
      }
    } finally {
      if (requestId === this.sidebarSearchRequestId) {
        this.isSearchingSidebarPatients.set(false);
      }
    }
  }

  async logout(): Promise<void> {
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }

  private async refreshBillingBadge(): Promise<void> {
    try {
      const revenue = await this.api.getBillingMonthlyRevenue(this.activeOfficeId());
      const roundedAmount = Math.round(Number(revenue.amountCents ?? 0) / 100);
      this.navItems.update((items) =>
        items.map((item) =>
          item.label === 'Comptabilité' ? { ...item, badge: String(roundedAmount) } : item
        )
      );
    } catch {
      this.navItems.update((items) =>
        items.map((item) =>
          item.label === 'Comptabilité' ? { ...item, badge: '?' } : item
        )
      );
    }
  }

  private async refreshAgendaBadge(): Promise<void> {
    try {
      const payload = await this.api.getAppointments(this.activeOfficeId());
      const value = Number(payload?.stats?.consultationsToday ?? 0);
      const safeValue = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
      this.navItems.update((items) =>
        items.map((item) =>
          item.label === 'Agenda' ? { ...item, badge: String(safeValue) } : item
        )
      );
    } catch {
      this.navItems.update((items) =>
        items.map((item) =>
          item.label === 'Agenda' ? { ...item, badge: '?' } : item
        )
      );
    }
  }
}
