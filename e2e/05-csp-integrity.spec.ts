import { test, expect } from '@playwright/test';

// Parcours 5 : integrite CSP / feuille de style du frontend servi par l'API.
//
// Regression garde-fou du bug "page blanche" en deploiement mono-service :
// - l'inlining de CSS critique (Beasties) injectait un gestionnaire inline
//   onload="this.media='all'" que la CSP (script-src 'self') bloquait, laissant
//   la feuille de style principale en media="print" (application non stylee) ;
// - des polices tierces (Google Fonts) etaient chargees, bloquees par la CSP et
//   contraires a la regle "aucun appel tiers".
//
// Ce scenario charge l'application reelle servie par l'API (avec sa CSP helmet)
// et verifie qu'aucune violation CSP ne survient et que la feuille de style
// s'applique bien a l'ecran.

test('le frontend se charge sans violation CSP et avec ses styles', async ({ page }) => {
  const cspViolations: string[] = [];
  const failedCss: string[] = [];

  page.on('console', (msg) => {
    const t = msg.text();
    if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(t);
  });
  page.on('response', (r) => {
    if (r.url().endsWith('.css') && !r.ok()) failedCss.push(`${r.status()} ${r.url()}`);
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // La feuille de style principale doit etre active pour l'ecran (media != print).
  const mainCssMedia = await page.evaluate(() => {
    const link = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .find((l) => (l as HTMLLinkElement).href.includes('styles-')) as HTMLLinkElement | undefined;
    return link ? link.media : 'ABSENT';
  });

  // Bootstrap doit etre charge et applique : la variable --bs-primary est definie.
  const bsPrimary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim()
  );

  expect(cspViolations, cspViolations.join(' || ')).toHaveLength(0);
  expect(failedCss, failedCss.join(' || ')).toHaveLength(0);
  expect(mainCssMedia === '' || mainCssMedia === 'all').toBeTruthy();
  expect(bsPrimary.length).toBeGreaterThan(0);
});
