/** Mirrors backend/src/config/collections.js. */
export const LEDGER_TYPES = ['CASH', 'BANK'];

export const COLLECTION_STATUSES = ['POSTED', 'REVERSED'];

/** A bank transfer must carry a reference; cash need not. */
export const LEDGER_TYPES_REQUIRING_REFERENCE = ['BANK'];

export const requiresPaymentReference = (ledgerType) => LEDGER_TYPES_REQUIRING_REFERENCE.includes(ledgerType);

export const COLLECTION_STATUS_VARIANTS = Object.freeze({
  POSTED: 'text-bg-success',
  REVERSED: 'text-bg-danger'
});

export const LEDGER_ICONS = Object.freeze({
  CASH: 'bi-cash-stack',
  BANK: 'bi-bank'
});
