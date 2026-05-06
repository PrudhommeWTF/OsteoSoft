import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild,
  forwardRef,
  signal,
} from '@angular/core';
import { ControlValueAccessor, FormControl, NG_VALUE_ACCESSOR, ReactiveFormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { NgbDateAdapter, NgbDateParserFormatter, NgbDateStruct, NgbInputDatepicker } from '@ng-bootstrap/ng-bootstrap';

import { NgbDateIsoAdapter } from '../../core/ngb-date-iso-adapter';
import { NgbDateFrParserFormatter } from '../../core/ngb-date-fr-parser-formatter';

/**
 * CoreUI-style date picker component.
 *
 * Works as a ControlValueAccessor — use with formControlName or [formControl].
 * The form control value is an ISO date string (YYYY-MM-DD) or null.
 * The input displays dates in French format (dd/mm/yyyy).
 */
@Component({
  selector: 'app-date-picker',
  standalone: true,
  imports: [ReactiveFormsModule, NgbInputDatepicker],
  templateUrl: './date-picker.component.html',
  styleUrl: './date-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NgbDateAdapter, useClass: NgbDateIsoAdapter },
    { provide: NgbDateParserFormatter, useClass: NgbDateFrParserFormatter },
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => DatePickerComponent),
      multi: true,
    },
  ],
})
export class DatePickerComponent implements ControlValueAccessor, OnInit, OnDestroy {
  @Input() id?: string;
  @Input() placeholder = 'jj/mm/aaaa';
  @Input() maxDate?: NgbDateStruct;
  @Input() minDate?: NgbDateStruct;
  @Input() autocomplete = 'off';

  @ViewChild('dpRef') dpRef!: NgbInputDatepicker;
  @ViewChild('footerTpl', { static: true }) footerTpl!: TemplateRef<unknown>;

  readonly internalControl = new FormControl<string | null>(null);
  readonly isDisabled = signal(false);

  readonly today: NgbDateStruct = (() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  })();

  private onChange: (v: string | null) => void = () => {};
  private onTouched: () => void = () => {};
  private sub?: Subscription;

  ngOnInit(): void {
    this.sub = this.internalControl.valueChanges.subscribe((v) => {
      this.onChange(v ?? null);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  writeValue(value: string | null): void {
    this.internalControl.setValue(value ?? null, { emitEvent: false });
  }

  registerOnChange(fn: (v: string | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
    if (isDisabled) {
      this.internalControl.disable({ emitEvent: false });
    } else {
      this.internalControl.enable({ emitEvent: false });
    }
  }

  selectToday(): void {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.internalControl.setValue(iso);
    this.dpRef?.close();
  }

  clearValue(): void {
    this.internalControl.setValue(null);
    this.dpRef?.close();
  }

  onBlur(): void {
    this.onTouched();
  }
}
