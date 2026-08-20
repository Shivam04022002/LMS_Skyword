'use strict';

/**
 * Indian mobile numbers are stored in one canonical form: ten digits, no
 * country code, no separators (e.g. 9876543210). Input is normalised before
 * storage so the same subscriber never appears in two representations.
 */

const INDIAN_MOBILE_PATTERN = /^[6-9]\d{9}$/;

/**
 * Accepts the formats users actually type — "+91 98765 43210", "091-9876543210",
 * "09876543210" — and reduces them to ten digits. Returns null when the input
 * cannot be reduced to a plausible number, so callers can reject it.
 */
function normalizeMobile(value) {
  if (value === null || value === undefined) return null;

  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;

  let local = digits;

  // Strip the international dialling prefix (0091 → 91), then the country code,
  // then a domestic trunk prefix.
  if (local.length > 12 && local.startsWith('00')) {
    local = local.slice(2);
  }
  if (local.length === 13 && local.startsWith('091')) {
    local = local.slice(3);
  } else if (local.length === 12 && local.startsWith('91')) {
    local = local.slice(2);
  } else if (local.length === 11 && local.startsWith('0')) {
    local = local.slice(1);
  }

  return local.length === 10 ? local : null;
}

/** True when the value normalises to a valid Indian mobile number. */
function isValidMobile(value) {
  const normalized = normalizeMobile(value);
  return normalized !== null && INDIAN_MOBILE_PATTERN.test(normalized);
}

module.exports = { normalizeMobile, isValidMobile, INDIAN_MOBILE_PATTERN };
