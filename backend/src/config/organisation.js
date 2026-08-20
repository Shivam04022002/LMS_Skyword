'use strict';

/**
 * The organisation the system belongs to.
 *
 * Held here rather than typed into a document template so every printed or
 * exported artifact names the company identically, and a rename is one edit.
 *
 * Only the name is stored. No address, registration number, tax identifier or
 * contact detail is kept here: those are legal particulars, and inventing or
 * guessing them on a financial document would be worse than omitting them.
 */
const ORGANISATION_NAME = 'SKYWORD INDIA MICRO CREDIT FOUNDAITION';

module.exports = { ORGANISATION_NAME };
