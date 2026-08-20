/**
 * Client-side mirror of backend/src/utils/mobile.js, used only for immediate
 * form feedback. The backend normalises and re-validates before storage.
 */
const INDIAN_MOBILE_PATTERN = /^[6-9]\d{9}$/;

export function normalizeMobile(value) {
  if (value === null || value === undefined) return null;

  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;

  let local = digits;
  if (local.length > 12 && local.startsWith('00')) local = local.slice(2);
  if (local.length === 13 && local.startsWith('091')) local = local.slice(3);
  else if (local.length === 12 && local.startsWith('91')) local = local.slice(2);
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1);

  return local.length === 10 ? local : null;
}

export function isValidMobile(value) {
  const normalized = normalizeMobile(value);
  return normalized !== null && INDIAN_MOBILE_PATTERN.test(normalized);
}
