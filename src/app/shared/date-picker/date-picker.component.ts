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
export type DatePickerMode = 'date' | 'month' | 'year' | 'datetime' | 'flexible';

/** A cell in the flexible day grid. */
interface DayCell {
  day: number;
  month: number;
  year: number;
  isOtherMonth: boolean;
}

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

const MONTHS_LONG = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
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
  @Input() timeStep: number = 15;

  @ViewChild('dpRef') dpRef?: NgbInputDatepicker;
  @ViewChild('footerTpl', { static: true }) footerTpl!: TemplateRef<unknown>;

  private readonly elRef = inject(ElementRef);

  readonly internalControl = new FormControl<string | null>(null);
  readonly isDisabled = signal(false);
  readonly isPanelOpen = signal(false);
  readonly displayValue = signal('');
  readonly timeValue = signal<string>('');

  // Month-mode navigation
  readonly panelYear = signal(new Date().getFullYear());

  // Year-mode navigation
  readonly panelYearStart = signal(Math.floor(new Date().getFullYear() / YEAR_PAGE) * YEAR_PAGE);

  // Flexible-mode drill-down state
  readonly flexLevel = signal<'years' | 'months' | 'days'>('years');
  readonly flexYear = signal(new Date().getFullYear());
  readonly flexMonth = signal(new Date().getMonth() + 1);

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

  readonly timeSlots = computed(() => {
    const slots: string[] = [];
    const step = Math.max(1, Math.min(60, this.timeStep));
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += step) {
        slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      }
    }
    return slots;
  });

  /** Human-readable label for the month shown in the flex days view. */
  readonly flexMonthLabel = computed(() =>
    `${MONTHS_LONG[this.flexMonth() - 1]} ${this.flexYear()}`
  );

  /** Short month label used in the "Confirmer" button of the days view. */
  readonly flexMonthShortLabel = computed(() => {
    const m = this.months.find((x) => x.value === this.flexMonth());
    return `${m?.label ?? ''} ${this.flexYear()}`;
  });

  /** Day grid cells for the flexible days view (6×7 max, Monday first). */
  readonly flexDays = computed((): DayCell[] => {
    const year = this.flexYear();
    const month = this.flexMonth();

    const firstDate = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();

    // Convert getDay() (0=Sun…6=Sat) to Monday-first offset (0=Mon…6=Sun)
    let startOffset = firstDate.getDay() - 1;
    if (startOffset < 0) startOffset = 6;

    const cells: DayCell[] = [];

    // Leading cells from previous month
    const prevMonthDays = new Date(year, month - 1, 0).getDate();
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    for (let i = startOffset - 1; i >= 0; i--) {
      cells.push({ day: prevMonthDays - i, month: prevMonth, year: prevYear, isOtherMonth: true });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, month, year, isOtherMonth: false });
    }

    // Trailing cells from next month
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const totalCells = Math.ceil(cells.length / 7) * 7;
    let d = 1;
    while (cells.length < totalCells) {
      cells.push({ day: d++, month: nextMonth, year: nextYear, isOtherMonth: true });
    }

    return cells;
  });

  get computedPlaceholder(): string {
    if (this.placeholder != null) return this.placeholder;
    if (this.mode === 'month') return 'mm/aaaa';
    if (this.mode === 'year') return 'aaaa';
    if (this.mode === 'flexible') return 'jj/mm/aaaa, mm/aaaa ou aaaa';
    return 'jj/mm/aaaa';
  }

  private onChange: (v: string | null) => void = () => {};
  private onTouched: () => void = () => {};
  private sub?: Subscription;

  ngOnInit(): void {
    this.sub = this.internalControl.valueChanges.subscribe((v) => {
      if (this.mode === 'datetime') {
        this.emitDateTimeValue();
        return;
      }
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
    if (this.mode === 'datetime' && value) {
      const tIdx = value.indexOf('T');
      const datePart = tIdx >= 0 ? value.substring(0, tIdx) : value;
      const timePart = tIdx >= 0 ? value.substring(tIdx + 1, tIdx + 6) : '';
      this.internalControl.setValue(datePart || null, { emitEvent: false });
      this.timeValue.set(timePart);
      return;
    }
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
      if (this.mode === 'flexible') {
        this.syncFlexStateFromValue(value);
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

  // ── datetime mode ──────────────────────────────────────────────────────────

  setTime(time: string): void {
    this.timeValue.set(time);
    this.emitDateTimeValue();
    this.onTouched();
  }

  setNow(): void {
    const now = new Date();
    const step = Math.max(1, Math.min(60, this.timeStep));
    const roundedMinutes = Math.floor(now.getMinutes() / step) * step;
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}:${String(roundedMinutes).padStart(2, '0')}`;
    this.internalControl.setValue(datePart, { emitEvent: false });
    this.timeValue.set(timePart);
    this.emitDateTimeValue();
    this.onTouched();
  }

  clearDateTimeValue(): void {
    this.internalControl.setValue(null, { emitEvent: false });
    this.timeValue.set('');
    this.onChange(null);
    this.dpRef?.close();
    this.onTouched();
  }

  private emitDateTimeValue(): void {
    const date = this.internalControl.value;
    const time = this.timeValue();
    if (date && time) {
      this.onChange(`${date}T${time}`);
    } else {
      this.onChange(null);
    }
  }

  // ── month / year panel ────────────────────────────────────────────────────

  togglePanel(): void {
    if (this.isDisabled()) return;
    if (!this.isPanelOpen() && this.mode === 'flexible') {
      // Restore panel level from current value when opening
      const val = this.internalControl.value;
      if (!val) {
        this.flexLevel.set('years');
        this.panelYearStart.set(Math.floor(new Date().getFullYear() / YEAR_PAGE) * YEAR_PAGE);
      } else {
        this.syncFlexStateFromValue(val);
      }
    }
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

  // ── flexible mode (drill-down: years → months → days) ─────────────────────

  /** Navigate from year grid to month grid for the clicked year. */
  flexSelectYear(year: number): void {
    if (this.isFlexYearDisabled(year)) return;
    this.flexYear.set(year);
    this.flexLevel.set('months');
  }

  /** Confirm selection at year precision and close panel. */
  flexConfirmYear(): void {
    const iso = String(this.flexYear());
    this.internalControl.setValue(iso);
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  /** Navigate from month grid to day grid for the clicked month. */
  flexSelectMonth(month: number): void {
    if (this.isFlexMonthDisabled(month)) return;
    this.flexMonth.set(month);
    this.flexLevel.set('days');
  }

  /** Confirm selection at month precision and close panel. */
  flexConfirmMonth(): void {
    const iso = `${this.flexYear()}-${String(this.flexMonth()).padStart(2, '0')}`;
    this.internalControl.setValue(iso);
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  /** Select a specific day and close panel. Other-month cells navigate to that month. */
  flexSelectDay(cell: DayCell): void {
    if (cell.isOtherMonth) {
      this.flexYear.set(cell.year);
      this.flexMonth.set(cell.month);
      return;
    }
    if (this.isFlexDayDisabled(cell)) return;
    const iso = `${cell.year}-${String(cell.month).padStart(2, '0')}-${String(cell.day).padStart(2, '0')}`;
    this.internalControl.setValue(iso);
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  flexBackToYears(): void { this.flexLevel.set('years'); }
  flexBackToMonths(): void { this.flexLevel.set('months'); }

  flexPrevYear(): void { this.flexYear.update((y) => y - 1); }
  flexNextYear(): void {
    const next = this.flexYear() + 1;
    if (!this.maxDate || next <= this.maxDate.year) this.flexYear.set(next);
  }

  flexPrevMonth(): void {
    const month = this.flexMonth();
    const year = this.flexYear();
    if (month === 1) {
      this.flexMonth.set(12);
      this.flexYear.set(year - 1);
    } else {
      this.flexMonth.set(month - 1);
    }
  }

  flexNextMonth(): void {
    const month = this.flexMonth();
    const year = this.flexYear();
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    if (!this.maxDate || nextYear < this.maxDate.year ||
        (nextYear === this.maxDate.year && nextMonth <= this.maxDate.month)) {
      this.flexMonth.set(nextMonth);
      this.flexYear.set(nextYear);
    }
  }

  isFlexYearDisabled(year: number): boolean {
    return !!this.maxDate && year > this.maxDate.year;
  }

  isFlexMonthDisabled(month: number): boolean {
    if (!this.maxDate) return false;
    const y = this.flexYear();
    return y > this.maxDate.year ||
           (y === this.maxDate.year && month > this.maxDate.month);
  }

  isFlexDayDisabled(cell: DayCell): boolean {
    if (!this.maxDate) return false;
    const max = this.maxDate;
    if (cell.year > max.year) return true;
    if (cell.year === max.year && cell.month > max.month) return true;
    if (cell.year === max.year && cell.month === max.month && cell.day > max.day) return true;
    return false;
  }

  isFlexYearSelected(year: number): boolean {
    const val = this.internalControl.value;
    if (!val) return false;
    return Number(val.split('-')[0]) === year;
  }

  isFlexMonthSelected(month: number): boolean {
    const val = this.internalControl.value;
    if (!val) return false;
    const parts = val.split('-');
    return Number(parts[0]) === this.flexYear() && Number(parts[1]) === month;
  }

  isFlexDaySelected(cell: DayCell): boolean {
    const val = this.internalControl.value;
    if (!val || val.length !== 10) return false;
    const parts = val.split('-');
    return Number(parts[0]) === cell.year && Number(parts[1]) === cell.month && Number(parts[2]) === cell.day;
  }

  isFlexToday(cell: DayCell): boolean {
    const t = this.today;
    return cell.year === t.year && cell.month === t.month && cell.day === t.day;
  }

  isFlexCurrentYear(year: number): boolean {
    return new Date().getFullYear() === year;
  }

  isFlexCurrentMonth(month: number): boolean {
    const d = new Date();
    return d.getFullYear() === this.flexYear() && d.getMonth() + 1 === month;
  }

  private syncFlexStateFromValue(val: string): void {
    const parts = val.split('-');
    if (parts.length === 1 && parts[0].length === 4) {
      const y = Number(parts[0]);
      if (!isNaN(y)) {
        this.flexYear.set(y);
        this.panelYearStart.set(Math.floor(y / YEAR_PAGE) * YEAR_PAGE);
        this.flexLevel.set('years');
      }
    } else if (parts.length === 2) {
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      if (!isNaN(y) && !isNaN(m)) {
        this.flexYear.set(y);
        this.flexMonth.set(m);
        this.panelYearStart.set(Math.floor(y / YEAR_PAGE) * YEAR_PAGE);
        this.flexLevel.set('months');
      }
    } else if (parts.length === 3) {
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      if (!isNaN(y) && !isNaN(m)) {
        this.flexYear.set(y);
        this.flexMonth.set(m);
        this.flexLevel.set('days');
      }
    }
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
    } else if (this.mode === 'flexible') {
      const parts = val.split('-');
      if (parts.length === 1 && parts[0].length === 4) {
        this.displayValue.set(val);
      } else if (parts.length === 2) {
        this.displayValue.set(`${parts[1].padStart(2, '0')}/${parts[0]}`);
      } else if (parts.length === 3) {
        this.displayValue.set(`${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`);
      }
    }
  }
}
