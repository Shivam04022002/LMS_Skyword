import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

export const fetchUsers = (params) => api.get('/admin/users', { params: toQuery(params) });

export const fetchUser = (id) => api.get(`/admin/users/${id}`);

export const createUser = (payload) => api.post('/admin/users', payload);

export const updateUser = (id, payload) => api.put(`/admin/users/${id}`, payload);

export const changeUserStatus = (id, status) => api.patch(`/admin/users/${id}/status`, { status });

export const changeUserRole = (id, role) => api.patch(`/admin/users/${id}/role`, { role });

export const resetUserPassword = (id, newPassword) => api.post(`/admin/users/${id}/reset-password`, { newPassword });
