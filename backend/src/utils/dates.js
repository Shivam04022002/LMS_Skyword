'use strict';

/**
 * Calendar-safe date helpers for schedule generation.
 *
 * Dates are handled as plain `YYYY-MM-DD` strings and integer year/month/day
 * parts, never as millisecond offsets: adding "a month" by adding 30 x 86400000
 * drifts, because months are 28-31 days long. Day arithmetic goes through
 * Date.UTC, which has no daylight-saving discontinuities.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value) {
  if (value instanceof Date) {
    return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
  }

  const match = DATE_PATTERN.exec(String(value).slice(0, 10));
  if (!match) {
    throw new TypeError(`"${value}" is not a YYYY-MM-DD date`);
  }

  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Length of a month, honouring leap years. */
function daysInMonth(year, month) {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1];
}

/** Adds whole days. Safe across month and year boundaries. */
function addDays(value, days) {
  const { year, month, day } = parseDate(value);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  });
}

/**
 * Adds whole calendar months, clamping to the last valid day of the target
 * month rather than overflowing into the next one.
 *
 *   2026-01-31 +1 month -> 2026-02-28   (not 2026-03-03)
 *   2028-01-31 +1 month -> 2028-02-29   (leap year)
 *   2026-01-31 +3 months -> 2026-04-30
 *
 * Always call this against the original anchor date, not the previous clamped
 * result: anchoring keeps 2026-01-31 producing 02-28, 03-31, 04-30 rather than
 * collapsing to the 28th for the rest of the schedule.
 */
function addMonths(value, months) {
  const { year, month, day } = parseDate(value);

  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12 + 1;

  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));

  return formatDate({ year: targetYear, month: targetMonth, day: clampedDay });
}

/** Day of the week, 0 = Sunday … 6 = Saturday. UTC, so no DST edge cases. */
function dayOfWeek(value) {
  const { year, month, day } = parseDate(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const SUNDAY = 0;

const isSunday = (value) => dayOfWeek(value) === SUNDAY;

/**
 * Day offsets from `startDate` that are actually charged.
 *
 * A daily loan's instalments fall on the `days` calendar days *after* the start
 * date, i.e. offsets 1..days. With `skipSundays`, the Sundays inside that same
 * window are dropped rather than pushed: the term stays `days` calendar days
 * long and simply contains fewer instalments —
 *
 *   30 calendar days containing 4 Sundays -> 26 chargeable days.
 *
 * The window is never extended to make up the skipped days, so the loan still
 * ends on the date the borrower agreed to.
 */
function chargeableDayOffsets(startDate, days, { skipSundays = false } = {}) {
  const total = Number(days);
  if (!Number.isInteger(total) || total < 1) {
    throw new RangeError('A day count of at least 1 is required');
  }

  const offsets = [];
  for (let offset = 1; offset <= total; offset += 1) {
    if (skipSundays && isSunday(addDays(startDate, offset))) continue;
    offsets.push(offset);
  }
  return offsets;
}

/**
 * The first `count` chargeable day offsets from `startDate`.
 *
 * Where `chargeableDayOffsets` fills a window and reports how many days it
 * held, this fills a COUNT and reports which days those are: a skipped Sunday
 * pushes the run one day further out rather than reducing the number of
 * collections. `maxOffset` bounds the search to a contractual window, so a
 * count that cannot fit is refused rather than quietly extending the term.
 */
function chargeableOffsetsForCount(startDate, count, { skipSundays = false, maxOffset = null } = {}) {
  const wanted = Number(count);
  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new RangeError('A collection-day count of at least 1 is required');
  }

  const offsets = [];
  const limit = maxOffset === null ? Infinity : Number(maxOffset);

  for (let offset = 1; offsets.length < wanted && offset <= limit; offset += 1) {
    if (skipSundays && isSunday(addDays(startDate, offset))) continue;
    offsets.push(offset);
  }

  return offsets.length === wanted ? offsets : null;
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
function differenceInDays(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  const start = Date.UTC(a.year, a.month - 1, a.day);
  const end = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((end - start) / 86400000);
}

/** Today in UTC as YYYY-MM-DD. Injectable everywhere so tests stay deterministic. */
function today(clock = new Date()) {
  return formatDate({
    year: clock.getUTCFullYear(),
    month: clock.getUTCMonth() + 1,
    day: clock.getUTCDate()
  });
}

const compareDates = (a, b) => differenceInDays(a, b);

module.exports = {
  parseDate,
  formatDate,
  isLeapYear,
  daysInMonth,
  addDays,
  addMonths,
  dayOfWeek,
  isSunday,
  chargeableDayOffsets,
  chargeableOffsetsForCount,
  differenceInDays,
  compareDates,
  today
};
