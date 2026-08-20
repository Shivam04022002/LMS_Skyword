'use strict';

const ApiError = require('../utils/ApiError');
const { PERMISSIONS } = require('../config/permissions');
const { LOAN_STATUS, READ_ONLY_STATUSES, FINANCIAL_FIELDS } = require('../config/loans');
const { AUDIT_ACTIONS } = require('../config/auditActions');

/**
 * The loan lifecycle, in one place.
 *
 *   DRAFT  ──► ACTIVE      terms are fixed from here on
 *   DRAFT  ──► CANCELLED
 *   ACTIVE ──► CLOSED      repaid or settled
 *   ACTIVE ──► CANCELLED   supported, and gated behind loans.cancel
 *   CLOSED / CANCELLED     terminal, no transitions out
 *
 * Any status not listed as a target is refused, so a request cannot set an
 * arbitrary status string.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [LOAN_STATUS.DRAFT]: [LOAN_STATUS.ACTIVE, LOAN_STATUS.CANCELLED],
  [LOAN_STATUS.ACTIVE]: [LOAN_STATUS.CLOSED, LOAN_STATUS.CANCELLED],
  [LOAN_STATUS.CLOSED]: [],
  [LOAN_STATUS.CANCELLED]: []
});

/** Each transition carries its own permission and audit action. */
const TRANSITION_RULES = Object.freeze({
  [LOAN_STATUS.ACTIVE]: { permission: PERMISSIONS.LOANS_ACTIVATE, action: AUDIT_ACTIONS.LOAN_ACTIVATED },
  [LOAN_STATUS.CLOSED]: { permission: PERMISSIONS.LOANS_CLOSE, action: AUDIT_ACTIONS.LOAN_CLOSED },
  [LOAN_STATUS.CANCELLED]: { permission: PERMISSIONS.LOANS_CANCEL, action: AUDIT_ACTIONS.LOAN_CANCELLED }
});

const canTransition = (from, to) => (ALLOWED_TRANSITIONS[from] ?? []).includes(to);

/** Throws unless the transition is part of the defined lifecycle. */
function assertTransitionAllowed(from, to) {
  if (from === to) {
    throw ApiError.conflict(`This loan is already ${to}`);
  }

  if (!canTransition(from, to)) {
    const allowed = ALLOWED_TRANSITIONS[from] ?? [];
    throw ApiError.conflict(
      allowed.length === 0
        ? `A ${from} loan is final and cannot change status`
        : `A ${from} loan can only move to: ${allowed.join(', ')}`
    );
  }
}

/** Permission required to perform a given transition. */
function permissionForTransition(to) {
  return TRANSITION_RULES[to]?.permission ?? null;
}

/** Audit action recorded for a given transition. */
function auditActionForTransition(to) {
  return TRANSITION_RULES[to]?.action ?? AUDIT_ACTIONS.LOAN_UPDATED;
}

/**
 * Guards edits by status.
 *   DRAFT              — terms may be revised
 *   ACTIVE             — terms are fixed; a correction needs a future
 *                        controlled amendment workflow, not a silent edit
 *   CLOSED / CANCELLED — read-only
 */
function assertEditable(loan, requestedFields = []) {
  if (READ_ONLY_STATUSES.includes(loan.status)) {
    throw ApiError.conflict(`A ${loan.status} loan is read-only and cannot be modified`);
  }

  if (loan.status === LOAN_STATUS.ACTIVE) {
    const financial = requestedFields.filter((field) => FINANCIAL_FIELDS.includes(field));
    if (financial.length > 0) {
      throw ApiError.conflict(
        `An ACTIVE loan's terms are fixed — ${financial.join(', ')} cannot be changed. Cancel the loan or use a controlled amendment.`
      );
    }
  }
}

/** Parties may only be changed while the loan is still a draft. */
function assertPartiesEditable(loan) {
  if (loan.status !== LOAN_STATUS.DRAFT) {
    throw ApiError.conflict(`Parties can only be changed while a loan is DRAFT (this loan is ${loan.status})`);
  }
}

module.exports = {
  ALLOWED_TRANSITIONS,
  TRANSITION_RULES,
  canTransition,
  assertTransitionAllowed,
  permissionForTransition,
  auditActionForTransition,
  assertEditable,
  assertPartiesEditable
};
