const TOKEN_KEY = 'lms.auth.token';

/**
 * Single place that knows where the JWT lives, so the storage strategy can be
 * changed later without touching the rest of the app.
 */
export function getStoredToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode) — the in-memory session still works */
  }
}

export function clearStoredToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clean up */
  }
}
