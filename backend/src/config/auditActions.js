'use strict';

/**
 * Audit action vocabulary. Later phases append their own actions (LOAN_CREATED,
 * COLLECTION_RECORDED, ...) without changing the audit_logs schema.
 */
const AUDIT_ACTIONS = Object.freeze({
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_ACTIVATED: 'USER_ACTIVATED',
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  ROLE_PERMISSIONS_UPDATED: 'ROLE_PERMISSIONS_UPDATED',
  CUSTOMER_CREATED: 'CUSTOMER_CREATED',
  CUSTOMER_UPDATED: 'CUSTOMER_UPDATED',
  CUSTOMER_ACTIVATED: 'CUSTOMER_ACTIVATED',
  CUSTOMER_DEACTIVATED: 'CUSTOMER_DEACTIVATED',
  /* One row per bulk import, carrying the counts and the CIFIDs it created —
     never the uploaded file. */
  CUSTOMERS_IMPORTED: 'CUSTOMERS_IMPORTED',
  /* One row per bulk loan import, carrying the counts and the loan numbers it
     created — never the uploaded file. */
  LOANS_IMPORTED: 'LOANS_IMPORTED',
  /* One row per bulk collection import, carrying the counts and the collection
     numbers it created — never the uploaded file. */
  COLLECTIONS_IMPORTED: 'COLLECTIONS_IMPORTED',
  PARTY_ADDED: 'PARTY_ADDED',
  PARTY_UPDATED: 'PARTY_UPDATED',
  PARTY_REMOVED: 'PARTY_REMOVED',
  APPLICANT_COAPPLICANT_SWAPPED: 'APPLICANT_COAPPLICANT_SWAPPED',
  LOAN_CREATED: 'LOAN_CREATED',
  LOAN_UPDATED: 'LOAN_UPDATED',
  LOAN_ACTIVATED: 'LOAN_ACTIVATED',
  LOAN_CLOSED: 'LOAN_CLOSED',
  LOAN_CANCELLED: 'LOAN_CANCELLED',
  EMI_SCHEDULE_GENERATED: 'EMI_SCHEDULE_GENERATED',
  // Recorded by the DPD/status snapshot recalculation. There is deliberately no
  // EMI_SCHEDULE_REGENERATED: a schedule is financial history and is never
  // rebuilt, so that vocabulary would describe something the system cannot do.
  EMI_UPDATED: 'EMI_UPDATED',
  // A bounce charge is typed in by a person, not derived, so every change to it
  // is recorded with the value before and after.
  EMI_BOUNCE_CHARGE_UPDATED: 'EMI_BOUNCE_CHARGE_UPDATED',
  COLLECTION_CREATED: 'COLLECTION_CREATED',
  COLLECTION_REVERSED: 'COLLECTION_REVERSED',
  ROUTE_CREATED: 'ROUTE_CREATED',
  ROUTE_UPDATED: 'ROUTE_UPDATED',
  ROUTE_STATUS_CHANGED: 'ROUTE_STATUS_CHANGED',
  // Covers both collector→route and loan→route assignment, distinguished by the
  // `assignmentType` detail. Unassignment is a separate action so the trail
  // reads plainly.
  ROUTE_ASSIGNED: 'ROUTE_ASSIGNED',
  ROUTE_UNASSIGNED: 'ROUTE_UNASSIGNED',
  // Viewing a report is not audited — it is read-only and would drown the trail.
  // An export is, because it produces a data artifact that leaves the system.
  REPORT_EXPORTED: 'REPORT_EXPORTED'
});

const AUDIT_ENTITIES = Object.freeze({
  USER: 'USER',
  ROLE: 'ROLE',
  CUSTOMER: 'CUSTOMER',
  LOAN_PARTY: 'LOAN_PARTY',
  LOAN: 'LOAN',
  EMI_SCHEDULE: 'EMI_SCHEDULE',
  COLLECTION: 'COLLECTION',
  ROUTE: 'ROUTE',
  REPORT: 'REPORT'
});

module.exports = { AUDIT_ACTIONS, AUDIT_ENTITIES };
