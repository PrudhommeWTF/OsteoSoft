import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ReactiveFormsModule, Validators, FormBuilder } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ConfigService } from '../../core/config.service';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './login.page.html',
  styleUrl: './login.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LoginPage implements OnInit {
  private readonly formBuilder = inject(FormBuilder);
  private readonly api = inject(ApiService);
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

  async ngOnInit(): Promise<void> {
    try {
      const setup = await this.api.getSetupStatus();
      if (setup.requiresSetup) {
        await this.router.navigateByUrl('/installation');
      }
    } catch {
      // If setup status is unavailable, keep default login flow.
    }
  }

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

    await this.router.navigateByUrl('/');
    this.isSubmitting.set(false);
  }
}
