/** Mirrors backend/src/config/roles.js. */
export const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  COLLECTOR: 'COLLECTOR',
  STAFF: 'STAFF'
});

/**
 * The organisation this system belongs to.
 *
 * Mirrors backend/src/config/organisation.js, which is the same string the
 * printed receipt carries — the two must stay identical.
 *
 * Not environment-driven on purpose: a company name is branding, not
 * configuration, and an env override is exactly how the old placeholder
 * survived a code change once already.
 *
 * Name only. No address, registration number or contact detail belongs here.
 */
export const ORGANISATION_NAME = 'SKYWORD INDIA MICRO CREDIT FOUNDAITION';

/** Human-readable label for a role code. */
export const formatRole = (role) =>
  typeof role === 'string' ? role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '';
