import { Injectable } from '@angular/core';
import DOMPurify from 'dompurify';

/**
 * Sanitizes untrusted HTML before it is written to element.innerHTML.
 * Uses DOMPurify to remove scripts and event handlers while keeping
 * safe formatting tags produced by the rich-text consultation editors.
 */
@Injectable({ providedIn: 'root' })
export class HtmlSanitizerService {
  private readonly allowedTags = [
    'p', 'br', 'b', 'i', 'u', 'em', 'strong',
    'ul', 'ol', 'li', 'span', 'div', 's', 'sub', 'sup'
  ];

  private readonly allowedAttr = ['style', 'class'];

  sanitize(html: string): string {
    return DOMPurify.sanitize(html ?? '', {
      ALLOWED_TAGS: this.allowedTags,
      ALLOWED_ATTR: this.allowedAttr
    });
  }
}
