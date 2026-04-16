import { Routes } from '@angular/router';

import { adminGuard, authGuard, guestGuard, permissionGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login.page').then((m) => m.LoginPage)
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell.page').then((m) => m.ShellPage),
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: 'accueil'
      },
      {
        path: 'accueil',
        loadComponent: () => import('./features/pages/home.page').then((m) => m.HomePage)
      },
      {
        path: 'agenda',
        loadComponent: () => import('./features/pages/agenda.page').then((m) => m.AgendaPage)
      },
      {
        path: 'repertoire',
        canActivate: [permissionGuard('read-directory')],
        loadComponent: () => import('./features/pages/directory.page').then((m) => m.DirectoryPage)
      },
      {
        path: 'mon-profil',
        loadComponent: () => import('./features/pages/profile.page').then((m) => m.ProfilePage)
      },
      {
        path: 'patients/nouveau',
        loadComponent: () => import('./features/pages/patient-create.page').then((m) => m.PatientCreatePage)
      },
      {
        path: 'patients/:id',
        loadComponent: () => import('./features/pages/patient-detail.page').then((m) => m.PatientDetailPage)
      },
      {
        path: 'patients',
        loadComponent: () => import('./features/pages/patients.page').then((m) => m.PatientsPage)
      },
      {
        path: 'facturation',
        loadComponent: () => import('./features/pages/billing.page').then((m) => m.BillingPage)
      },
      {
        path: 'parametres',
        canActivate: [adminGuard],
        loadComponent: () => import('./features/pages/settings.page').then((m) => m.SettingsPage)
      }
    ]
  },
  {
    path: '**',
    redirectTo: ''
  }
];
