import { Injectable } from '@angular/core';
import { NgbDateParserFormatter, NgbDateStruct } from '@ng-bootstrap/ng-bootstrap';

/**
 * Date parser/formatter that uses the French date format (dd/mm/yyyy)
 * for display inside NgbInputDatepicker inputs.
 */
@Injectable()
export class NgbDateFrParserFormatter extends NgbDateParserFormatter {
  parse(value: string): NgbDateStruct | null {
    if (!value) {
      return null;
    }
    const parts = value.trim().split('/');
    if (parts.length !== 3) {
      return null;
    }
    const day = Number(parts[0]);
    const month = Number(parts[1]);
    const year = Number(parts[2]);
    if (!day || !month || !year) {
      return null;
    }
    return { day, month, year };
  }

  format(date: NgbDateStruct | null): string {
    if (!date) {
      return '';
    }
    return `${String(date.day).padStart(2, '0')}/${String(date.month).padStart(2, '0')}/${date.year}`;
  }
}
