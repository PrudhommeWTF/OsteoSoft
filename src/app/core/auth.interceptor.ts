import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

const SAFE_METHODS_CSRF = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE_NAME = 'os_csrf';

function getCsrfToken(): string {
  const match = document.cookie.match(new RegExp('(?:^|; )' + CSRF_COOKIE_NAME + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);

  let clonedReq = req.clone({ withCredentials: true });

  if (!SAFE_METHODS_CSRF.has(req.method.toUpperCase())) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      clonedReq = clonedReq.clone({ setHeaders: { 'X-CSRF-Token': csrfToken } });
    }
  }

  return next(clonedReq).pipe(
    catchError((error) => {
      if (error?.status === 401) {
        void router.navigate(['/login']);
      }
      return throwError(() => error);
    })
  );
};
