import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

export const getEmiSchedule = (loanId, params) =>
  api.get(`/admin/loans/${loanId}/emis`, { params: toQuery(params) });

export const getEmi = (loanId, emiId) => api.get(`/admin/loans/${loanId}/emis/${emiId}`);

/** Recovery path only — activation normally generates the schedule. */
export const generateEmiSchedule = (loanId) => api.post(`/admin/loans/${loanId}/emis/generate`);

/** Refreshes stored DPD/status snapshots; changes no money or dates. */
export const recalculateEmiSnapshots = (loanId) => api.post(`/admin/loans/${loanId}/emis/recalculate`);

/**
 * Records the manual bounce charge on one instalment. Send '0' to clear it.
 * Touches nothing else on the instalment.
 */
export const updateEmiBounceCharge = (loanId, emiId, bounceCharge) =>
  api.patch(`/admin/loans/${loanId}/emis/${emiId}/bounce-charge`, { bounceCharge });
