'use strict';

/**
 * Role foundation for the LMS.
 * Phase 1 only establishes the constants and the middleware that consumes them;
 * per-permission management arrives in a later phase.
 */
const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  COLLECTOR: 'COLLECTOR',
  STAFF: 'STAFF'
});

const ROLE_VALUES = Object.values(ROLES);

const USER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE'
});

const USER_STATUS_VALUES = Object.values(USER_STATUS);

module.exports = { ROLES, ROLE_VALUES, USER_STATUS, USER_STATUS_VALUES };
