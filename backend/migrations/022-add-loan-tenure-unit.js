'use strict';

/**
 * What a loan's `tenure` counts.
 *
 * A daily loan can now be written as a contract of N months — six months from
 * 20-Aug-2026 runs to 20-Feb-2027 and collects daily inside that window — so
 * the number stored in `tenure` needs to say which it is.
 *
 * The column default is PERIODS: every loan already in the table counts periods
 * of its own loan type, which is exactly what they were priced on. New loans
 * state their unit explicitly through the model, so this default only ever
 * applies to the backfill. No stored amount, instalment, date or schedule
 * changes when this migration runs.
 */

const TABLE = 'loans';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(TABLE, 'tenure_unit', {
      type: Sequelize.ENUM('PERIODS', 'MONTHS'),
      allowNull: false,
      defaultValue: 'PERIODS',
      after: 'tenure'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(TABLE, 'tenure_unit');
  }
};
