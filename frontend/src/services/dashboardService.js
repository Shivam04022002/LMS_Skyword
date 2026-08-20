import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

/**
 * One request returns every KPI section — the dashboard never fans out into a
 * call per card. Read-only; there is no mutating counterpart by design.
 */
export const getDashboard = (params) => api.get('/admin/dashboard', { params: toQuery(params) });
