import api from './api';

/**
 * Loan party API calls. Uses the shared Axios client, so auth headers, the 401
 * handler and error normalisation are inherited.
 */
export const getLoanParties = (loanId, { includeRemoved = false } = {}) =>
  api.get(`/admin/loans/${loanId}/parties`, { params: includeRemoved ? { includeRemoved: true } : {} });

/** Identify the customer by `customerId` or `cifId` — never by profile fields. */
export const addLoanParty = (loanId, payload) => api.post(`/admin/loans/${loanId}/parties`, payload);

export const updateLoanParty = (loanId, partyId, payload) => api.put(`/admin/loans/${loanId}/parties/${partyId}`, payload);

/** Soft removal — the row and its history are retained. */
export const setLoanPartyStatus = (loanId, partyId, status) =>
  api.patch(`/admin/loans/${loanId}/parties/${partyId}/status`, { status });

export const swapApplicant = (loanId, coApplicantPartyId) =>
  api.post(`/admin/loans/${loanId}/parties/swap`, coApplicantPartyId ? { coApplicantPartyId } : {});
