/**
 * Sanitizes a cell value before writing it to an Excel/CSV export.
 * Prefixes values starting with =, +, -, or @ with a single quote to prevent
 * formula injection (CSV injection) when the file is opened in a spreadsheet application.
 */
export function sanitizeCellValue(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  if (/^[=+\-@]/.test(str)) {
    return `'${str}`;
  }
  return str;
}
