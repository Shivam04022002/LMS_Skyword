'use strict';

/**
 * A manually recorded bounce charge on one instalment.
 *
 * Deliberately additive and deliberately inert: nothing in the system reads this
 * column. It is not part of the instalment, not part of what the borrower owes
 * on it, and not part of any allocation — EMI amount, principal, interest,
 * collected, outstanding, DPD and status are all computed exactly as before.
 *
 * NOT NULL DEFAULT '0.00' so every existing instalment reads as "no charge
 * recorded" without being touched: MySQL fills the default in place and no
 * stored amount, date or status moves.
 */

const TABLE = 'emi_schedules';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(TABLE, 'bounce_charge', {
      type: Sequelize.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: '0.00',
      after: 'interest'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(TABLE, 'bounce_charge');
  }
};
