import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);

  return next(req.clone({ withCredentials: true })).pipe(
    catchError((error) => {
      if (error?.status === 401) {
        void router.navigate(['/login']);
      }
      return throwError(() => error);
    })
  );
};
