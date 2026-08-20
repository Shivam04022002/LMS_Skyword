import api from './api';

export const fetchRoles = () => api.get('/admin/roles');

export const fetchRole = (id) => api.get(`/admin/roles/${id}`);

export const updateRolePermissions = (id, permissions) => api.put(`/admin/roles/${id}/permissions`, { permissions });

export const fetchPermissions = () => api.get('/admin/permissions');
