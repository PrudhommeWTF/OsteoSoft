import { Routes } from '@angular/router';

import { adminGuard, authGuard, guestGuard, permissionGuard, setupRequiredGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'installation',
    canActivate: [setupRequiredGuard],
    loadComponent: () => import('./features/setup/installation.page').then((m) => m.InstallationPage)
  },
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
        title: 'Accueil',
        loadComponent: () => import('./features/pages/home.page').then((m) => m.HomePage)
      },
      {
        path: 'agenda',
        title: 'Agenda',
        loadComponent: () => import('./features/pages/agenda.page').then((m) => m.AgendaPage)
      },
      {
        path: 'repertoire',
        title: 'Répertoire',
        canActivate: [permissionGuard('read-directory')],
        loadComponent: () => import('./features/pages/directory.page').then((m) => m.DirectoryPage)
      },
      {
        path: 'mon-profil',
        title: 'Mon profil',
        loadComponent: () => import('./features/pages/profile.page').then((m) => m.ProfilePage)
      },
      {
        path: 'patients/nouveau',
        title: 'Nouveau patient',
        loadComponent: () => import('./features/pages/patient-create.page').then((m) => m.PatientCreatePage)
      },
      {
        path: 'patients/:id',
        title: 'Fiche patient',
        loadComponent: () => import('./features/pages/patient-detail.page').then((m) => m.PatientDetailPage)
      },
      {
        path: 'patients',
        title: 'Patients',
        loadComponent: () => import('./features/pages/patients.page').then((m) => m.PatientsPage)
      },
      {
        path: 'facturation',
        title: 'Facturation',
        loadComponent: () => import('./features/pages/billing.page').then((m) => m.BillingPage)
      },
      {
        path: 'statistiques',
        title: 'Statistiques',
        canActivate: [permissionGuard('read-advanced-statistics')],
        loadComponent: () => import('./features/pages/statistiques.page').then((m) => m.StatistiquesPage)
      },
      {
        path: 'parametres',
        title: 'Paramètres',
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
