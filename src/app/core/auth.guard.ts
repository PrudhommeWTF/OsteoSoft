import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';
import { SetupService } from './setup.service';

export const setupRequiredGuard: CanActivateFn = () => {
  const setupService = inject(SetupService);
  const router = inject(Router);

  return setupService.requiresSetup() ? true : router.createUrlTree(['/login']);
};

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const setupService = inject(SetupService);
  const router = inject(Router);

  if (setupService.requiresSetup()) {
    return router.createUrlTree(['/installation']);
  }

  return authService
    .ensureSessionChecked()
    .then((isAuthenticated) => (isAuthenticated ? true : router.createUrlTree(['/login'])));
};

export const guestGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const setupService = inject(SetupService);
  const router = inject(Router);

  if (setupService.requiresSetup()) {
    return router.createUrlTree(['/installation']);
  }

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

    return authService.role() === 'admin' || authService.isSuperAdmin()
      ? true
      : router.createUrlTree(['/accueil']);
  });
};

export const permissionGuard = (permissionId: string): CanActivateFn => {
  return () => {
    const authService = inject(AuthService);
    const router = inject(Router);

    return authService.ensureSessionChecked().then((isAuthenticated) => {
      if (!isAuthenticated) {
        return router.createUrlTree(['/login']);
      }

      if (authService.hasPermission(permissionId)) {
        return true;
      }

      return router.createUrlTree(['/accueil']);
    });
  };
};
