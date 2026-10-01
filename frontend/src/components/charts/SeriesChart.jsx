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
 * The SVG uses a fixed viewBox and scales to its container, so it is readable at
 * phone width without a second layout. Values are positioned in viewBox units;
 * nothing measures the DOM.
 */

const VIEW = { width: 960, height: 340 };
const PAD = { top: 16, right: 16, bottom: 52, left: 68 };
const PLOT = {
  width: VIEW.width - PAD.left - PAD.right,
  height: VIEW.height - PAD.top - PAD.bottom
};

export default function SeriesChart({ chart, bucket, type = 'bar', valueKind = 'money' }) {
  const allSeries = seriesOf(chart);
  // Series the reader has hidden. Hiding rescales the chart, which is the point:
  // a small series is unreadable beside a large one until the large one is off.
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null);

  const series = allSeries.filter((entry) => !hidden.has(entry.key));
  const points = chart.points ?? [];

  const valueOf = (point, key) => Number(point[key] ?? 0);
  const maxValue = Math.max(0, ...points.flatMap((point) => series.map((entry) => valueOf(point, entry.key))));
  const { max, ticks } = niceScale(maxValue);

  const xFor = (index) => (points.length === 1 ? PLOT.width / 2 : (index * PLOT.width) / (points.length - 1));
  const yFor = (value) => PLOT.height - (value / max) * PLOT.height;
  const keepLabel = thinLabels(points.length);

  const bandWidth = PLOT.width / Math.max(points.length, 1);
  const barWidth = Math.max(2, Math.min(28, (bandWidth * 0.7) / Math.max(series.length, 1)));

  const format = (value) => (valueKind === 'count' ? String(value) : exactInr(value));
  const axisFormat = (value) => (valueKind === 'count' ? String(Math.round(value)) : compactInr(value));

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
        <div className="d-flex flex-wrap gap-2 mb-2">
          {allSeries.map((entry, index) => {
            const off = hidden.has(entry.key);
            return (
              <button
                key={entry.key}
                type="button"
                className={`btn btn-sm border d-inline-flex align-items-center gap-1 ${off ? 'text-secondary' : ''}`}
                aria-pressed={!off}
                onClick={() => toggle(entry.key)}
                title={off ? `Show ${entry.label}` : `Hide ${entry.label}`}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: '0.75rem',
                    height: '0.75rem',
                    borderRadius: '2px',
                    display: 'inline-block',
                    background: off ? 'transparent' : colorFor(allSeries.indexOf(entry)),
                    border: `2px solid ${colorFor(allSeries.indexOf(entry))}`
                  }}
                />
                <span className={off ? 'text-decoration-line-through' : ''}>{entry.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="position-relative">
        <svg
          viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
          role="img"
          aria-label={`${chart.title}: ${type} chart of ${points.length} points`}
        >
          <g transform={`translate(${PAD.left},${PAD.top})`}>
            {/* Gridlines and value axis */}
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={0} x2={PLOT.width} y1={yFor(tick)} y2={yFor(tick)} stroke="#dee2e6" strokeWidth={1} />
                <text x={-10} y={yFor(tick)} textAnchor="end" dominantBaseline="middle" fontSize={13} fill="#6c757d">
                  {axisFormat(tick)}
                </text>
              </g>
            ))}

            {/* Marks */}
            {type === 'line'
              ? series.map((entry) => {
                  const path = points
                    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(valueOf(point, entry.key))}`)
                    .join(' ');
                  return (
                    <g key={entry.key}>
                      <path d={path} fill="none" stroke={colorFor(allSeries.indexOf(entry))} strokeWidth={2.5} strokeLinejoin="round" />
                      {points.map((point, index) => (
                        <circle
                          key={point.label}
                          cx={xFor(index)}
                          cy={yFor(valueOf(point, entry.key))}
                          r={points.length > 60 ? 0 : 3.5}
                          fill="#fff"
                          stroke={colorFor(allSeries.indexOf(entry))}
                          strokeWidth={2}
                        />
                      ))}
                    </g>
                  );
                })
              : points.map((point, index) =>
                  series.map((entry, seriesIndex) => {
                    const value = valueOf(point, entry.key);
                    const height = Math.max(0, PLOT.height - yFor(value));
                    const groupWidth = barWidth * series.length;
                    const x = xFor(index) - groupWidth / 2 + seriesIndex * barWidth;
                    return (
                      <rect
                        key={`${point.label}-${entry.key}`}
                        x={x}
                        y={yFor(value)}
                        width={barWidth}
                        height={height}
                        fill={colorFor(allSeries.indexOf(entry))}
                        rx={2}
                      />
                    );
                  })
                )}

            {/* Category axis */}
            <line x1={0} x2={PLOT.width} y1={PLOT.height} y2={PLOT.height} stroke="#adb5bd" strokeWidth={1} />
            {points.map((point, index) =>
              keepLabel(index) ? (
                <text
                  key={point.label}
                  x={xFor(index)}
                  y={PLOT.height + 20}
                  textAnchor="end"
                  fontSize={13}
                  fill="#6c757d"
                  transform={`rotate(-35 ${xFor(index)} ${PLOT.height + 20})`}
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
                x={xFor(index) - bandWidth / 2}
                y={0}
                width={bandWidth}
                height={PLOT.height}
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

            {hover ? (
              <line
                x1={xFor(hover.index)}
                x2={xFor(hover.index)}
                y1={0}
                y2={PLOT.height}
                stroke="#212529"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            ) : null}
          </g>
        </svg>

        {hover ? (
          <div
            className="position-absolute bg-body border rounded shadow-sm px-2 py-1 small"
            style={{
              // Positioned in percentages of the plot area, so the tooltip
              // follows the hovered column at any rendered width.
              left: `${((PAD.left + xFor(hover.index)) / VIEW.width) * 100}%`,
              top: 0,
              transform: hover.index > points.length / 2 ? 'translate(-105%, 0)' : 'translate(8px, 0)',
              pointerEvents: 'none',
              zIndex: 2,
              minWidth: '9rem'
            }}
            role="tooltip"
          >
            <div className="fw-semibold">{shortLabel(hover.point.label, bucket)}</div>
            {hover.point.count !== null && hover.point.count !== undefined ? (
              <div className="text-secondary">
                {hover.point.count} {hover.point.count === 1 ? 'record' : 'records'}
              </div>
            ) : null}
            {series.map((entry) => (
              <div key={entry.key} className="d-flex align-items-center gap-1">
                <span
                  aria-hidden="true"
                  style={{
                    width: '0.6rem',
                    height: '0.6rem',
                    borderRadius: '2px',
                    display: 'inline-block',
                    background: colorFor(allSeries.indexOf(entry))
                  }}
                />
                <span className="text-secondary">{entry.label}:</span>
                <span className="fw-semibold ms-auto">{format(valueOf(hover.point, entry.key))}</span>
              </div>
            ))}
            {hover.point.collectionRate !== undefined && hover.point.collectionRate !== null ? (
              <div className="text-secondary">Collection rate: {hover.point.collectionRate}%</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
