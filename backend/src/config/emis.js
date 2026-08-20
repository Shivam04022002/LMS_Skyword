'use strict';

/**
 * EMI schedule constants.
 *
 * Status is derived from the instalment's date, its collected amount and any
 * explicit waiver — a client never sets it directly.
 */
const EMI_STATUS = Object.freeze({
  /** Future instalment, not yet due. */
  PENDING: 'PENDING',
  /** Due today, nothing collected. */
  DUE: 'DUE',
  /** Something collected, but less than the instalment. */
  PARTIAL: 'PARTIAL',
  /** Collected in full. */
  PAID: 'PAID',
  /** Date passed, nothing collected. */
  OVERDUE: 'OVERDUE',
  /** Written off by an authorised workflow. */
  WAIVED: 'WAIVED'
});

const EMI_STATUS_VALUES = Object.values(EMI_STATUS);

/**
 * Statuses that stop being recomputed from dates and amounts.
 * A waiver is a decision, not a derivation.
 */
const TERMINAL_EMI_STATUSES = Object.freeze([EMI_STATUS.WAIVED]);

/** Statuses that still owe money, and therefore can accrue DPD. */
const OUTSTANDING_EMI_STATUSES = Object.freeze([
  EMI_STATUS.PENDING,
  EMI_STATUS.DUE,
  EMI_STATUS.PARTIAL,
  EMI_STATUS.OVERDUE
]);

/**
 * Bounce charge — a fee an operator records against one instalment by hand.
 *
 * It is NOT part of the instalment. It does not enter emiAmount, principal,
 * interest, amountCollected, outstanding, DPD, status or any allocation, and
 * nothing derives it: the only way it changes is an authorised person typing a
 * number. Stored beside the instalment purely so it can be recorded and read
 * back per instalment.
 *
 * The ceiling exists so a typo cannot overflow DECIMAL(15,2); it is not a
 * business rule about what a bank may charge.
 */
const MAX_BOUNCE_CHARGE = '9999999.99';

/** Every instalment starts with no charge recorded. */
const DEFAULT_BOUNCE_CHARGE = '0.00';

module.exports = {
  EMI_STATUS,
  EMI_STATUS_VALUES,
  TERMINAL_EMI_STATUSES,
  OUTSTANDING_EMI_STATUSES,
  MAX_BOUNCE_CHARGE,
  DEFAULT_BOUNCE_CHARGE
};
