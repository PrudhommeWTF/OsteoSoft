import { AfterViewInit, Directive, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { Tooltip } from 'bootstrap';

/**
 * Directive Bootstrap 5 tooltip.
 * Applique automatiquement un tooltip Bootstrap sur tout élément possédant
 * un attribut `title`. S'utilise en ajoutant `bsTooltip` sur l'élément :
 *
 *   <button type="button" title="Mon info" bsTooltip>...</button>
 *
 * Le placement peut être contrôlé via `data-bs-placement` sur l'élément HTML.
 * Par défaut le tooltip est placé en haut (`top`).
 */
@Directive({
  selector: '[bsTooltip]',
  standalone: true
})
export class BsTooltipDirective implements AfterViewInit, OnChanges, OnDestroy {
  @Input('bsTooltip') tooltipTitle?: string;
  @Input() placement: 'top' | 'bottom' | 'left' | 'right' = 'top';

  private tooltip: Tooltip | null = null;
  private readonly el: HTMLElement;

  constructor(ref: ElementRef<HTMLElement>) {
    this.el = ref.nativeElement;
  }

  ngAfterViewInit(): void {
    this.init();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tooltipTitle'] && this.tooltip) {
      this.el.setAttribute('title', this.tooltipTitle ?? '');
      this.tooltip.setContent({ '.tooltip-inner': this.tooltipTitle ?? '' });
    }
  }

  ngOnDestroy(): void {
    this.tooltip?.dispose();
    this.tooltip = null;
  }

  private init(): void {
    // Si l'input bsTooltip a une valeur, on l'utilise comme titre
    if (this.tooltipTitle) {
      this.el.setAttribute('data-bs-original-title', this.tooltipTitle);
    }

    const titleAttr = this.el.getAttribute('title') ?? this.el.getAttribute('data-bs-original-title') ?? '';
    if (!titleAttr) {
      return;
    }

    const placementAttr = (this.el.getAttribute('data-bs-placement') as Tooltip.Options['placement']) ?? this.placement;

    // Les boutons disabled ne déclenchent pas les events de souris,
    // on enveloppe via trigger pour garder le tooltip actif même quand disabled
    this.tooltip = new Tooltip(this.el, {
      placement: placementAttr,
      trigger: 'hover focus',
      boundary: 'clippingParents'
    });
  }
}
