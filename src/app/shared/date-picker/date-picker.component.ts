import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  computed,
  forwardRef,
  inject,
  signal,
} from '@angular/core';
import { ControlValueAccessor, FormControl, NG_VALUE_ACCESSOR, ReactiveFormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { NgbDateStruct } from '@ng-bootstrap/ng-bootstrap';

/** Supported picker modes. */
export type DatePickerMode = 'date' | 'month' | 'year';

/** Internal drill-down view used in date mode. */
type CalendarView = 'days' | 'months' | 'years';

const MONTHS_LONG = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

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

const WEEK_DAYS = ['Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa', 'Di'];

const YEAR_PAGE = 12;

/**
 * Versatile date picker supporting three modes:
 *  - 'date'  (default) – day/month/year; value = ISO date string (YYYY-MM-DD) | null
 *  - 'month'           – month/year;     value = 'YYYY-MM' | null
 *  - 'year'            – year only;      value = 'YYYY'    | null
 *
 * In 'date' mode the panel provides CoreUI-style drill-down navigation:
 * day view → click month/year header → month view → click year → year view.
 *
 * Works as a ControlValueAccessor — use with formControlName or [formControl].
 */
@Component({
  selector: 'app-date-picker',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './date-picker.component.html',
  styleUrl: './date-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
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

  private readonly elRef = inject(ElementRef);

  readonly internalControl = new FormControl<string | null>(null);
  readonly isDisabled = signal(false);
  readonly isPanelOpen = signal(false);
  readonly displayValue = signal('');

  // ── date mode state ────────────────────────────────────────────────────────
  /** Current drill-down view inside the date-mode panel. */
  readonly calendarView = signal<CalendarView>('days');
  /** Year displayed in the day/month calendar header. */
  readonly calendarYear = signal(new Date().getFullYear());
  /** Month displayed in the day calendar header (1-12). */
  readonly calendarMonth = signal(new Date().getMonth() + 1);

  readonly calendarMonthLabel = computed(() => MONTHS_LONG[this.calendarMonth() - 1] ?? '');

  /** 6×7 grid of day numbers (null = empty cell). */
  readonly calendarGrid = computed(() =>
    this.buildCalendarGrid(this.calendarYear(), this.calendarMonth())
  );

  // ── month-mode navigation ──────────────────────────────────────────────────
  readonly panelYear = signal(new Date().getFullYear());

  // ── year-mode navigation ───────────────────────────────────────────────────
  readonly panelYearStart = signal(Math.floor(new Date().getFullYear() / YEAR_PAGE) * YEAR_PAGE);

  readonly visibleYears = computed(() =>
    Array.from({ length: YEAR_PAGE }, (_, i) => this.panelYearStart() + i)
  );

  readonly yearRangeLabel = computed(() => {
    const s = this.panelYearStart();
    return `${s} – ${s + YEAR_PAGE - 1}`;
  });

  readonly months = MONTHS;
  readonly weekDays = WEEK_DAYS;

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
      if (this.mode === 'date') {
        const parts = value.split('-');
        if (parts.length === 3) {
          const y = Number(parts[0]);
          const m = Number(parts[1]);
          if (!isNaN(y) && !isNaN(m)) {
            this.calendarYear.set(y);
            this.calendarMonth.set(m);
          }
        }
      } else if (this.mode === 'month') {
        const y = Number(value.split('-')[0]);
        if (!isNaN(y)) this.panelYear.set(y);
      } else if (this.mode === 'year') {
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

  onBlur(): void {
    this.onTouched();
  }

  // ── panel open / close ─────────────────────────────────────────────────────

  togglePanel(): void {
    if (this.isDisabled()) return;
    const opening = !this.isPanelOpen();
    this.isPanelOpen.set(opening);
    if (opening && this.mode === 'date') {
      this.calendarView.set('days');
    }
    this.onTouched();
  }

  clearValue(): void {
    this.internalControl.setValue(null);
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  // ── date mode: day view ────────────────────────────────────────────────────

  prevCalendarMonth(): void {
    if (this.calendarMonth() === 1) {
      this.calendarYear.update((y) => y - 1);
      this.calendarMonth.set(12);
    } else {
      this.calendarMonth.update((m) => m - 1);
    }
  }

  nextCalendarMonth(): void {
    if (this.calendarMonth() === 12) {
      this.calendarYear.update((y) => y + 1);
      this.calendarMonth.set(1);
    } else {
      this.calendarMonth.update((m) => m + 1);
    }
  }

  selectDay(day: number): void {
    if (this.isDayDisabled(day)) return;
    const y = this.calendarYear();
    const m = this.calendarMonth();
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    this.internalControl.setValue(iso);
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  selectToday(): void {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.internalControl.setValue(iso);
    this.isPanelOpen.set(false);
    this.onTouched();
  }

  isDaySelected(day: number): boolean {
    const val = this.internalControl.value;
    if (!val) return false;
    const parts = val.split('-');
    return (
      Number(parts[0]) === this.calendarYear() &&
      Number(parts[1]) === this.calendarMonth() &&
      Number(parts[2]) === day
    );
  }

  isToday(day: number): boolean {
    const t = new Date();
    return (
      t.getFullYear() === this.calendarYear() &&
      t.getMonth() + 1 === this.calendarMonth() &&
      t.getDate() === day
    );
  }

  isDayDisabled(day: number): boolean {
    const y = this.calendarYear();
    const m = this.calendarMonth();
    if (this.maxDate) {
      if (y > this.maxDate.year) return true;
      if (y === this.maxDate.year && m > this.maxDate.month) return true;
      if (y === this.maxDate.year && m === this.maxDate.month && day > this.maxDate.day) return true;
    }
    if (this.minDate) {
      if (y < this.minDate.year) return true;
      if (y === this.minDate.year && m < this.minDate.month) return true;
      if (y === this.minDate.year && m === this.minDate.month && day < this.minDate.day) return true;
    }
    return false;
  }

  // ── date mode: drill-down navigation ──────────────────────────────────────

  drillDownToMonths(): void {
    this.panelYear.set(this.calendarYear());
    this.calendarView.set('months');
  }

  drillDownToYears(): void {
    this.panelYearStart.set(Math.floor(this.calendarYear() / YEAR_PAGE) * YEAR_PAGE);
    this.calendarView.set('years');
  }

  /** Select month from within date-mode drill-down (returns to day view). */
  selectMonthInDate(month: number): void {
    this.calendarMonth.set(month);
    this.calendarYear.set(this.panelYear());
    this.calendarView.set('days');
  }

  /** Select year from within date-mode drill-down (returns to month view). */
  selectYearInDate(year: number): void {
    this.calendarYear.set(year);
    this.panelYear.set(year);
    this.calendarView.set('months');
  }

  isMonthSelectedInDate(month: number): boolean {
    const val = this.internalControl.value;
    if (!val) return false;
    const parts = val.split('-');
    return Number(parts[0]) === this.panelYear() && Number(parts[1]) === month;
  }

  isYearSelectedInDate(year: number): boolean {
    const val = this.internalControl.value;
    if (!val) return false;
    return Number(val.split('-')[0]) === year;
  }

  isCurrentMonthInDate(month: number): boolean {
    const d = new Date();
    return d.getFullYear() === this.panelYear() && d.getMonth() + 1 === month;
  }

  isCurrentYearInDate(year: number): boolean {
    return new Date().getFullYear() === year;
  }

  // ── month mode ─────────────────────────────────────────────────────────────

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

  // ── calendar grid builder ──────────────────────────────────────────────────

  private buildCalendarGrid(year: number, month: number): (number | null)[][] {
    const daysInMonth = new Date(year, month, 0).getDate();
    // JS getDay(): 0=Sun, 1=Mon … convert to Mon-first (0=Mon … 6=Sun)
    const jsDay = new Date(year, month - 1, 1).getDay();
    const offset = jsDay === 0 ? 6 : jsDay - 1;

    const cells: (number | null)[] = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
      weeks.push(cells.slice(i, i + 7));
    }
    return weeks;
  }

  // ── display value formatter ────────────────────────────────────────────────

  private syncDisplayValue(val: string | null): void {
    if (!val) {
      this.displayValue.set('');
      return;
    }
    if (this.mode === 'date') {
      const parts = val.split('-');
      this.displayValue.set(
        parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : val
      );
    } else if (this.mode === 'month') {
      const [y, m] = val.split('-');
      this.displayValue.set(y && m ? `${m.padStart(2, '0')}/${y}` : val);
    } else if (this.mode === 'year') {
      this.displayValue.set(val);
    }
  }
}
