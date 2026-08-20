'use strict';

const models = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const { PARTY_ROLES, PARTY_STATUS, isPrimaryRole } = require('../config/loanParties');
const { CUSTOMER_STATUS } = require('../config/customers');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

const { sequelize, LoanParty, Customer } = models;

const PARTY_INCLUDE = [
  { association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile', 'status'] },
  { association: 'CreatedBy', attributes: ['id', 'name'] },
  { association: 'UpdatedBy', attributes: ['id', 'name'] }
];

/**
 * The loans table arrives in Phase 5. Until the Loan model is registered there
 * is nothing to validate a loanId against, and silently accepting any number
 * would let parties attach to loans that do not exist. Rather than pretend, the
 * capability reports itself as unavailable; the moment Phase 5 registers a Loan
 * model this function starts validating for real, with no other change.
 */
async function assertLoanExists(loanId, transaction) {
  if (!models.Loan) {
    throw new ApiError(
      503,
      'Loan management is not available yet. Loan parties can be managed once the loan module (Phase 5) is installed.'
    );
  }

  const loan = await models.Loan.findByPk(loanId, { transaction });
  if (!loan) {
    throw ApiError.notFound('Loan not found');
  }
  return loan;
}

/** Resolves either a numeric customerId or a CIFID to a customer row. */
async function resolveCustomer({ customerId, cifId }, transaction) {
  const where = customerId ? { id: customerId } : { cifId: String(cifId).toUpperCase() };
  const customer = await Customer.findOne({ where, transaction });

  if (!customer) {
    // Never auto-create: the customer register is the only place customers are born.
    throw ApiError.notFound('Customer not found');
  }

  return customer;
}

/** New relationships require an active customer; historical ones stay readable. */
function assertCustomerAssignable(customer) {
  if (customer.status === CUSTOMER_STATUS.INACTIVE) {
    throw ApiError.conflict(`Customer ${customer.cifId} is inactive and cannot be added to a loan`);
  }
}

async function findPartyOrFail(loanId, partyId, transaction, lock = false) {
  const party = await LoanParty.findOne({
    where: { id: partyId, loanId },
    include: transaction ? undefined : PARTY_INCLUDE,
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {})
  });

  if (!party) {
    throw ApiError.notFound('Loan party not found');
  }

  return party;
}

/** GET — all parties on a loan, ordered applicant first. */
async function listParties(loanId, { includeRemoved = false } = {}) {
  await assertLoanExists(loanId);

  const where = { loanId };
  if (!includeRemoved) {
    where.status = PARTY_STATUS.ACTIVE;
  }

  const parties = await LoanParty.findAll({
    where,
    include: PARTY_INCLUDE,
    order: [
      ['isPrimary', 'DESC'],
      ['partyRole', 'ASC'],
      ['id', 'ASC']
    ]
  });

  const active = parties.filter((party) => party.status === PARTY_STATUS.ACTIVE);

  return {
    parties: parties.map((party) => party.toPublicJSON()),
    summary: {
      applicant: active.filter((party) => party.partyRole === PARTY_ROLES.APPLICANT).length,
      coApplicants: active.filter((party) => party.partyRole === PARTY_ROLES.CO_APPLICANT).length,
      guarantors: active.filter((party) => party.partyRole === PARTY_ROLES.GUARANTOR).length
    }
  };
}

/**
 * Attaches a customer to a loan.
 *
 * Runs inside a transaction with the loan's existing party rows locked, so two
 * simultaneous requests cannot both pass the "no applicant yet" check. The
 * unique index on the generated applicant key is the database-level backstop.
 */
async function addParty(loanId, { customerId, cifId, partyRole }, actor, context) {
  const result = await sequelize.transaction(async (transaction) => {
    await assertLoanExists(loanId, transaction);

    const customer = await resolveCustomer({ customerId, cifId }, transaction);
    assertCustomerAssignable(customer);

    // Locks this loan's parties for the rest of the transaction.
    const existing = await LoanParty.findAll({
      where: { loanId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    // One customer holds at most one role per loan.
    const duplicate = existing.find(
      (party) => party.customerId === customer.id && party.status === PARTY_STATUS.ACTIVE
    );
    if (duplicate) {
      throw ApiError.conflict(
        `Customer ${customer.cifId} is already attached to this loan as ${duplicate.partyRole}`
      );
    }

    if (partyRole === PARTY_ROLES.APPLICANT) {
      const currentApplicant = existing.find(
        (party) => party.partyRole === PARTY_ROLES.APPLICANT && party.status === PARTY_STATUS.ACTIVE
      );
      if (currentApplicant) {
        throw ApiError.conflict('This loan already has an applicant. Swap or remove the current applicant first.');
      }
    }

    // A previously removed party is reactivated rather than duplicated, which
    // keeps UNIQUE(loan_id, customer_id) intact and preserves history.
    const removed = existing.find(
      (party) => party.customerId === customer.id && party.status === PARTY_STATUS.REMOVED
    );

    if (removed) {
      await removed.update(
        { partyRole, isPrimary: isPrimaryRole(partyRole), status: PARTY_STATUS.ACTIVE, updatedBy: actor.id },
        { transaction }
      );
      return { party: removed, customer, reactivated: true };
    }

    const party = await LoanParty.create(
      {
        loanId,
        customerId: customer.id,
        partyRole,
        isPrimary: isPrimaryRole(partyRole),
        status: PARTY_STATUS.ACTIVE,
        createdBy: actor.id,
        updatedBy: actor.id
      },
      { transaction }
    );

    return { party, customer, reactivated: false };
  });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.PARTY_ADDED,
    entity: AUDIT_ENTITIES.LOAN_PARTY,
    entityId: result.party.id,
    details: {
      loanId,
      cifId: result.customer.cifId,
      partyRole,
      reactivated: result.reactivated
    }
  });

  const party = await findPartyOrFail(loanId, result.party.id);
  return party.toPublicJSON();
}

/** Changes a party's role, re-applying every rule that governs a new party. */
async function updateParty(loanId, partyId, { partyRole }, actor, context) {
  const outcome = await sequelize.transaction(async (transaction) => {
    await assertLoanExists(loanId, transaction);

    const party = await findPartyOrFail(loanId, partyId, transaction, true);

    if (party.status !== PARTY_STATUS.ACTIVE) {
      throw ApiError.conflict('This party has been removed from the loan and cannot be edited');
    }

    const previousRole = party.partyRole;
    if (previousRole === partyRole) {
      return { party, previousRole, changed: false };
    }

    if (partyRole === PARTY_ROLES.APPLICANT) {
      const currentApplicant = await LoanParty.findOne({
        where: { loanId, partyRole: PARTY_ROLES.APPLICANT, status: PARTY_STATUS.ACTIVE },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (currentApplicant && currentApplicant.id !== party.id) {
        throw ApiError.conflict('This loan already has an applicant. Use the swap operation instead.');
      }
    }

    if (previousRole === PARTY_ROLES.APPLICANT) {
      throw ApiError.conflict(
        'The applicant cannot be demoted directly, which would leave the loan without one. Use the swap operation.'
      );
    }

    await party.update({ partyRole, isPrimary: isPrimaryRole(partyRole), updatedBy: actor.id }, { transaction });

    return { party, previousRole, changed: true };
  });

  if (outcome.changed) {
    await auditService.record({
      ...context,
      action: AUDIT_ACTIONS.PARTY_UPDATED,
      entity: AUDIT_ENTITIES.LOAN_PARTY,
      entityId: outcome.party.id,
      details: { loanId, from: outcome.previousRole, to: partyRole }
    });
  }

  const party = await findPartyOrFail(loanId, partyId);
  return party.toPublicJSON();
}

/**
 * Soft removal. The row is retained so the loan's participant history stays
 * readable; there is no hard delete anywhere in this module.
 */
async function changePartyStatus(loanId, partyId, status, actor, context) {
  const outcome = await sequelize.transaction(async (transaction) => {
    await assertLoanExists(loanId, transaction);

    const party = await findPartyOrFail(loanId, partyId, transaction, true);

    if (party.status === status) {
      return { party, changed: false };
    }

    if (status === PARTY_STATUS.REMOVED && party.partyRole === PARTY_ROLES.APPLICANT) {
      throw ApiError.conflict(
        'The applicant cannot be removed, which would leave the loan without one. Swap in another applicant first.'
      );
    }

    if (status === PARTY_STATUS.ACTIVE) {
      const customer = await Customer.findByPk(party.customerId, { transaction });
      assertCustomerAssignable(customer);
    }

    await party.update({ status, updatedBy: actor.id }, { transaction });

    return { party, changed: true };
  });

  if (outcome.changed) {
    await auditService.record({
      ...context,
      action: AUDIT_ACTIONS.PARTY_REMOVED,
      entity: AUDIT_ENTITIES.LOAN_PARTY,
      entityId: outcome.party.id,
      details: { loanId, status, partyRole: outcome.party.partyRole }
    });
  }

  const party = await findPartyOrFail(loanId, partyId);
  return party.toPublicJSON();
}

/**
 * Swaps the applicant with one co-applicant, atomically.
 *
 * Order matters: the applicant is demoted first, so the loan passes briefly
 * through zero applicants rather than two. Two applicants would violate the
 * unique index on the generated applicant key and abort the transaction. The
 * whole exchange is one transaction, so no other session ever observes the
 * intermediate state, and any failure rolls back to the original roles.
 */
async function swapApplicantAndCoApplicant(loanId, { coApplicantPartyId }, actor, context) {
  const outcome = await sequelize.transaction(async (transaction) => {
    await assertLoanExists(loanId, transaction);

    const parties = await LoanParty.findAll({
      where: { loanId, status: PARTY_STATUS.ACTIVE },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    const applicant = parties.find((party) => party.partyRole === PARTY_ROLES.APPLICANT);
    if (!applicant) {
      throw ApiError.conflict('This loan has no applicant to swap');
    }

    const coApplicants = parties.filter((party) => party.partyRole === PARTY_ROLES.CO_APPLICANT);
    if (coApplicants.length === 0) {
      throw ApiError.conflict('This loan has no co-applicant to swap with');
    }

    let coApplicant;
    if (coApplicantPartyId) {
      coApplicant = coApplicants.find((party) => party.id === Number(coApplicantPartyId));
      if (!coApplicant) {
        throw ApiError.notFound('That co-applicant is not on this loan');
      }
    } else if (coApplicants.length > 1) {
      throw ApiError.badRequest('This loan has several co-applicants — specify which one to promote');
    } else {
      [coApplicant] = coApplicants;
    }

    const [applicantCustomer, coApplicantCustomer] = await Promise.all([
      Customer.findByPk(applicant.customerId, { transaction }),
      Customer.findByPk(coApplicant.customerId, { transaction })
    ]);

    // The incoming applicant must be someone who may currently hold a role.
    assertCustomerAssignable(coApplicantCustomer);

    // Demote first: zero applicants is a legal intermediate state, two is not.
    await applicant.update(
      { partyRole: PARTY_ROLES.CO_APPLICANT, isPrimary: false, updatedBy: actor.id },
      { transaction }
    );
    await coApplicant.update(
      { partyRole: PARTY_ROLES.APPLICANT, isPrimary: true, updatedBy: actor.id },
      { transaction }
    );

    return {
      oldApplicantCif: applicantCustomer?.cifId ?? null,
      oldCoApplicantCif: coApplicantCustomer?.cifId ?? null,
      applicantPartyId: applicant.id,
      coApplicantPartyId: coApplicant.id
    };
  });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.APPLICANT_COAPPLICANT_SWAPPED,
    entity: AUDIT_ENTITIES.LOAN_PARTY,
    entityId: outcome.coApplicantPartyId,
    details: {
      loanId,
      oldApplicantCif: outcome.oldApplicantCif,
      oldCoApplicantCif: outcome.oldCoApplicantCif,
      newApplicantCif: outcome.oldCoApplicantCif,
      newCoApplicantCif: outcome.oldApplicantCif
    }
  });

  return listParties(loanId);
}

module.exports = {
  listParties,
  addParty,
  updateParty,
  changePartyStatus,
  swapApplicantAndCoApplicant,
  assertLoanExists,
  assertCustomerAssignable,
  resolveCustomer
};
