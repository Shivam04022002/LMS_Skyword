/**
 * Integer-paise helpers for form arithmetic.
 *
 * Convenience only — these exist so the allocation form can compare totals
 * without floating-point drift while the user types. The backend re-validates
 * every amount with its own decimal-safe implementation and remains the sole
 * authority; nothing here is ever trusted server-side.
 */

/** "1234.50" -> 123450. Returns null for anything that is not a plain decimal. */
export function toMinorUnits(value) {
  if (value === null || value === undefined || value === '') return null;

  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** 123450 -> "1234.50" */
export function fromMinorUnits(minor) {
  const negative = minor < 0;
  const absolute = Math.abs(Math.round(minor));
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}
