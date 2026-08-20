'use strict';

/**
 * Loan party constants.
 *
 * A customer is not permanently an applicant, co-applicant or guarantor. The
 * role exists only in the context of one loan, so it lives on the relationship
 * row rather than on the customer.
 */
const PARTY_ROLES = Object.freeze({
  APPLICANT: 'APPLICANT',
  CO_APPLICANT: 'CO_APPLICANT',
  GUARANTOR: 'GUARANTOR'
});

const PARTY_ROLE_VALUES = Object.values(PARTY_ROLES);

/**
 * Parties are soft-removed, never deleted: a loan's participant history has to
 * stay readable after someone is taken off it.
 */
const PARTY_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  REMOVED: 'REMOVED'
});

const PARTY_STATUS_VALUES = Object.values(PARTY_STATUS);

/** Exactly one applicant per loan; co-applicants and guarantors are unbounded. */
const ROLE_CARDINALITY = Object.freeze({
  [PARTY_ROLES.APPLICANT]: { min: 1, max: 1 },
  [PARTY_ROLES.CO_APPLICANT]: { min: 0, max: null },
  [PARTY_ROLES.GUARANTOR]: { min: 0, max: null }
});

/** `is_primary` is derived from the role, never supplied by a client. */
const isPrimaryRole = (partyRole) => partyRole === PARTY_ROLES.APPLICANT;

module.exports = {
  PARTY_ROLES,
  PARTY_ROLE_VALUES,
  PARTY_STATUS,
  PARTY_STATUS_VALUES,
  ROLE_CARDINALITY,
  isPrimaryRole
};
