import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { HELP_GUIDES } from './help-content';

@Component({
  selector: 'app-help-index-page',
  imports: [NgOptimizedImage, RouterLink],
  template: `
    <section class="help-hero card mb-3 border-0 shadow-sm">
      <div class="card-body p-4 p-lg-5">
        <p class="help-eyebrow mb-2">Centre d aide</p>
        <h1 class="h3 mb-2">Aide par ecran</h1>
        <p class="text-secondary mb-0">
          Selectionnez un ecran pour ouvrir une page d aide dediee avec les manipulations et cas d usage.
        </p>
      </div>
    </section>

    <section class="help-grid" aria-label="Liste des ecrans de l application">
      @for (screen of screens; track screen.slug) {
        <article class="help-card card border-0 shadow-sm">
          <div class="help-card-image">
            <img
              [ngSrc]="screen.screenshot"
              [alt]="'Capture d ecran - ' + screen.title"
              width="2880"
              height="1800"
              priority
            />
          </div>

          <div class="card-body p-4">
            <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
              <h2 class="h5 mb-0">{{ screen.title }}</h2>
              <span class="badge rounded-pill text-bg-light border route-chip">{{ screen.appRoute }}</span>
            </div>

            <p class="text-secondary mb-3">{{ screen.summary }}</p>
            <a class="btn btn-outline-primary btn-sm" [routerLink]="['/aide', screen.slug]">Voir la page dediee</a>
          </div>
        </article>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .help-hero {
        background:
          radial-gradient(circle at top right, rgba(41, 128, 185, 0.12), transparent 46%),
          radial-gradient(circle at bottom left, rgba(39, 174, 96, 0.12), transparent 42%),
          var(--bs-body-bg);
      }

      .help-eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.75rem;
        color: var(--bs-primary);
        font-weight: 700;
      }

      .help-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 1rem;
      }

      .help-card {
        overflow: hidden;
        border-radius: 1rem;
        display: flex;
        flex-direction: column;
      }

      .help-card-image {
        background: #e9eef4;
        border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      }

      .help-card-image img {
        display: block;
        width: 100%;
        height: auto;
        object-fit: cover;
      }

      .route-chip {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-weight: 600;
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HelpIndexPage {
  readonly screens = HELP_GUIDES;
}
