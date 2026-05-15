import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { DatePickerComponent } from '../date-picker/date-picker.component';

export interface DateRangeValue {
  from: string;
  to: string;
}

type DateRangePreset =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'last-month'
  | 'quarter'
  | 'year'
  | 'last-year';

const PRESETS: { id: DateRangePreset; label: string }[] = [
  { id: 'today', label: "Aujourd'hui" },
  { id: 'yesterday', label: 'Hier' },
  { id: 'week', label: 'Cette semaine' },
  { id: 'month', label: 'Ce mois-ci' },
  { id: 'last-month', label: 'Mois dernier' },
  { id: 'quarter', label: 'Ce trimestre' },
  { id: 'year', label: 'Cette année' },
  { id: 'last-year', label: 'Année dernière' },
];

/**
 * Date range picker wrapping two DatePickerComponent instances.
 *
 * Expose `[from]` / `[to]` inputs (ISO date strings) and a `(rangeChange)`
 * output that fires `DateRangeValue` whenever either date or a preset changes.
 */
@Component({
  selector: 'app-date-range-picker',
  standalone: true,
  imports: [ReactiveFormsModule, DatePickerComponent],
  templateUrl: './date-range-picker.component.html',
  styleUrl: './date-range-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DateRangePickerComponent implements OnInit, OnChanges, OnDestroy {
  @Input() from = '';
  @Input() to = '';
  @Output() readonly rangeChange = new EventEmitter<DateRangeValue>();

  readonly fromCtrl = new FormControl<string | null>(null);
  readonly toCtrl = new FormControl<string | null>(null);
  readonly presets = PRESETS;

  private readonly subs: Subscription[] = [];
  private emitting = false;

  ngOnInit(): void {
    this.subs.push(
      this.fromCtrl.valueChanges.subscribe((v) => {
        if (!this.emitting) {
          this.rangeChange.emit({ from: v ?? '', to: this.toCtrl.value ?? '' });
        }
      }),
      this.toCtrl.valueChanges.subscribe((v) => {
        if (!this.emitting) {
          this.rangeChange.emit({ from: this.fromCtrl.value ?? '', to: v ?? '' });
        }
      }),
    );
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['from']) {
      const v = this.from || null;
      if (this.fromCtrl.value !== v) {
        this.fromCtrl.setValue(v, { emitEvent: false });
      }
    }
    if (changes['to']) {
      const v = this.to || null;
      if (this.toCtrl.value !== v) {
        this.toCtrl.setValue(v, { emitEvent: false });
      }
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  applyPreset(preset: DateRangePreset): void {
    const now = new Date();
    let fromDate: Date;
    let toDate: Date;

    switch (preset) {
      case 'today': {
        fromDate = toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      }
      case 'yesterday': {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        fromDate = toDate = d;
        break;
      }
      case 'week': {
        const dow = now.getDay() === 0 ? 6 : now.getDay() - 1;
        fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
        toDate = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + 6);
        break;
      }
      case 'month': {
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
        toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        break;
      }
      case 'last-month': {
        fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        toDate = new Date(now.getFullYear(), now.getMonth(), 0);
        break;
      }
      case 'quarter': {
        const q = Math.floor(now.getMonth() / 3);
        fromDate = new Date(now.getFullYear(), q * 3, 1);
        toDate = new Date(now.getFullYear(), q * 3 + 3, 0);
        break;
      }
      case 'year': {
        fromDate = new Date(now.getFullYear(), 0, 1);
        toDate = new Date(now.getFullYear(), 11, 31);
        break;
      }
      case 'last-year': {
        fromDate = new Date(now.getFullYear() - 1, 0, 1);
        toDate = new Date(now.getFullYear() - 1, 11, 31);
        break;
      }
      default:
        return;
    }

    const fromIso = this.toIsoDate(fromDate);
    const toIso = this.toIsoDate(toDate);

    this.emitting = true;
    this.fromCtrl.setValue(fromIso, { emitEvent: false });
    this.toCtrl.setValue(toIso, { emitEvent: false });
    this.emitting = false;

    this.rangeChange.emit({ from: fromIso, to: toIso });
  }

  private toIsoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
