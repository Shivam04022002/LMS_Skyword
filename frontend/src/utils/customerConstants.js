/** Mirrors backend/src/config/customers.js. */
export const CUSTOMER_STATUSES = ['ACTIVE', 'INACTIVE'];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'];

export const MARITAL_STATUSES = ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'];

/** MARRIED -> Married, CO_APPLICANT -> Co Applicant. */
export const titleCase = (value) =>
  typeof value === 'string' ? value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '';
