import {
  ChangeDetectionStrategy,
  Component,
  Input,
  computed,
  forwardRef,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

/** Supported picker modes. */
export type DatePickerMode = 'date' | 'month' | 'year' | 'datetime' | 'flexible';

/** Replaces NgbDateStruct — same shape, no ng-bootstrap dependency. */
export interface DateBound {
  year: number;
  month: number;
  day: number;
}

/** A cell in the day grid. */
interface DayCell {
  day: number;
  month: number;
  year: number;
  isOtherMonth: boolean;
}

const MONTHS = [
  { value: 1,  label: 'Jan' },
  { value: 2,  label: 'Fév' },
  { value: 3,  label: 'Mar' },
  { value: 4,  label: 'Avr' },
  { value: 5,  label: 'Mai' },
  { value: 6,  label: 'Jun' },
  { value: 7,  label: 'Jul' },
  { value: 8,  label: 'Aoû' },
  { value: 9,  label: 'Sep' },
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
 * Versatile date picker supporting five modes:
 *  - 'date'     – day/month/year;  value = 'YYYY-MM-DD'     | null
 *  - 'month'    – month/year;      value = 'YYYY-MM'         | null
 *  - 'year'     – year only;       value = 'YYYY'            | null
 *  - 'datetime' – day + time;      value = 'YYYY-MM-DDTHH:mm'| null
 *  - 'flexible' – year/month/day;  value depends on granularity
 *
 * Works as a ControlValueAccessor — use with formControlName or [formControl].
 */
@Component({
  selector: 'app-date-picker',
  standalone: true,
  imports: [],
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
export class DatePickerComponent implements ControlValueAccessor {
  @Input() id?: string;
  @Input() placeholder?: string;
  @Input() maxDate?: DateBound;
  @Input() minDate?: DateBound;
  @Input() mode: DatePickerMode = 'date';
  @Input() timeStep = 5;

  // ── Constants exposed to template ──────────────────────────────────────────
  readonly months = MONTHS;
  readonly monthsLong = MONTHS_LONG;

  readonly today: DateBound = (() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  })();

  readonly hourOptions = Array.from({ length: 24 }, (_, i) => i);
  readonly minuteOptions = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  // ── CVA state ──────────────────────────────────────────────────────────────
  readonly isDisabled  = signal(false);
  readonly isPanelOpen = signal(false);
  readonly displayValue = signal('');

  // ── Panel navigation ───────────────────────────────────────────────────────
  readonly panelYear      = signal(new Date().getFullYear());
  readonly panelMonth     = signal(new Date().getMonth() + 1);
  readonly panelYearStart = signal(Math.floor(new Date().getFullYear() / YEAR_PAGE) * YEAR_PAGE);

  // ── Flexible mode: active tab ──────────────────────────────────────────────
  readonly flexGran = signal<'year' | 'month' | 'day'>('day');

  // ── Pending selection (before Valider) ────────────────────────────────────
  readonly pendingY    = signal<number | null>(null);
  readonly pendingM    = signal<number | null>(null);
  readonly pendingD    = signal<number | null>(null);
  readonly pendingHour = signal(8);
  readonly pendingMin  = signal(0);

  // ── Computed ───────────────────────────────────────────────────────────────
  readonly visibleYears = computed(() =>
    Array.from({ length: YEAR_PAGE }, (_, i) => this.panelYearStart() + i)
  );

  readonly yearRangeLabel = computed(() =>
    `${this.panelYearStart()} – ${this.panelYearStart() + YEAR_PAGE - 1}`
  );

  readonly panelLabel = computed(() => {
    const gran = this.effectiveGran();
    if (gran === 'day')   return `${MONTHS_LONG[this.panelMonth() - 1]} ${this.panelYear()}`;
    if (gran === 'month') return `${this.panelYear()}`;
    return this.yearRangeLabel();
  });

  readonly panelDays = computed((): DayCell[] => {
    const year  = this.panelYear();
    const month = this.panelMonth();

    const firstDate   = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();

    // Convert getDay() (0=Sun…6=Sat) to Monday-first offset (0=Mon…6=Sun)
    let startOffset = firstDate.getDay() - 1;
    if (startOffset < 0) startOffset = 6;

    const cells: DayCell[] = [];

    // Leading cells from previous month
    const prevMonthDays = new Date(year, month - 1, 0).getDate();
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    for (let i = startOffset - 1; i >= 0; i--) {
      cells.push({ day: prevMonthDays - i, month: prevMonth, year: prevYear, isOtherMonth: true });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, month, year, isOtherMonth: false });
    }

    // Trailing cells from next month
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    const totalCells = Math.ceil(cells.length / 7) * 7;
    let d = 1;
    while (cells.length < totalCells) {
      cells.push({ day: d++, month: nextMonth, year: nextYear, isOtherMonth: true });
    }

    return cells;
  });

  /** Computed signals for template grid visibility */
  readonly showingDayGrid = computed(() => {
    const gran = this.effectiveGran();
    return gran === 'day';
  });

  readonly showingMonthGrid = computed(() => {
    const gran = this.effectiveGran();
    return gran === 'month';
  });

  readonly showingYearGrid = computed(() => {
    const gran = this.effectiveGran();
    return gran === 'year';
  });

  // ── Private CVA callbacks ──────────────────────────────────────────────────
  private _value: string | null = null;
  private onChange: (v: string | null) => void = () => {};
  private onTouched: () => void = () => {};

  // ── Placeholder ────────────────────────────────────────────────────────────
  get computedPlaceholder(): string {
    if (this.placeholder != null) return this.placeholder;
    if (this.mode === 'month')    return 'mm/aaaa';
    if (this.mode === 'year')     return 'aaaa';
    if (this.mode === 'datetime') return 'jj/mm/aaaa hh:mm';
    if (this.mode === 'flexible') return 'jj/mm/aaaa, mm/aaaa ou aaaa';
    return 'jj/mm/aaaa';
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  private effectiveGran(): 'day' | 'month' | 'year' {
    if (this.mode === 'year')  return 'year';
    if (this.mode === 'month') return 'month';
    if (this.mode === 'flexible') return this.flexGran();
    // 'date' and 'datetime' always show day grid
    return 'day';
  }

  // ── Panel open/close ────────────────────────────────────────────────────────
  openPanel(): void {
    if (this.isDisabled()) return;

    const val = this._value;

    // Initialise pending state from current value
    if (val) {
      if (this.mode === 'datetime') {
        const tIdx = val.indexOf('T');
        const datePart = tIdx >= 0 ? val.substring(0, tIdx) : val;
        const timePart = tIdx >= 0 ? val.substring(tIdx + 1, tIdx + 6) : '';
        const parts = datePart.split('-');
        this.pendingY.set(Number(parts[0]) || null);
        this.pendingM.set(Number(parts[1]) || null);
        this.pendingD.set(Number(parts[2]) || null);
        if (timePart) {
          const [h, m] = timePart.split(':');
          this.pendingHour.set(Number(h) || 0);
          this.pendingMin.set(Number(m) || 0);
        }
        if (this.pendingY() && this.pendingM()) {
          this.panelYear.set(this.pendingY()!);
          this.panelMonth.set(this.pendingM()!);
        }
      } else if (this.mode === 'flexible') {
        this._syncFlexFromValue(val);
        this._syncPendingFromValue(val);
      } else {
        this._syncPendingFromValue(val);
      }
    } else {
      // Reset pending
      const now = new Date();
      this.pendingY.set(null);
      this.pendingM.set(null);
      this.pendingD.set(null);
      this.pendingHour.set(8);
      this.pendingMin.set(0);
      // Reset panel to current month/year
      this.panelYear.set(now.getFullYear());
      this.panelMonth.set(now.getMonth() + 1);
      this.panelYearStart.set(Math.floor(now.getFullYear() / YEAR_PAGE) * YEAR_PAGE);
      if (this.mode === 'flexible') {
        this.flexGran.set('day');
      }
    }

    this.isPanelOpen.set(true);
    this.onTouched();
  }

  cancelSelection(): void {
    this.isPanelOpen.set(false);
  }

  confirmSelection(): void {
    let value: string | null = null;

    if (this.mode === 'date') {
      if (this.pendingY() && this.pendingM() && this.pendingD()) {
        value = `${this.pendingY()}-${this.pad(this.pendingM()!)}-${this.pad(this.pendingD()!)}`;
      }
    } else if (this.mode === 'datetime') {
      if (this.pendingY() && this.pendingM() && this.pendingD()) {
        value = `${this.pendingY()}-${this.pad(this.pendingM()!)}-${this.pad(this.pendingD()!)}T${this.pad(this.pendingHour())}:${this.pad(this.pendingMin())}`;
      }
    } else if (this.mode === 'flexible') {
      const gran = this.flexGran();
      if (gran === 'year' && this.pendingY()) {
        value = `${this.pendingY()}`;
      } else if (gran === 'month' && this.pendingY() && this.pendingM()) {
        value = `${this.pendingY()}-${this.pad(this.pendingM()!)}`;
      } else if (gran === 'day' && this.pendingY() && this.pendingM() && this.pendingD()) {
        value = `${this.pendingY()}-${this.pad(this.pendingM()!)}-${this.pad(this.pendingD()!)}`;
      }
    } else if (this.mode === 'month') {
      if (this.pendingY() && this.pendingM()) {
        value = `${this.pendingY()}-${this.pad(this.pendingM()!)}`;
      }
    } else if (this.mode === 'year') {
      if (this.pendingY()) {
        value = `${this.pendingY()}`;
      }
    }

    if (value) {
      this._value = value;
      this.onChange(value);
      this.syncDisplayValue(value);
    }

    this.isPanelOpen.set(false);
  }

  // ── Day grid actions ───────────────────────────────────────────────────────
  selectDay(cell: DayCell): void {
    if (cell.isOtherMonth) {
      this.panelYear.set(cell.year);
      this.panelMonth.set(cell.month);
      return;
    }
    if (this.isDayDisabled(cell)) return;
    this.pendingY.set(cell.year);
    this.pendingM.set(cell.month);
    this.pendingD.set(cell.day);
  }

  // ── Month grid actions ─────────────────────────────────────────────────────
  selectMonth(month: number): void {
    if (this.isMonthDisabled(month)) return;
    this.pendingM.set(month);
    this.pendingY.set(this.panelYear());

    if (this.mode === 'flexible') {
      this.flexGran.set('day');
      this.panelMonth.set(month);
    } else if (this.mode === 'month') {
      this.confirmSelection();
    }
  }

  // ── Year grid actions ──────────────────────────────────────────────────────
  selectYear(year: number): void {
    if (this.isYearDisabled(year)) return;
    this.pendingY.set(year);
    this.panelYear.set(year);

    if (this.mode === 'flexible') {
      this.flexGran.set('month');
    } else if (this.mode === 'year') {
      this.confirmSelection();
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  prevPanel(): void {
    const gran = this.effectiveGran();
    if (gran === 'day') {
      const m = this.panelMonth();
      if (m === 1) {
        this.panelMonth.set(12);
        this.panelYear.update(y => y - 1);
      } else {
        this.panelMonth.update(m => m - 1);
      }
    } else if (gran === 'month') {
      this.panelYear.update(y => y - 1);
    } else if (gran === 'year') {
      this.panelYearStart.update(s => s - YEAR_PAGE);
    }
  }

  nextPanel(): void {
    const gran = this.effectiveGran();
    if (gran === 'day') {
      const m = this.panelMonth();
      if (m === 12) {
        this.panelMonth.set(1);
        this.panelYear.update(y => y + 1);
      } else {
        this.panelMonth.update(m => m + 1);
      }
    } else if (gran === 'month') {
      this.panelYear.update(y => y + 1);
    } else if (gran === 'year') {
      this.panelYearStart.update(s => s + YEAR_PAGE);
    }
  }

  // ── Selection state helpers ────────────────────────────────────────────────
  isDaySelected(cell: DayCell): boolean {
    return (
      this.pendingY() === cell.year &&
      this.pendingM() === cell.month &&
      this.pendingD() === cell.day
    );
  }

  isMonthSelected(month: number): boolean {
    return this.pendingY() === this.panelYear() && this.pendingM() === month;
  }

  isYearSelected(year: number): boolean {
    return this.pendingY() === year;
  }

  isToday(cell: DayCell): boolean {
    const t = this.today;
    return cell.year === t.year && cell.month === t.month && cell.day === t.day;
  }

  isCurrentMonth(month: number): boolean {
    const d = new Date();
    return d.getFullYear() === this.panelYear() && d.getMonth() + 1 === month;
  }

  isCurrentYear(year: number): boolean {
    return new Date().getFullYear() === year;
  }

  isDayDisabled(cell: DayCell): boolean {
    const max = this.maxDate;
    const min = this.minDate;
    if (max) {
      if (cell.year > max.year) return true;
      if (cell.year === max.year && cell.month > max.month) return true;
      if (cell.year === max.year && cell.month === max.month && cell.day > max.day) return true;
    }
    if (min) {
      if (cell.year < min.year) return true;
      if (cell.year === min.year && cell.month < min.month) return true;
      if (cell.year === min.year && cell.month === min.month && cell.day < min.day) return true;
    }
    return false;
  }

  isMonthDisabled(month: number): boolean {
    const year = this.panelYear();
    const max = this.maxDate;
    const min = this.minDate;
    if (max) {
      if (year > max.year) return true;
      if (year === max.year && month > max.month) return true;
    }
    if (min) {
      if (year < min.year) return true;
      if (year === min.year && month < min.month) return true;
    }
    return false;
  }

  isYearDisabled(year: number): boolean {
    const max = this.maxDate;
    const min = this.minDate;
    if (max && year > max.year) return true;
    if (min && year < min.year) return true;
    return false;
  }

  // ── ControlValueAccessor ───────────────────────────────────────────────────
  writeValue(value: string | null): void {
    this._value = value ?? null;
    this.syncDisplayValue(value ?? null);

    if (value) {
      if (this.mode === 'flexible') {
        this._syncFlexFromValue(value);
      }
      this._syncPanelFromValue(value);
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
    if (isDisabled) this.isPanelOpen.set(false);
  }

  // ── Private helpers ────────────────────────────────────────────────────────
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
    } else if (this.mode === 'datetime') {
      const tIdx = val.indexOf('T');
      if (tIdx >= 0) {
        const datePart = val.substring(0, tIdx);
        const timePart = val.substring(tIdx + 1, tIdx + 6);
        const [y, m, d] = datePart.split('-');
        this.displayValue.set(
          y && m && d
            ? `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y} ${timePart}`
            : val
        );
      } else {
        const [y, m, d] = val.split('-');
        this.displayValue.set(y && m && d ? `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}` : val);
      }
    } else if (this.mode === 'flexible') {
      const parts = val.split('-');
      if (parts.length === 1 && parts[0].length === 4) {
        this.displayValue.set(val);
      } else if (parts.length === 2) {
        this.displayValue.set(`${parts[1].padStart(2, '0')}/${parts[0]}`);
      } else if (parts.length === 3) {
        this.displayValue.set(
          `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`
        );
      }
    } else {
      // mode === 'date'
      const [y, m, d] = val.split('-');
      this.displayValue.set(y && m && d ? `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}` : val);
    }
  }

  /** Sync flexGran + panelYearStart from an existing value string. */
  private _syncFlexFromValue(val: string): void {
    const parts = val.split('-');
    if (parts.length === 1 && parts[0].length === 4) {
      const y = Number(parts[0]);
      if (!isNaN(y)) {
        this.panelYear.set(y);
        this.panelYearStart.set(Math.floor(y / YEAR_PAGE) * YEAR_PAGE);
        this.flexGran.set('year');
      }
    } else if (parts.length === 2) {
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      if (!isNaN(y) && !isNaN(m)) {
        this.panelYear.set(y);
        this.panelMonth.set(m);
        this.panelYearStart.set(Math.floor(y / YEAR_PAGE) * YEAR_PAGE);
        this.flexGran.set('month');
      }
    } else if (parts.length === 3) {
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      if (!isNaN(y) && !isNaN(m)) {
        this.panelYear.set(y);
        this.panelMonth.set(m);
        this.flexGran.set('day');
      }
    }
  }

  /** Initialise pendingY/M/D from a stored value string. */
  private _syncPendingFromValue(val: string): void {
    if (!val) return;
    const tIdx = val.indexOf('T');
    const datePart = tIdx >= 0 ? val.substring(0, tIdx) : val;
    const parts = datePart.split('-');

    if (parts[0]) this.pendingY.set(Number(parts[0]) || null);
    if (parts[1]) this.pendingM.set(Number(parts[1]) || null);
    if (parts[2]) this.pendingD.set(Number(parts[2]) || null);

    if (tIdx >= 0) {
      const timePart = val.substring(tIdx + 1, tIdx + 6);
      const [h, m] = timePart.split(':');
      this.pendingHour.set(Number(h) || 0);
      this.pendingMin.set(Number(m) || 0);
    }
  }

  /** Sync panel navigation signals from a stored value. */
  private _syncPanelFromValue(val: string): void {
    const tIdx = val.indexOf('T');
    const datePart = tIdx >= 0 ? val.substring(0, tIdx) : val;
    const parts = datePart.split('-');

    if (parts[0]) {
      const y = Number(parts[0]);
      if (!isNaN(y)) {
        this.panelYear.set(y);
        this.panelYearStart.set(Math.floor(y / YEAR_PAGE) * YEAR_PAGE);
      }
    }
    if (parts[1]) {
      const m = Number(parts[1]);
      if (!isNaN(m)) this.panelMonth.set(m);
    }
  }
}
