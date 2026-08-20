/**
 * Today as YYYY-MM-DD, for date input defaults and max attributes.
 *
 * Display convenience only — the backend uses its own server-side date when it
 * validates that a collection is not future-dated, so the browser clock is never
 * authoritative.
 */
export function today(clock = new Date()) {
  const year = clock.getFullYear();
  const month = String(clock.getMonth() + 1).padStart(2, '0');
  const day = String(clock.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default today;
