'use strict';

/**
 * Customer module constants.
 *
 * CIFID format: "C" followed by a zero-padded six-digit number — C000001.
 * The brief's overview showed five digits (C00001) while its CIF-generation
 * section mandated six; six is authoritative, and no earlier phase had
 * established a format, so nothing is being changed silently.
 */
const CIF_PREFIX = 'C';
const CIF_NUMBER_LENGTH = 6;

/** Name of the counter row in `cif_sequences`. */
const CIF_SEQUENCE_NAME = 'CUSTOMER';

/** C000001 — never derived from a timestamp, random value or UUID. */
function formatCifId(sequenceNumber) {
  return `${CIF_PREFIX}${String(sequenceNumber).padStart(CIF_NUMBER_LENGTH, '0')}`;
}

const CIF_ID_PATTERN = new RegExp(`^${CIF_PREFIX}\\d{${CIF_NUMBER_LENGTH}}$`);

const isValidCifId = (value) => typeof value === 'string' && CIF_ID_PATTERN.test(value);

const CUSTOMER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE'
});

const CUSTOMER_STATUS_VALUES = Object.values(CUSTOMER_STATUS);

const GENDERS = Object.freeze({
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  OTHER: 'OTHER'
});

const GENDER_VALUES = Object.values(GENDERS);

const MARITAL_STATUSES = Object.freeze({
  SINGLE: 'SINGLE',
  MARRIED: 'MARRIED',
  DIVORCED: 'DIVORCED',
  WIDOWED: 'WIDOWED'
});

const MARITAL_STATUS_VALUES = Object.values(MARITAL_STATUSES);

module.exports = {
  CIF_PREFIX,
  CIF_NUMBER_LENGTH,
  CIF_SEQUENCE_NAME,
  CIF_ID_PATTERN,
  formatCifId,
  isValidCifId,
  CUSTOMER_STATUS,
  CUSTOMER_STATUS_VALUES,
  GENDERS,
  GENDER_VALUES,
  MARITAL_STATUSES,
  MARITAL_STATUS_VALUES
};
