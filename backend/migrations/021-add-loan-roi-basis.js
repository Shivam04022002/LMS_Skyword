'use strict';

/**
 * What a loan's stored `roi` percentage means.
 *
 * The rate the operator enters changed from annual to monthly. Rather than
 * rewrite stored rates — which would re-price agreements that already exist —
 * each loan records the basis it was priced on and keeps it forever.
 *
 * The column default is ANNUAL on purpose: it backfills the loans already in
 * the table, every one of which was created when the entered rate meant "per
 * year". New loans never rely on this default — the model and the loan service
 * write MONTHLY explicitly — so no stored amount, instalment or schedule
 * changes when this migration runs.
 */

const TABLE = 'loans';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(TABLE, 'roi_basis', {
      type: Sequelize.ENUM('ANNUAL', 'MONTHLY'),
      allowNull: false,
      defaultValue: 'ANNUAL',
      after: 'roi'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(TABLE, 'roi_basis');
  }
};
