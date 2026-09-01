'use strict';

const { Collection, LoanRoute } = require('../models');
const ApiError = require('../utils/ApiError');
const reportService = require('./reportService');
const routeService = require('./routeService');
const { toPaise, fromPaise } = require('../utils/money');
const { COLLECTION_STATUS, DEFAULT_BOUNCE_AMOUNT } = require('../config/collections');
const { ASSIGNMENT_STATUS } = require('../config/routes');
const { ORGANISATION_NAME } = require('../config/organisation');

/**
 * Collection receipt.
 *
 * A read-only view of one existing collection — it stores nothing, changes
 * nothing and creates no ledger. Amounts are read from the collection and its
 * allocations exactly as posted.
 *
 * A REVERSED collection still yields a receipt, because the document is part of
 * the audit trail, but it is explicitly marked as reversed and reports itself as
 * not a valid proof of payment.
 */

const DETAIL_INCLUDE = [
  { association: 'Loan', attributes: ['id', 'loanNumber', 'status', 'loanAmount', 'loanType'] },
  { association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile', 'email'] },
  { association: 'CreatedBy', attributes: ['id', 'name'] },
  { association: 'UpdatedBy', attributes: ['id', 'name'] },
  { association: 'Allocations', include: [{ association: 'Emi' }] }
];

async function getReceipt(collectionId, actor, { organisationName = ORGANISATION_NAME } = {}) {
  const collection = await Collection.findByPk(collectionId, { include: DETAIL_INCLUDE });

  if (!collection) {
    throw ApiError.notFound('Collection not found');
  }

  // A collector may only view receipts inside their own scope. Checked before
  // anything is returned, so a receipt cannot be used to read another
  // collector's data by id.
  if (routeService.isScopedActor(actor)) {
    const ownRouteIds = await routeService.activeRouteIdsForCollector(actor.id);
    const onOwnRoute = await LoanRoute.findOne({
      where: { loanId: collection.loanId, routeId: ownRouteIds, status: ASSIGNMENT_STATUS.ACTIVE }
    });
    const postedByActor = Number(collection.createdBy) === Number(actor.id);

    if (!onOwnRoute && !postedByActor) {
      throw ApiError.forbidden('This collection is outside the routes you are assigned to');
    }
  }

  const isReversed = collection.status === COLLECTION_STATUS.REVERSED;

  const allocations = (collection.Allocations ?? []).map((allocation) => ({
    id: allocation.id,
    allocatedAmount: allocation.allocatedAmount,
    emiNumber: allocation.Emi?.emiNumber ?? null,
    emiDate: allocation.Emi?.emiDate ?? null,
    emiAmount: allocation.Emi?.emiAmount ?? null
  }));

  const allocatedPaise = allocations.reduce((total, allocation) => total + toPaise(allocation.allocatedAmount), 0n);
  const amountPaise = toPaise(collection.amount);
  // The part of the amount received against a bounce charge rather than an
  // instalment, so it is never in `allocations` above.
  const bouncePaise = toPaise(collection.bounceAmount ?? DEFAULT_BOUNCE_AMOUNT);

  const route = await LoanRoute.findOne({
    where: { loanId: collection.loanId, status: ASSIGNMENT_STATUS.ACTIVE },
    include: [{ association: 'Route', attributes: ['id', 'routeCode', 'name'] }]
  });

  return {
    organisationName,
    title: isReversed ? 'Collection Receipt (REVERSED)' : 'Collection Receipt',
    // The moment the document was produced — distinct from the collection date.
    generatedAt: new Date().toISOString(),

    collection: {
      id: collection.id,
      collectionNumber: collection.collectionNumber,
      collectionDate: collection.collectionDate,
      amount: collection.amount,
      // The two halves of that amount, so the document shows the customer what
      // their money was taken for.
      emiCollected: fromPaise(amountPaise - bouncePaise),
      bounceCollected: fromPaise(bouncePaise),
      ledgerType: collection.ledgerType,
      paymentReference: collection.paymentReference,
      notes: collection.notes,
      status: collection.status
    },

    customer: collection.Customer
      ? {
          id: collection.Customer.id,
          cifId: collection.Customer.cifId,
          fullName: collection.Customer.fullName,
          mobile: collection.Customer.mobile,
          email: collection.Customer.email
        }
      : null,

    loan: collection.Loan
      ? { id: collection.Loan.id, loanNumber: collection.Loan.loanNumber, status: collection.Loan.status, loanType: collection.Loan.loanType }
      : null,

    route: route?.Route ? { id: route.Route.id, routeCode: route.Route.routeCode, name: route.Route.name } : null,

    allocations,

    totals: {
      collectionAmount: collection.amount,
      allocatedAmount: fromPaise(allocatedPaise),
      bounceAmount: fromPaise(bouncePaise),
      /*
       * The reconciliation the whole design rests on:
       *
       *     collection amount = allocated to instalments + bounce collected
       *
       * Posting enforces it, so the document can display it as a check rather
       * than assume it. For every collection posted without a bounce component
       * — which is every collection before this feature — bounce is 0.00 and
       * this is the allocated-equals-amount check it has always been.
       */
      reconciles: allocatedPaise + bouncePaise === amountPaise,
      unallocated: fromPaise(amountPaise - allocatedPaise - bouncePaise)
    },

    /**
     * Validity block — the receipt states plainly whether it evidences money
     * that currently counts.
     */
    validity: {
      isValidPayment: !isReversed,
      status: collection.status,
      reversed: isReversed,
      notice: isReversed
        ? 'This collection was REVERSED. Its payment effect has been removed from the affected instalments and it does not count towards any balance. This document is retained for historical reference only and is not a valid receipt of payment.'
        : null
    },

    system: {
      createdBy: collection.CreatedBy?.name ?? null,
      createdAt: collection.createdAt,
      updatedBy: collection.UpdatedBy?.name ?? null,
      updatedAt: collection.updatedAt
    }
  };
}

module.exports = { getReceipt };
