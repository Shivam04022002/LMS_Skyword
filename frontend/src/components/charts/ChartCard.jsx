import { useState } from 'react';
import PieChart from './PieChart';
import SeriesChart from './SeriesChart';
import { isEmptyChart, seriesOf } from './chartUtils';

/*
 * One chart in a card: its title, a short description of what the chart shows,
 * the chart-type switch where more than one type is honest for that data, and
 * the loading / empty / error states.
 *
 * The card is a column with the plot in a growing middle, so two cards sitting
 * side by side finish the same height whatever their headers do.
 *
 * A pie is offered only for a single-measure category chart. A date series is
 * never a pie — a share of consecutive periods is not a meaningful reading — and
 * neither is a chart whose measures are not parts of one whole, which the
 * backend signals by giving it several `seriesKeys`.
 */

const TYPE_ICON = { bar: 'bi-bar-chart-fill', line: 'bi-graph-up', pie: 'bi-pie-chart-fill' };
const TYPE_LABEL = { bar: 'Bar chart', line: 'Line chart', pie: 'Donut chart' };

export default function ChartCard({
  chart,
  bucket,
  loading,
  error,
  valueKind = 'money',
  defaultType = 'bar',
  description,
  variant = 'wide'
}) {
  const [type, setType] = useState(defaultType);

  const isSeries = chart?.kind === 'series';
  const singleMeasure = chart ? seriesOf(chart).length === 1 : false;
  // Bar and line both read a date series honestly. A pie needs a whole to divide,
  // so it is offered only for one measure across categories.
  const available = isSeries ? ['bar', 'line'] : singleMeasure ? ['bar', 'pie'] : ['bar'];
  const effectiveType = available.includes(type) ? type : available[0];

  const empty = chart ? isEmptyChart(chart) : true;
  // The backend's own caveat wins: it explains something about the figures, and
  // the page's description only says what the chart plots.
  const note = chart?.note ?? description;

  return (
    <section className="lms-analytics-surface lms-analytics-chart">
      <div className="lms-analytics-chart-head">
        <div className="min-w-0">
          <h2 className="lms-analytics-chart-title">{chart?.title ?? 'Chart'}</h2>
          {note ? <p className="lms-analytics-chart-note">{note}</p> : null}
        </div>

        {available.length > 1 && !loading && !error && !empty ? (
          <div className="lms-analytics-type-switch" role="group" aria-label={`Chart type for ${chart.title}`}>
            {available.map((option) => (
              <button
                key={option}
                type="button"
                className="lms-analytics-type-button"
                aria-pressed={effectiveType === option}
                onClick={() => setType(option)}
                title={TYPE_LABEL[option]}
              >
                <i className={`bi ${TYPE_ICON[option]}`} aria-hidden="true" />
                <span className="visually-hidden">{TYPE_LABEL[option]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="lms-analytics-chart-body">
        {error ? (
          <div className="alert alert-danger mb-0 d-flex align-items-start gap-2 py-2 px-3 small" role="alert">
            <i className="bi bi-exclamation-triangle-fill mt-1" aria-hidden="true" />
            <div>{error}</div>
          </div>
        ) : loading ? (
          <div className="lms-analytics-placeholder">
            <span className="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true" />
            <p className="mb-0 mt-2 small">Loading {chart?.title?.toLowerCase() ?? 'chart'}…</p>
          </div>
        ) : empty ? (
          /*
            An empty dataset says so. It deliberately does not draw a flat line
            along zero: that reads as "we measured zero every day", which is a
            different claim from "there is nothing here to measure".
          */
          <div className="lms-analytics-placeholder">
            <i className="bi bi-inbox lms-analytics-placeholder-icon" aria-hidden="true" />
            <p className="mb-0">No data in this period for these filters.</p>
            <p className="small mb-0 text-body-tertiary">Nothing is charted rather than drawing a zero trend.</p>
          </div>
        ) : effectiveType === 'pie' ? (
          <PieChart chart={chart} valueKind={valueKind} />
        ) : (
          <SeriesChart chart={chart} bucket={bucket} type={effectiveType} valueKind={valueKind} variant={variant} />
        )}
      </div>
    </section>
  );
}
