'use strict';

/**
 * The bounce component of a collection — money a customer ACTUALLY paid against
 * a bounce charge, as part of (or as the whole of) one collection.
 *
 * `collections.amount` keeps its existing meaning: the TOTAL received in that
 * transaction. This column says how much of that total was bounce rather than
 * instalment, which makes the standing rule explicit:
 *
 *     amount = SUM(collection_allocations.allocated_amount) + bounce_amount
 *
 * Before this column existed every collection was fully allocated to
 * instalments, so the rule held with bounce_amount = 0 — which is exactly the
 * default every existing row receives. Nothing is recalculated, no stored
 * amount moves, and `emi_schedules.bounce_charge` (the charge ASSESSED) is
 * untouched and still read by nothing that computes a balance.
 *
 * Deliberately on `collections` and not on `collection_allocations`: a bounce
 * payment is a property of the payment, not of an instalment's principal /
 * interest split, and a bounce-only payment has no allocation row to hang off.
 *
 * NOT NULL DEFAULT '0.00' so MySQL fills it in place: no existing collection,
 * allocation, instalment, loan or customer row is read or rewritten.
 */

const TABLE = 'collections';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(TABLE, 'bounce_amount', {
      type: Sequelize.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: '0.00',
      after: 'amount'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(TABLE, 'bounce_amount');
  }
};
