import { formatCurrency } from '../../utils/loanConstants';

/*
 * Chart primitives, hand-rolled in SVG.
 *
 * The project has no charting dependency and this deliberately does not add
 * one: bar, line and pie are a few dozen lines of SVG each, they inherit the
 * application's own Bootstrap styling, and they add nothing to a bundle that is
 * already past the size warning. Everything here is pure — no DOM, no state —
 * so the chart components stay readable.
 */

/**
 * A categorical palette that stays distinguishable in order and does not rely on
 * colour alone: every series is also labelled in the legend and named in the
 * tooltip, so a reader who cannot separate two hues still gets the figure.
 */
export const SERIES_COLORS = [
  '#0d6efd', // primary
  '#198754', // success
  '#fd7e14', // orange
  '#6f42c1', // purple
  '#dc3545', // danger
  '#20c997', // teal
  '#6c757d', // secondary
  '#d63384' // pink
];

export const colorFor = (index) => SERIES_COLORS[index % SERIES_COLORS.length];

/**
 * Compact Indian notation for an axis tick, where the full figure would not fit.
 *
 * Crore / lakh / thousand, the groupings the rest of the application already
 * formats to. A tooltip always shows the exact amount, so this only ever
 * abbreviates a label, never a value anyone reads a number off.
 */
export function compactInr(value) {
  const amount = Number(value ?? 0);
  const sign = amount < 0 ? '-' : '';
  const absolute = Math.abs(amount);

  if (absolute >= 10000000) return `${sign}₹${(absolute / 10000000).toFixed(absolute >= 100000000 ? 0 : 1)}Cr`;
  if (absolute >= 100000) return `${sign}₹${(absolute / 100000).toFixed(absolute >= 1000000 ? 0 : 1)}L`;
  if (absolute >= 1000) return `${sign}₹${(absolute / 1000).toFixed(absolute >= 10000 ? 0 : 1)}K`;
  return `${sign}₹${absolute.toFixed(0)}`;
}

/** The exact amount, in the application's own INR format. */
export const exactInr = (value) => formatCurrency(value ?? 0);

/**
 * A "nice" upper bound and the ticks below it.
 *
 * Rounds the maximum up to 1, 2 or 5 times a power of ten so the gridlines land
 * on readable numbers instead of on the data's own maximum.
 */
export function niceScale(maxValue, tickCount = 4) {
  const max = Number(maxValue) || 0;
  if (max <= 0) return { max: 1, ticks: [0, 1] };

  const rough = max / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude;
  const top = Math.ceil(max / step) * step;

  const ticks = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return { max: top, ticks };
}

/**
 * Which x labels to draw when there are more than will fit.
 *
 * Keeps every nth label so the first and last are always among them — a reader
 * can anchor the axis at both ends even on a crowded daily series.
 */
export function thinLabels(count, maxLabels = 12) {
  if (count <= maxLabels) return (index) => true;
  const every = Math.ceil(count / maxLabels);
  return (index) => index % every === 0 || index === count - 1;
}

/** A bucket date as a short axis label: "01 Oct" , or "Oct 2026" for a month bucket. */
export function shortLabel(label, bucket) {
  if (!label) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(label));
  if (!match) return String(label);

  const [, year, month, day] = match;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = MONTHS[Number(month) - 1] ?? month;

  if (bucket === 'month') return `${monthName} ${year}`;
  if (bucket === 'week') return `w/c ${day} ${monthName}`;
  return `${day} ${monthName}`;
}

/**
 * The series a chart will draw.
 *
 * A chart the backend gave `seriesKeys` draws one line or bar group per key; one
 * without draws a single series off `amount`. Either way the keys come from the
 * server's own description of the chart, so the page never guesses at a field.
 */
export function seriesOf(chart) {
  if (chart?.seriesKeys?.length) return chart.seriesKeys;
  return [{ key: 'amount', label: chart?.title ?? 'Amount' }];
}

/** True when every point of every series is zero or missing — an empty dataset. */
export function isEmptyChart(chart) {
  const points = chart?.points ?? [];
  if (points.length === 0) return true;

  return points.every((point) =>
    seriesOf(chart).every((series) => Number(point[series.key] ?? 0) === 0) && !Number(point.count ?? 0)
  );
}
