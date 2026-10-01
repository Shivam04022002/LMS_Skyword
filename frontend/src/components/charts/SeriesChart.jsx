import { useState } from 'react';
import { colorFor, compactInr, exactInr, niceScale, seriesOf, shortLabel, thinLabels } from './chartUtils';

/*
 * A bar or line chart, in SVG.
 *
 * One component for both because they share everything except how a value is
 * marked: the scale, the gridlines, the axes, the hover target and the tooltip
 * are identical, and keeping them in one place is what stops a bar chart and a
 * line chart of the same data from disagreeing.
 *
 * TWO SHAPES. A chart card is either the full width of the page or half of it,
 * and one viewBox cannot serve both: stretched across a wide screen the full-
 * width ratio becomes a very long, very short strip. `variant` picks the ratio
 * the card will actually be rendered at — roughly 3:1 for a wide card, 5:3 for a
 * half-width one — so neither ends up a letterbox. Everything else is shared.
 *
 * The SVG scales to its container, so it is readable at phone width without a
 * second layout. Values are positioned in viewBox units; nothing measures the DOM.
 */

/*
 * Left padding carries a compact INR tick ("₹12.3L"), bottom padding carries a
 * rotated date label. Both are sized for the longest label those formatters can
 * produce, so a tick is never clipped and a label never collides with the next.
 */
const SHAPE = {
  wide: { width: 960, height: 320, pad: { top: 12, right: 20, bottom: 54, left: 74 } },
  compact: { width: 560, height: 340, pad: { top: 12, right: 14, bottom: 56, left: 70 } }
};

const AXIS_TEXT = '#8b94a6';
const GRID = '#eef0f5';
const BASELINE = '#d5dae4';
const GUIDE = '#10233f';

export default function SeriesChart({ chart, bucket, type = 'bar', valueKind = 'money', variant = 'wide' }) {
  const allSeries = seriesOf(chart);
  // Series the reader has hidden. Hiding rescales the chart, which is the point:
  // a small series is unreadable beside a large one until the large one is off.
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null);

  const view = SHAPE[variant] ?? SHAPE.wide;
  const plot = {
    width: view.width - view.pad.left - view.pad.right,
    height: view.height - view.pad.top - view.pad.bottom
  };

  const series = allSeries.filter((entry) => !hidden.has(entry.key));
  const points = chart.points ?? [];

  const valueOf = (point, key) => Number(point[key] ?? 0);
  const maxValue = Math.max(0, ...points.flatMap((point) => series.map((entry) => valueOf(point, entry.key))));
  // A narrow card has room for fewer gridlines before they crowd.
  const { max, ticks } = niceScale(maxValue, variant === 'compact' ? 3 : 4);

  /*
   * Bars sit in the middle of a band; a line's points sit on the edges, so its
   * first and last point touch the axis ends instead of floating inside them.
   */
  const band = plot.width / Math.max(points.length, 1);
  const xFor = (index) =>
    type === 'line'
      ? points.length === 1
        ? plot.width / 2
        : (index * plot.width) / (points.length - 1)
      : band * index + band / 2;

  /*
   * The hover band for a point: midway to each neighbour, clamped to the plot
   * area. Centring a band on the point itself would push the first and last
   * bands outside the axes in line mode, which put the first point's hover
   * target on top of the y-axis labels.
   */
  const hitBand = (index) => {
    const left = index === 0 ? 0 : (xFor(index - 1) + xFor(index)) / 2;
    const right = index === points.length - 1 ? plot.width : (xFor(index) + xFor(index + 1)) / 2;
    return { x: left, width: Math.max(right - left, 0) };
  };

  const yFor = (value) => plot.height - (value / max) * plot.height;
  const keepLabel = thinLabels(points.length, variant === 'compact' ? 7 : 12);

  // A gap between bars, a gap between groups, and a floor so a long daily series
  // still draws something visible.
  const groupWidth = Math.min(band * 0.66, (variant === 'compact' ? 22 : 30) * series.length);
  const barWidth = Math.max(1.5, groupWidth / Math.max(series.length, 1));

  const format = (value) => (valueKind === 'count' ? String(value) : exactInr(value));
  const axisFormat = (value) => (valueKind === 'count' ? String(Math.round(value)) : compactInr(value));
  const dense = points.length > 60;
  const fontSize = variant === 'compact' ? 13 : 12;

  const toggle = (key) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      // Never hide the last visible series: an empty plot area tells the reader
      // nothing and looks like a failure rather than a choice.
      else if (series.length > 1) next.add(key);
      return next;
    });

  return (
    <div>
      {allSeries.length > 1 ? (
        <div className="lms-analytics-legend">
          {allSeries.map((entry) => {
            const off = hidden.has(entry.key);
            const color = colorFor(allSeries.indexOf(entry));
            return (
              <button
                key={entry.key}
                type="button"
                className="lms-analytics-legend-item"
                aria-pressed={!off}
                onClick={() => toggle(entry.key)}
                title={off ? `Show ${entry.label}` : `Hide ${entry.label}`}
              >
                <span
                  className="lms-analytics-swatch"
                  aria-hidden="true"
                  style={{ background: off ? 'transparent' : color, boxShadow: `inset 0 0 0 2px ${color}` }}
                />
                <span className="lms-analytics-legend-text">{entry.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="position-relative">
        <svg
          viewBox={`0 0 ${view.width} ${view.height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label={`${chart.title}: ${type} chart of ${points.length} points`}
        >
          <g transform={`translate(${view.pad.left},${view.pad.top})`}>
            {/* Gridlines and the value axis. The zero line is the baseline, so it
                is drawn once, below, rather than twice. */}
            {ticks.map((tick) => (
              <g key={tick}>
                {tick > 0 ? (
                  <line x1={0} x2={plot.width} y1={yFor(tick)} y2={yFor(tick)} stroke={GRID} strokeWidth={1} />
                ) : null}
                <text
                  x={-10}
                  y={yFor(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={fontSize}
                  fill={AXIS_TEXT}
                >
                  {axisFormat(tick)}
                </text>
              </g>
            ))}

            {/* The hovered column, behind the marks so it never hides them. */}
            {hover ? (
              <rect {...hitBand(hover.index)} y={0} height={plot.height} fill={GUIDE} opacity={0.04} />
            ) : null}

            {/* Marks */}
            {type === 'line'
              ? series.map((entry) => {
                  const color = colorFor(allSeries.indexOf(entry));
                  const path = points
                    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(valueOf(point, entry.key))}`)
                    .join(' ');
                  return (
                    <g key={entry.key}>
                      <path
                        d={path}
                        fill="none"
                        stroke={color}
                        strokeWidth={2.25}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                      {/* Markers are dropped on a dense series, where they would
                          merge into a thick band, but the hovered one is always
                          drawn so the reader can see what they are reading. */}
                      {points.map((point, index) =>
                        !dense || hover?.index === index ? (
                          <circle
                            key={point.label}
                            cx={xFor(index)}
                            cy={yFor(valueOf(point, entry.key))}
                            r={hover?.index === index ? 4.5 : 3}
                            fill="#fff"
                            stroke={color}
                            strokeWidth={2}
                          />
                        ) : null
                      )}
                    </g>
                  );
                })
              : points.map((point, index) =>
                  series.map((entry, seriesIndex) => {
                    const value = valueOf(point, entry.key);
                    const height = Math.max(value > 0 ? 1 : 0, plot.height - yFor(value));
                    const x = xFor(index) - groupWidth / 2 + seriesIndex * barWidth;
                    return (
                      <rect
                        key={`${point.label}-${entry.key}`}
                        x={x}
                        y={plot.height - height}
                        width={Math.max(barWidth - (series.length > 1 ? 1 : 0), 1)}
                        height={height}
                        fill={colorFor(allSeries.indexOf(entry))}
                        opacity={hover && hover.index !== index ? 0.55 : 1}
                        rx={barWidth > 6 ? 2 : 0}
                      />
                    );
                  })
                )}

            {/* Category axis */}
            <line x1={0} x2={plot.width} y1={plot.height} y2={plot.height} stroke={BASELINE} strokeWidth={1} />
            {points.map((point, index) =>
              keepLabel(index) ? (
                <text
                  key={point.label}
                  x={xFor(index)}
                  y={plot.height + 16}
                  textAnchor="end"
                  fontSize={fontSize}
                  fill={hover?.index === index ? GUIDE : AXIS_TEXT}
                  fontWeight={hover?.index === index ? 600 : 400}
                  transform={`rotate(-38 ${xFor(index)} ${plot.height + 16})`}
                >
                  {shortLabel(point.label, bucket)}
                </text>
              ) : null
            )}

            {/*
              One full-height hover target per point, so the tooltip appears
              anywhere in a point's column rather than only on the mark itself —
              a 2px bar on a daily series is otherwise impossible to hit.
            */}
            {points.map((point, index) => (
              <rect
                key={`hit-${point.label}`}
                {...hitBand(index)}
                y={0}
                height={plot.height}
                fill="transparent"
                onMouseEnter={() => setHover({ point, index })}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover({ point, index })}
                onBlur={() => setHover(null)}
                tabIndex={0}
                role="button"
                aria-label={`${shortLabel(point.label, bucket)}: ${series
                  .map((entry) => `${entry.label} ${format(valueOf(point, entry.key))}`)
                  .join(', ')}`}
              />
            ))}
          </g>
        </svg>

        {hover ? (
          <div
            className="lms-analytics-tooltip"
            style={{
              // Positioned as a percentage of the plot area, so the tooltip
              // follows the hovered column at any rendered width. It flips side
              // past the midpoint so it cannot be clipped by the card edge.
              left: `${((view.pad.left + xFor(hover.index)) / view.width) * 100}%`,
              top: 0,
              transform: hover.index > points.length / 2 ? 'translate(calc(-100% - 10px), 0)' : 'translate(10px, 0)'
            }}
            role="tooltip"
          >
            <div className="lms-analytics-tooltip-title">{shortLabel(hover.point.label, bucket)}</div>
            {hover.point.count !== null && hover.point.count !== undefined ? (
              <div className="text-secondary mb-1">
                {hover.point.count} {hover.point.count === 1 ? 'record' : 'records'}
              </div>
            ) : null}
            {series.map((entry) => (
              <div key={entry.key} className="lms-analytics-tooltip-row">
                <span
                  className="lms-analytics-swatch"
                  aria-hidden="true"
                  style={{ background: colorFor(allSeries.indexOf(entry)) }}
                />
                <span className="text-secondary">{entry.label}</span>
                <span className="lms-analytics-tooltip-value">{format(valueOf(hover.point, entry.key))}</span>
              </div>
            ))}
            {hover.point.collectionRate !== undefined && hover.point.collectionRate !== null ? (
              <div className="lms-analytics-tooltip-row mt-1 pt-1 border-top">
                <span className="text-secondary">Collection rate</span>
                <span className="lms-analytics-tooltip-value">{hover.point.collectionRate}%</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
