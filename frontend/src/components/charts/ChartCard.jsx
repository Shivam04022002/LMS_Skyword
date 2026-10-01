import { useState } from 'react';
import Spinner from '../common/Spinner';
import PieChart from './PieChart';
import SeriesChart from './SeriesChart';
import { isEmptyChart, seriesOf } from './chartUtils';

/*
 * One chart in a card: its title, whatever caveat the backend attached to it,
 * the chart-type switch where more than one type is honest for that data, and
 * the loading / empty / error states.
 *
 * A pie is offered only for a single-measure category chart. A date series is
 * never a pie — a share of consecutive periods is not a meaningful reading — and
 * neither is a chart whose measures are not parts of one whole, which the
 * backend signals by giving it several `seriesKeys`.
 */

const TYPE_ICON = { bar: 'bi-bar-chart-fill', line: 'bi-graph-up', pie: 'bi-pie-chart-fill' };

export default function ChartCard({ chart, bucket, loading, error, valueKind = 'money', defaultType = 'bar', className = '' }) {
  const [type, setType] = useState(defaultType);

  const isSeries = chart?.kind === 'series';
  const singleMeasure = chart ? seriesOf(chart).length === 1 : false;
  // Bar and line both read a date series honestly. A pie needs a whole to divide,
  // so it is offered only for one measure across categories.
  const available = isSeries ? ['bar', 'line'] : singleMeasure ? ['bar', 'pie'] : ['bar'];
  const effectiveType = available.includes(type) ? type : available[0];

  const empty = chart ? isEmptyChart(chart) : true;

  return (
    <div className={`card border-0 shadow-sm h-100 ${className}`}>
      <div className="card-body">
        <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-2">
          <div>
            <h2 className="h6 fw-bold mb-0">{chart?.title ?? 'Chart'}</h2>
            {chart?.note ? <p className="form-text mt-1 mb-0">{chart.note}</p> : null}
          </div>

          {available.length > 1 && !loading && !error && !empty ? (
            <div className="btn-group btn-group-sm" role="group" aria-label={`Chart type for ${chart.title}`}>
              {available.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`btn ${effectiveType === option ? 'btn-secondary' : 'btn-outline-secondary'}`}
                  aria-pressed={effectiveType === option}
                  onClick={() => setType(option)}
                  title={`Show as ${option} chart`}
                >
                  <i className={`bi ${TYPE_ICON[option]}`} aria-hidden="true" />
                  <span className="visually-hidden">{option}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="alert alert-danger mb-0 d-flex align-items-start gap-2" role="alert">
            <i className="bi bi-exclamation-triangle-fill mt-1" aria-hidden="true" />
            <div>{error}</div>
          </div>
        ) : loading ? (
          <div className="py-5">
            <Spinner label={`Loading ${chart?.title ?? 'chart'}…`} />
          </div>
        ) : empty ? (
          /*
            An empty dataset says so. It deliberately does not draw a flat line
            along zero: that reads as "we measured zero every day", which is a
            different claim from "there is nothing here to measure".
          */
          <div className="text-center text-secondary py-5">
            <i className="bi bi-inbox fs-3 d-block mb-2" aria-hidden="true" />
            <p className="mb-0">No data in this period for these filters.</p>
            <p className="small mb-0">Nothing is charted rather than drawing a zero trend.</p>
          </div>
        ) : effectiveType === 'pie' ? (
          <PieChart chart={chart} valueKind={valueKind} />
        ) : (
          <SeriesChart chart={chart} bucket={bucket} type={effectiveType} valueKind={valueKind} />
        )}
      </div>
    </div>
  );
}
