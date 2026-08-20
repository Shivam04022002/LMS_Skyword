import axios from 'axios';
import { getStoredToken, clearStoredToken } from '../utils/storage';
import { normalizeApiError } from '../utils/errorHandler';

const baseURL = import.meta.env.VITE_API_URL;

if (!baseURL) {
  console.error('[api] VITE_API_URL is not set. Copy frontend/.env.example to frontend/.env.');
}

const api = axios.create({
  baseURL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' }
});

// Endpoints where a 401 is an expected answer rather than an expired session.
const AUTH_ENTRY_POINTS = ['/auth/login'];

let onUnauthorized = null;

/**
 * Lets the auth layer react to an expired/invalid token in one place.
 * Routing is left to the router: clearing the session makes the protected
 * routes redirect on their own, which avoids redirect loops.
 */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const status = error?.response?.status;
    const url = error?.config?.url ?? '';
    const isEntryPoint = AUTH_ENTRY_POINTS.some((path) => url.includes(path));

    if (status === 401 && !isEntryPoint) {
      clearStoredToken();
      if (onUnauthorized) onUnauthorized();
    }

    return Promise.reject(normalizeApiError(error));
  }
);

export default api;
