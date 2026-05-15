import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild,
  computed,
  forwardRef,
  inject,
  signal,
} from '@angular/core';
import { ControlValueAccessor, FormControl, NG_VALUE_ACCESSOR, ReactiveFormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { NgbDateAdapter, NgbDateParserFormatter, NgbDateStruct, NgbInputDatepicker } from '@ng-bootstrap/ng-bootstrap';

import { NgbDateIsoAdapter } from '../../core/ngb-date-iso-adapter';
import { NgbDateFrParserFormatter } from '../../core/ngb-date-fr-parser-formatter';

/** Supported picker modes. */
export type DatePickerMode = 'date' | 'month' | 'year';

const MONTHS = [
  { value: 1, label: 'Jan' },
  { value: 2, label: 'Fév' },
  { value: 3, label: 'Mar' },
  { value: 4, label: 'Avr' },
  { value: 5, label: 'Mai' },
  { value: 6, label: 'Jun' },
  { value: 7, label: 'Jul' },
  { value: 8, label: 'Aoû' },
  { value: 9, label: 'Sep' },
  { value: 10, label: 'Oct' },
  { value: 11, label: 'Nov' },
  { value: 12, label: 'Déc' },
];

const YEAR_PAGE = 12;

/**
 * Versatile date picker supporting three modes:
 *  - 'date'  (default) – day/month/year; value = ISO date string (YYYY-MM-DD) | null
 *  - 'month'           – month/year;     value = 'YYYY-MM' | null
 *  - 'year'            – year only;      value = 'YYYY'    | null
 *
 * Works as a ControlValueAccessor — use with formControlName or [formControl].
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
  @Input() placeholder?: string;
  @Input() maxDate?: NgbDateStruct;
  @Input() minDate?: NgbDateStruct;
  @Input() autocomplete = 'off';
  @Input() mode: DatePickerMode = 'date';

  @ViewChild('dpRef') dpRef?: NgbInputDatepicker;
  @ViewChild('footerTpl', { static: true }) footerTpl!: TemplateRef<unknown>;

  private readonly elRef = inject(ElementRef);

  readonly internalControl = new FormControl<string | null>(null);
  readonly isDisabled = signal(false);
  readonly isPanelOpen = signal(false);
  readonly displayValue = signal('');

  // Month-mode navigation
  readonly panelYear = signal(new Date().getFullYear());

  // Year-mode navigation
  readonly panelYearStart = signal(Math.floor(new Date().getFullYear() / YEAR_PAGE) * YEAR_PAGE);

  readonly today: NgbDateStruct = (() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  })();

  readonly months = MONTHS;

  readonly visibleYears = computed(() =>
    Array.from({ length: YEAR_PAGE }, (_, i) => this.panelYearStart() + i)
  );

  readonly yearRangeLabel = computed(() => {
    const s = this.panelYearStart();
    return `${s} – ${s + YEAR_PAGE - 1}`;
  });

  get computedPlaceholder(): string {
    if (this.placeholder != null) return this.placeholder;
    if (this.mode === 'month') return 'mm/aaaa';
    if (this.mode === 'year') return 'aaaa';
    return 'jj/mm/aaaa';
  }

  private onChange: (v: string | null) => void = () => {};
  private onTouched: () => void = () => {};
  private sub?: Subscription;

  ngOnInit(): void {
    this.sub = this.internalControl.valueChanges.subscribe((v) => {
      this.onChange(v ?? null);
      this.syncDisplayValue(v ?? null);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  @HostListener('document:click', ['$event.target'])
  onDocumentClick(target: EventTarget | null): void {
    if (!target || !this.elRef.nativeElement.contains(target)) {
      this.isPanelOpen.set(false);
    }
  }

  writeValue(value: string | null): void {
    this.internalControl.setValue(value ?? null, { emitEvent: false });
    this.syncDisplayValue(value ?? null);
    if (value) {
      if (this.mode === 'month') {
        const y = Number(value.split('-')[0]);
        if (!isNaN(y)) this.panelYear.set(y);
      }
      if (this.mode === 'year') {
        const y = Number(value);
        if (!isNaN(y)) this.panelYearStart.set(Math.floor(y / YEAR_PAGE) * YEAR_PAGE);
      }
    }
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

  // ── date mode ─────────────────────────────────────────────────────────────

  selectToday(): void {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.internalControl.setValue(iso);
    this.dpRef?.close();
  }

  clearValue(): void {
    this.internalControl.setValue(null);
    this.dpRef?.close();
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  onBlur(): void {
    this.onTouched();
  }

  // ── month / year panel ────────────────────────────────────────────────────

  togglePanel(): void {
    if (this.isDisabled()) return;
    this.isPanelOpen.update((v) => !v);
    this.onTouched();
  }

  prevYear(): void { this.panelYear.update((y) => y - 1); }
  nextYear(): void { this.panelYear.update((y) => y + 1); }
  prevYearRange(): void { this.panelYearStart.update((s) => s - YEAR_PAGE); }
  nextYearRange(): void { this.panelYearStart.update((s) => s + YEAR_PAGE); }

  selectMonth(month: number): void {
    const iso = `${this.panelYear()}-${String(month).padStart(2, '0')}`;
    this.internalControl.setValue(iso);
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  selectYear(year: number): void {
    this.internalControl.setValue(String(year));
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  selectCurrentMonth(): void {
    const d = new Date();
    this.panelYear.set(d.getFullYear());
    this.selectMonth(d.getMonth() + 1);
  }

  selectCurrentYear(): void {
    this.selectYear(new Date().getFullYear());
  }

  isMonthSelected(month: number): boolean {
    const val = this.internalControl.value;
    if (!val) return false;
    const parts = val.split('-');
    return Number(parts[0]) === this.panelYear() && Number(parts[1]) === month;
  }

  isYearSelected(year: number): boolean {
    return Number(this.internalControl.value) === year;
  }

  isCurrentMonth(month: number): boolean {
    const d = new Date();
    return d.getFullYear() === this.panelYear() && d.getMonth() + 1 === month;
  }

  isCurrentYear(year: number): boolean {
    return new Date().getFullYear() === year;
  }

  private syncDisplayValue(val: string | null): void {
    if (!val) {
      this.displayValue.set('');
      return;
    }
    if (this.mode === 'month') {
      const [y, m] = val.split('-');
      this.displayValue.set(y && m ? `${m.padStart(2, '0')}/${y}` : val);
    } else if (this.mode === 'year') {
      this.displayValue.set(val);
    }
  }
}
