import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { filter } from 'rxjs';

import { ConfigService } from './core/config.service';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private readonly titleService = inject(Title);
  private readonly configService = inject(ConfigService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.themeService.init();

    // Update title when config is loaded
    effect(() => {
      const config = this.configService.config();
      if (config) {
        const baseTitle = `${config.app_name} v${config.version}`;
        this.titleService.setTitle(baseTitle);
      }
    });

    // Update title on route changes
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const config = this.configService.config();
        if (config) {
          const baseTitle = `${config.app_name} v${config.version}`;
          this.titleService.setTitle(baseTitle);
        }
      });
  }
}
