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

/**
 * Columns of the downloadable customer list.
 *
 * The single declaration of what leaves the system as a file, in the same shape
 * the report exports use, so `reportExcelService` renders it with the same
 * header style, frozen row, filters and column sizing.
 *
 * `code` means the cell is written as TEXT: CIFID, both mobiles and the pincode
 * must survive exactly as stored, or Excel strips a leading zero and turns a
 * ten-digit mobile into a number in scientific notation. `date` writes a real
 * date cell rather than a string.
 *
 * Deliberately absent: father's name, mother's name, marital status and
 * occupation. They exist on the customer, but a spreadsheet leaves the system's
 * access controls behind, so it carries only what the list itself shows plus
 * the address — not every personal detail on file. Nothing here is derived:
 * every path is a stored column.
 */
const CUSTOMER_EXPORT_COLUMNS = Object.freeze([
  { header: 'CIFID', path: 'cifId', type: 'code' },
  { header: 'First Name', path: 'firstName' },
  { header: 'Middle Name', path: 'middleName' },
  { header: 'Last Name', path: 'lastName' },
  { header: 'Full Name', path: 'fullName' },
  { header: 'Mobile', path: 'mobile', type: 'code' },
  { header: 'Alternate Mobile', path: 'alternateMobile', type: 'code' },
  { header: 'Email', path: 'email' },
  { header: 'Gender', path: 'gender' },
  { header: 'Date of Birth', path: 'dateOfBirth', type: 'date' },
  { header: 'Address Line 1', path: 'addressLine1' },
  { header: 'Address Line 2', path: 'addressLine2' },
  { header: 'City', path: 'city' },
  { header: 'State', path: 'state' },
  { header: 'Pincode', path: 'pincode', type: 'code' },
  { header: 'Status', path: 'status' },
  { header: 'Created Date', path: 'createdAt', type: 'date' }
]);

/** Only the columns above are read from the database. */
const CUSTOMER_EXPORT_ATTRIBUTES = Object.freeze(CUSTOMER_EXPORT_COLUMNS.map((column) => column.path));

const CUSTOMER_EXPORT_SHEET_TITLE = 'Customers';

/** LMS_Customers_2026-09-29.xlsx */
function customerExportFilename(date = new Date()) {
  return `LMS_Customers_${new Date(date).toISOString().slice(0, 10)}.xlsx`;
}

module.exports = {
  CUSTOMER_EXPORT_COLUMNS,
  CUSTOMER_EXPORT_ATTRIBUTES,
  CUSTOMER_EXPORT_SHEET_TITLE,
  customerExportFilename,
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
