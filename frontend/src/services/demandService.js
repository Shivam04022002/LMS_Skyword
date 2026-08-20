import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

/**
 * Demand is read-only. There are no mutating calls here by design — the amounts
 * come from the backend's derivation and are never recomputed in the browser.
 */
export const getDemand = (params) => api.get('/admin/demand', { params: toQuery(params) });

export const getRouteDemandSummary = (params) => api.get('/admin/demand/routes', { params: toQuery(params) });
