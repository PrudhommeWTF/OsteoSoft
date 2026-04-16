import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService
    .ensureSessionChecked()
    .then((isAuthenticated) => (isAuthenticated ? true : router.createUrlTree(['/login'])));
};

export const guestGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService
    .ensureSessionChecked()
    .then((isAuthenticated) => (isAuthenticated ? router.createUrlTree(['/']) : true));
};

export const adminGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.ensureSessionChecked().then((isAuthenticated) => {
    if (!isAuthenticated) {
      return router.createUrlTree(['/login']);
    }

    return authService.role() === 'admin' ? true : router.createUrlTree(['/accueil']);
  });
};
