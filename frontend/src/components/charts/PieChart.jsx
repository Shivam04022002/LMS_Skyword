import { useState } from 'react';
import { colorFor, exactInr } from './chartUtils';

/*
 * A donut chart, in SVG, for a category breakdown of one measure.
 *
 * Only offered where a share of a whole is a meaningful reading — statuses,
 * types, payment modes. It is never offered for a date series, because a pie of
 * consecutive periods says nothing about the trend between them, and never for
 * two measures that are not parts of one total (demand and collections, or
 * assessed and collected bounce), because adding them to a whole would assert a
 * relationship that does not exist.
 *
 * Every slice is also listed beside the chart with its exact figure and share, so
 * a slice too thin to see is still readable, and colour is never the only channel.
 */

const SIZE = 220;
const RADIUS = 98;
const INNER = 68;
const CENTRE = SIZE / 2;

/** A point on the circle, at `angle` turns clockwise from twelve o'clock. */
function pointAt(angle, radius) {
  const radians = (angle - 0.25) * 2 * Math.PI;
  return { x: CENTRE + radius * Math.cos(radians), y: CENTRE + radius * Math.sin(radians) };
}

/** The donut segment from `start` to `end`, as turns of the circle. */
function arcPath(start, end) {
  // A single arc cannot describe a full circle, so a sole slice is drawn as two.
  if (end - start >= 1) {
    return [arcPath(0, 0.5), arcPath(0.5, 1)].join(' ');
  }
  const outerStart = pointAt(start, RADIUS);
  const outerEnd = pointAt(end, RADIUS);
  const innerEnd = pointAt(end, INNER);
  const innerStart = pointAt(start, INNER);
  const large = end - start > 0.5 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${RADIUS} ${RADIUS} 0 ${large} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${INNER} ${INNER} 0 ${large} 0 ${innerStart.x} ${innerStart.y}`,
    'Z'
  ].join(' ');
}

export default function PieChart({ chart, valueKind = 'money' }) {
  const [hover, setHover] = useState(null);

  // A negative share is not drawable, and a zero slice is listed rather than
  // drawn so the legend still accounts for the category.
  const points = (chart.points ?? []).map((point) => ({
    ...point,
    value: Math.max(0, Number(point[valueKind === 'count' ? 'count' : 'amount'] ?? 0))
  }));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const format = (value) => (valueKind === 'count' ? String(value) : exactInr(value));

  if (total === 0) {
    return (
      <p className="text-secondary small mb-0">
        Every category in this period is zero, so there is no share to divide.
      </p>
    );
  }

  let cursor = 0;
  const slices = points.map((point, index) => {
    const share = point.value / total;
    const slice = { ...point, index, start: cursor, end: cursor + share, share };
    cursor += share;
    return slice;
  });

  return (
    <div className="row g-3 align-items-center justify-content-center">
      <div className="col-12 col-sm-auto" style={{ maxWidth: `${SIZE + 16}px` }}>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          style={{ width: '100%', maxWidth: `${SIZE}px`, height: 'auto', display: 'block', margin: '0 auto' }}
          role="img"
          aria-label={`${chart.title}: ${slices.map((slice) => `${slice.label} ${(slice.share * 100).toFixed(1)}%`).join(', ')}`}
        >
          {slices
            .filter((slice) => slice.value > 0)
            .map((slice) => (
              <path
                key={slice.label}
                d={arcPath(slice.start, slice.end)}
                fill={colorFor(slice.index)}
                stroke="#fff"
                strokeWidth={2}
                opacity={hover && hover.label !== slice.label ? 0.4 : 1}
                onMouseEnter={() => setHover(slice)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(slice)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                role="button"
                aria-label={`${slice.label}: ${format(slice.value)}, ${(slice.share * 100).toFixed(1)}%`}
              />
            ))}
          {/* The hub reads as the total, or as the hovered slice's share. */}
          <text x={CENTRE} y={CENTRE - 8} textAnchor="middle" fontSize={10.5} fill="#8b94a6">
            {hover ? hover.label : 'Total'}
          </text>
          <text
            x={CENTRE}
            y={CENTRE + 11}
            textAnchor="middle"
            /* A long INR total needs a smaller face than a two-digit share. */
            fontSize={hover ? 19 : Math.max(10, Math.min(15, 150 / Math.max(format(total).length, 1)))}
            fontWeight="700"
            fill="#111827"
          >
            {hover ? `${(hover.share * 100).toFixed(1)}%` : format(total)}
          </text>
        </svg>
      </div>

      <div className="col">
        <ul className="lms-analytics-pie-legend">
          {slices.map((slice) => (
            <li
              key={slice.label}
              onMouseEnter={() => setHover(slice)}
              onMouseLeave={() => setHover(null)}
              style={{ opacity: hover && hover.label !== slice.label ? 0.55 : 1 }}
            >
              <span
                className="lms-analytics-swatch"
                aria-hidden="true"
                style={{ background: colorFor(slice.index) }}
              />
              <span className="text-truncate">{slice.label}</span>
              <span className="lms-analytics-pie-amount">{format(slice.value)}</span>
              <span className="lms-analytics-pie-share">{(slice.share * 100).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
