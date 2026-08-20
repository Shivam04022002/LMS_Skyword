import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

export const getRoutes = (params) => api.get('/admin/routes', { params: toQuery(params) });

export const getRoute = (id) => api.get(`/admin/routes/${id}`);

/** Only name and description are accepted — routeCode is generated server-side. */
export const createRoute = (payload) => api.post('/admin/routes', payload);

export const updateRoute = (id, payload) => api.put(`/admin/routes/${id}`, payload);

export const updateRouteStatus = (id, status) => api.patch(`/admin/routes/${id}/status`, { status });

/** Full assignment history — collectors and loans, active and past. */
export const getRouteAssignments = (id, { includeRemoved = true } = {}) =>
  api.get(`/admin/routes/${id}/assignments`, { params: { includeRemoved } });

export const assignCollector = (id, userId) => api.post(`/admin/routes/${id}/collectors`, { userId });

export const setCollectorAssignmentStatus = (id, assignmentId, status) =>
  api.patch(`/admin/routes/${id}/collectors/${assignmentId}/status`, { status });

export const assignLoan = (id, loanId) => api.post(`/admin/routes/${id}/loans`, { loanId });

export const setLoanAssignmentStatus = (id, assignmentId, status) =>
  api.patch(`/admin/routes/${id}/loans/${assignmentId}/status`, { status });
