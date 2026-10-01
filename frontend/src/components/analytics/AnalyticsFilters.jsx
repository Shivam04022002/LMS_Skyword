/*
 * The filter panel.
 *
 * Grouped by what the controls mean rather than by the order they happen to be
 * declared in: the period first, then scope, then the status filters that narrow
 * what is counted. Only the groups the selected section actually uses are
 * rendered, and a group is only rendered if it has a field in it.
 *
 * THE DEAD SPACE: groups used to be fixed columns, so a Scope group holding one
 * select claimed as much width as a Period group holding four and left most of
 * it empty. Each group now flexes in proportion to how many fields it holds, and
 * the fields inside it fill the width they are given. A section that shows fewer
 * filters therefore produces a shorter, denser panel rather than the same tall
 * one with gaps in it.
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
    <div key={id}>
      <label className="lms-analytics-field-label" htmlFor={id}>
        {label}
      </label>
      {control}
    </div>
  );

  const dateField = (id, key, label) =>
    field(id, label, <input id={id} type="date" className="form-control" value={filters[key]} onChange={onChange(key)} />);

  const selectField = (id, key, label, placeholder, options) =>
    field(
      id,
      label,
      <select id={id} className="form-select" value={filters[key]} onChange={onChange(key)}>
        <option value="">{placeholder}</option>
        {options}
      </select>
    );

  const optionsOf = (values) =>
    values.map((value) => (
      <option key={value} value={value}>
        {value}
      </option>
    ));

  /* ---- what each group contains, for this section ---- */

  const period = [
    shows('date') ? dateField('ga-asof', 'date', 'As of') : null,
    dateField('ga-from', 'dateFrom', 'From'),
    dateField('ga-to', 'dateTo', 'To'),
    field(
      'ga-bucket',
      'Group by',
      <select id="ga-bucket" className="form-select" value={filters.bucket} onChange={onChange('bucket')}>
        <option value={buckets.DAY}>Day</option>
        <option value={buckets.WEEK}>Week</option>
        <option value={buckets.MONTH}>Month</option>
      </select>
    )
  ].filter(Boolean);

  const scope = [
    selectField(
      'ga-route',
      'routeId',
      'Route',
      'All routes',
      routes.map((route) => (
        <option key={route.id} value={route.id}>
          {route.routeCode}
        </option>
      ))
    ),
    /*
     * A collector FILTER, not a grouping. A collection records who keyed it, not
     * who collected it, and a route can have several collectors — so attributing
     * an amount to one of them would either misreport or double-count. Filtering
     * by collector means "the routes this collector is assigned to", which is
     * what every other report means by it. Shown only when the caller may read
     * the user list.
     */
    collectors.length > 0
      ? selectField(
          'ga-collector',
          'collectorId',
          'Collector',
          'All collectors',
          collectors.map((collector) => (
            <option key={collector.id} value={collector.id}>
              {collector.name}
            </option>
          ))
        )
      : null
  ].filter(Boolean);

  const narrow = [
    shows('status') ? selectField('ga-status', 'status', 'Loan status', 'All statuses', optionsOf(loanStatuses)) : null,
    shows('loanType') ? selectField('ga-type', 'loanType', 'Loan type', 'All types', optionsOf(loanTypes)) : null,
    shows('emiStatus')
      ? selectField('ga-emi-status', 'emiStatus', 'Instalment status', 'All statuses', optionsOf(emiStatuses))
      : null,
    shows('ledgerType') ? selectField('ga-mode', 'ledgerType', 'Payment mode', 'All modes', optionsOf(ledgerTypes)) : null
  ].filter(Boolean);

  const groups = [
    { key: 'period', label: 'Period', fields: period },
    { key: 'scope', label: 'Scope', fields: scope },
    { key: 'narrow', label: 'Narrow by', fields: narrow }
  ].filter((group) => group.fields.length > 0);

  return (
    <section className="lms-analytics-surface p-3 mb-3" aria-label="Filters">
      <div className="lms-analytics-filters-head">
        <h2 className="lms-analytics-filters-title">
          <i className="bi bi-sliders2" aria-hidden="true" />
          Filters
        </h2>
        {dirty ? (
          <span className="lms-analytics-dirty">
            <i className="bi bi-exclamation-circle" aria-hidden="true" />
            Not applied yet — the charts below still show the previous filters.
          </span>
        ) : null}
      </div>

      <div className="lms-analytics-filter-groups">
        {groups.map((group) => (
          <div
            key={group.key}
            className="lms-analytics-filter-group"
            /*
             * The weight is the field count, so three fields get three times the
             * width of one and nothing is reserved for a field that is not there.
             * The basis keeps a group from collapsing below one usable control.
             */
            style={{ '--lms-group-weight': group.fields.length, '--lms-group-basis': '13rem' }}
          >
            <p className="lms-analytics-group-label">{group.label}</p>
            <div className="lms-analytics-fields">{group.fields}</div>
          </div>
        ))}
      </div>

      {/*
        Apply also sits in the header, with the other three actions. It is
        repeated here because at the foot of the panel on a phone the header has
        scrolled away, and a filter panel with no visible way to apply it is a
        dead end.
      */}
      <div className="d-flex justify-content-end mt-3 d-xl-none">
        <button
          type="button"
          className="btn btn-primary lms-analytics-action"
          onClick={onApply}
          disabled={loading || !dirty}
        >
          <i className="bi bi-funnel" aria-hidden="true" />
          Apply filters
        </button>
      </div>
    </section>
  );
}
