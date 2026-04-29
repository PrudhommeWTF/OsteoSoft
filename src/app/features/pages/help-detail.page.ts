import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { HELP_GUIDES } from './help-content';

@Component({
  selector: 'app-help-detail-page',
  imports: [NgOptimizedImage, RouterLink],
  template: `
    @if (guide(); as currentGuide) {
      <section class="help-detail-hero card mb-3 border-0 shadow-sm">
        <div class="card-body p-4 p-lg-5">
          <a class="btn btn-sm btn-outline-secondary mb-3" routerLink="/aide">
            <i class="fa-solid fa-arrow-left me-2"></i>Retour a l index de l aide
          </a>

          <p class="help-detail-eyebrow mb-2">Aide detaillee</p>
          <h1 class="h3 mb-2">{{ currentGuide.title }}</h1>
          <p class="text-secondary mb-0">{{ currentGuide.summary }}</p>
        </div>
      </section>

      <article class="card border-0 shadow-sm mb-3 overflow-hidden">
        <img
          class="detail-screenshot"
          [ngSrc]="currentGuide.screenshot"
          [alt]="'Capture d ecran - ' + currentGuide.title"
          width="2880"
          height="1800"
          priority
        />
      </article>

      <section class="d-grid gap-3">
        @for (action of currentGuide.actions; track action.title; let actionIndex = $index) {
          <article class="card border-0 shadow-sm">
            <div class="card-body p-4">
              <h2 class="h5 mb-3">Action {{ actionIndex + 1 }}: {{ action.title }}</h2>

              <div class="help-columns">
                <section>
                  <h3 class="h6 text-secondary mb-2">Manipulations</h3>
                  <ul class="help-list mb-0">
                    @for (step of action.manipulations; track step) {
                      <li>{{ step }}</li>
                    }
                  </ul>
                </section>

                <section>
                  <h3 class="h6 text-secondary mb-2">Cas d usage</h3>
                  <ul class="help-list mb-0">
                    @for (usage of action.useCases; track usage) {
                      <li>{{ usage }}</li>
                    }
                  </ul>
                </section>
              </div>
            </div>
          </article>
        }
      </section>
    } @else {
      <section class="card border-0 shadow-sm">
        <div class="card-body p-4">
          <h1 class="h4 mb-2">Ecran d aide introuvable</h1>
          <p class="text-secondary mb-3">
            L ecran demande n existe pas dans la documentation actuelle.
          </p>
          <a class="btn btn-outline-primary btn-sm" routerLink="/aide">Retour a l index de l aide</a>
        </div>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .help-detail-hero {
        background:
          radial-gradient(circle at top right, rgba(41, 128, 185, 0.12), transparent 46%),
          radial-gradient(circle at bottom left, rgba(39, 174, 96, 0.12), transparent 42%),
          var(--bs-body-bg);
      }

      .help-detail-eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.75rem;
        color: var(--bs-primary);
        font-weight: 700;
      }

      .detail-screenshot {
        display: block;
        width: 100%;
        height: auto;
      }

      .help-columns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 1rem;
      }

      .help-list {
        padding-left: 1.2rem;
        display: grid;
        gap: 0.45rem;
      }

      .help-list li {
        color: var(--bs-secondary-color);
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HelpDetailPage {
  private readonly route = inject(ActivatedRoute);

  readonly guide = computed(() => {
    const slug = this.route.snapshot.paramMap.get('slug');
    return HELP_GUIDES.find((entry) => entry.slug === slug) ?? null;
  });
}
