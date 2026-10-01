/*
 * The filter panel.
 *
 * Grouped by what the controls mean rather than by the order they happen to be
 * declared in: the period first, then scope, then the status filters that narrow
 * what is counted. Only the groups the selected section actually uses are
 * rendered, so a section is never offered a control that would change nothing.
 *
 * Presentation only. The filter keys, their values and their meanings are the
 * page's, unchanged — this component receives the state and the one setter and
 * renders them.
 */

export default function AnalyticsFilters({
  filters,
  shows,
  routes,
  collectors,
  buckets,
  loanStatuses,
  loanTypes,
  emiStatuses,
  ledgerTypes,
  dirty,
  loading,
  onChange,
  onApply
}) {
  const field = (id, label, control) => (
    <div className="col-6 col-md-4 col-xl-3">
      <label className="lms-analytics-field-label" htmlFor={id}>
        {label}
      </label>
      {control}
    </div>
  );

  const select = (id, key, placeholder, options) => (
    <select id={id} className="form-select" value={filters[key]} onChange={onChange(key)}>
      <option value="">{placeholder}</option>
      {options}
    </select>
  );

  // Which groups have anything to show for this section.
  const hasScope = true; // route is offered for every section; collector when permitted
  const hasNarrowing = shows('status') || shows('loanType') || shows('emiStatus') || shows('ledgerType');

  return (
    <section className="lms-analytics-surface p-3 p-md-4 mb-3" aria-label="Filters">
      <div className="lms-analytics-filters-head">
        <h2 className="lms-analytics-filters-title">
          <i className="bi bi-sliders2 me-1" aria-hidden="true" />
          Filters
        </h2>
        {dirty ? (
          <span className="small text-primary d-inline-flex align-items-center gap-1">
            <i className="bi bi-info-circle" aria-hidden="true" />
            Not applied yet — the charts below still show the previous filters.
          </span>
        ) : null}
      </div>

      {/* ---- period ---- */}
      <p className="lms-analytics-group-label">Period</p>
      <div className="row g-3 mb-3">
        {shows('date') &&
          field(
            'ga-asof',
            'As of',
            <input id="ga-asof" type="date" className="form-control" value={filters.date} onChange={onChange('date')} />
          )}
        {field(
          'ga-from',
          'From',
          <input id="ga-from" type="date" className="form-control" value={filters.dateFrom} onChange={onChange('dateFrom')} />
        )}
        {field(
          'ga-to',
          'To',
          <input id="ga-to" type="date" className="form-control" value={filters.dateTo} onChange={onChange('dateTo')} />
        )}
        {field(
          'ga-bucket',
          'Group by',
          <select id="ga-bucket" className="form-select" value={filters.bucket} onChange={onChange('bucket')}>
            <option value={buckets.DAY}>Day</option>
            <option value={buckets.WEEK}>Week</option>
            <option value={buckets.MONTH}>Month</option>
          </select>
        )}
      </div>

      {/* ---- scope ---- */}
      {hasScope ? (
        <>
          <p className="lms-analytics-group-label">Scope</p>
          <div className={`row g-3 ${hasNarrowing ? 'mb-3' : ''}`}>
            {field(
              'ga-route',
              'Route',
              select(
                'ga-route',
                'routeId',
                'All routes',
                routes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.routeCode}
                  </option>
                ))
              )
            )}
            {/*
              A collector FILTER, not a grouping. A collection records who keyed
              it, not who collected it, and a route can have several collectors —
              so attributing an amount to one of them would either misreport or
              double-count. Filtering by collector means "the routes this
              collector is assigned to", which is what every other report means
              by it. Shown only when the caller may read the user list.
            */}
            {collectors.length > 0
              ? field(
                  'ga-collector',
                  'Collector',
                  select(
                    'ga-collector',
                    'collectorId',
                    'All collectors',
                    collectors.map((collector) => (
                      <option key={collector.id} value={collector.id}>
                        {collector.name}
                      </option>
                    ))
                  )
                )
              : null}
          </div>
        </>
      ) : null}

      {/* ---- what is counted ---- */}
      {hasNarrowing ? (
        <>
          <p className="lms-analytics-group-label">Narrow by</p>
          <div className="row g-3">
            {shows('status') &&
              field(
                'ga-status',
                'Loan status',
                select(
                  'ga-status',
                  'status',
                  'All statuses',
                  loanStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))
                )
              )}
            {shows('loanType') &&
              field(
                'ga-type',
                'Loan type',
                select(
                  'ga-type',
                  'loanType',
                  'All types',
                  loanTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))
                )
              )}
            {shows('emiStatus') &&
              field(
                'ga-emi-status',
                'Instalment status',
                select(
                  'ga-emi-status',
                  'emiStatus',
                  'All statuses',
                  emiStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))
                )
              )}
            {shows('ledgerType') &&
              field(
                'ga-mode',
                'Payment mode',
                select(
                  'ga-mode',
                  'ledgerType',
                  'All modes',
                  ledgerTypes.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))
                )
              )}
          </div>
        </>
      ) : null}

      {/*
        Apply is in the header, where the other three actions are. It is repeated
        here because at the foot of a long filter panel on a phone the header is
        scrolled away, and a filter panel with no visible way to apply it is a
        dead end.
      */}
      <div className="d-flex justify-content-end mt-3 d-xl-none">
        <button type="button" className="btn btn-primary btn-sm" onClick={onApply} disabled={loading || !dirty}>
          <i className="bi bi-funnel me-1" aria-hidden="true" />
          Apply filters
        </button>
      </div>
    </section>
  );
}
