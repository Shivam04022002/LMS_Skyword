/** Mirrors backend/src/config/loanParties.js. */
export const PARTY_ROLES = Object.freeze({
  APPLICANT: 'APPLICANT',
  CO_APPLICANT: 'CO_APPLICANT',
  GUARANTOR: 'GUARANTOR'
});

export const PARTY_ROLE_VALUES = Object.values(PARTY_ROLES);

export const PARTY_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  REMOVED: 'REMOVED'
});

/** Display labels — CO_APPLICANT reads as "Co-Applicant", not "Co Applicant". */
export const PARTY_ROLE_LABELS = Object.freeze({
  APPLICANT: 'Applicant',
  CO_APPLICANT: 'Co-Applicant',
  GUARANTOR: 'Guarantor'
});

export const partyRoleLabel = (role) => PARTY_ROLE_LABELS[role] ?? role ?? '';
