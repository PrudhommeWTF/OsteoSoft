import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, Validators, FormBuilder } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { ConfigService } from '../../core/config.service';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule],
  templateUrl: './login.page.html',
  styleUrl: './login.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LoginPage {
  private readonly formBuilder = inject(FormBuilder);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  readonly configService = inject(ConfigService);

  readonly isSubmitting = signal(false);
  readonly errorMessage = signal('');

  readonly form = this.formBuilder.nonNullable.group({
    username: ['admin', [Validators.required]],
    password: ['admin', [Validators.required]],
    remember: [true]
  });

  async submit(): Promise<void> {
    if (this.form.invalid || this.isSubmitting()) {
      this.form.markAllAsTouched();
      return;
    }

    this.isSubmitting.set(true);
    this.errorMessage.set('');

    const value = this.form.getRawValue();
    const result = await this.authService.login(value.username, value.password, value.remember);

    if (result !== 'success') {
      this.errorMessage.set(
        result === 'invalid-credentials'
          ? 'Identifiants invalides. Utilise admin / admin.'
          : 'API indisponible. Demarre le backend avec npm run start:api ou npm run start:full.'
      );
      this.isSubmitting.set(false);
      return;
    }

    if (this.authService.mustChangePassword()) {
      await this.router.navigateByUrl('/mon-profil');
    } else {
      await this.router.navigateByUrl('/');
    }
    this.isSubmitting.set(false);
  }
}
