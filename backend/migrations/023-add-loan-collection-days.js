'use strict';

/**
 * How many chargeable daily instalments collect a contract.
 *
 * A month-based daily loan has two independent numbers: the contractual term
 * (six months) and the number of collections used to repay it (150 days). Only
 * the second is stored here; the first is already `tenure`.
 *
 * NULL means "not stated", which is exactly what every existing loan means: the
 * schedule covers every chargeable day of its window. The column is nullable
 * with no default, so this migration adds a column and changes nothing else —
 * no stored amount, instalment, date or schedule moves.
 */

const TABLE = 'loans';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(TABLE, 'collection_days', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      defaultValue: null,
      after: 'tenure_unit'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(TABLE, 'collection_days');
  }
};
