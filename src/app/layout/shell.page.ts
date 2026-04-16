import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ConfigService } from '../core/config.service';
import { TopbarService } from '../core/topbar.service';

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

@Component({
  selector: 'app-shell-page',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
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

  readonly isMenuOpen = signal(false);
  readonly username = this.authService.username;
  readonly role = this.authService.role;
  readonly now = signal(new Date());

  private clockTimer: ReturnType<typeof setInterval> | null = null;

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
    { path: '/agenda', label: 'Agenda', icon: 'fa-solid fa-calendar-days', badge: '9', exact: true, requiredPermission: 'read-agenda' },
    { path: '/patients', label: 'Listing patients', icon: 'fa-solid fa-list-ul', badge: '...', exact: true, requiredPermission: 'read-patient-list' },
    { label: 'Repertoire', icon: 'fa-solid fa-address-book', badge: '5', disabled: true, requiredPermission: 'read-directory' },
    { path: '/facturation', label: 'Comptabilite', icon: 'fa-solid fa-file-invoice-dollar', badge: '414', requiredPermission: 'read-billing-kpis' },
    { label: 'Statistiques', icon: 'fa-solid fa-chart-column', disabled: true, requiredPermission: 'read-advanced-statistics' },
    { path: '/parametres', label: 'Parametres', icon: 'fa-solid fa-gear', exact: true, adminOnly: true }
  ]);

  readonly visibleNavItems = computed(() => {
    const isAdmin = this.role() === 'admin';

    return this.navItems().filter((item) => {
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
  }

  ngOnDestroy(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  readonly utilityItems = signal<UtilityItem[]>([
    { label: 'Editer mon profil', icon: 'fa-solid fa-user-pen', path: '/mon-profil' }
  ]);

  toggleMenu(): void {
    this.isMenuOpen.update((value) => !value);
  }

  closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  async logout(): Promise<void> {
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }
}
