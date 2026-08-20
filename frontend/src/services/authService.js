import api from './api';

/** Every auth-related call goes through here — no page talks to Axios directly. */
export const loginRequest = (credentials) => api.post('/auth/login', credentials);

export const fetchCurrentUser = () => api.get('/auth/me');

export const logoutRequest = () => api.post('/auth/logout');
