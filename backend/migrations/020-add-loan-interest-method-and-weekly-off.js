'use strict';

/**
 * Phase 11: how a loan charges interest, and which weekday it does not collect
 * on. Both are stored on the loan so a later change to the system default can
 * never re-price an agreement that already exists.
 *
 * The defaults are chosen to describe the loans already in the table exactly as
 * they were created — every existing loan is flat interest, and no existing
 * daily loan skips a day — so this migration adds columns without changing a
 * single stored amount, instalment or date.
 */

const TABLE = 'loans';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(TABLE, 'interest_method', {
      type: Sequelize.ENUM('FLAT', 'REDUCING'),
      allowNull: false,
      defaultValue: 'FLAT',
      after: 'loan_type'
    });

    await queryInterface.addColumn(TABLE, 'weekly_off', {
      type: Sequelize.ENUM('NONE', 'SUNDAY'),
      allowNull: false,
      defaultValue: 'NONE',
      after: 'interest_method'
    });

    await queryInterface.addIndex(TABLE, ['interest_method'], { name: 'idx_loans_interest_method' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(TABLE, 'idx_loans_interest_method');
    await queryInterface.removeColumn(TABLE, 'weekly_off');
    await queryInterface.removeColumn(TABLE, 'interest_method');
  }
};
