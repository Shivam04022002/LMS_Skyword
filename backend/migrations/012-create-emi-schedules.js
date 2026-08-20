'use strict';

/**
 * The EMI schedule: one row per instalment.
 *
 * Money is DECIMAL, never FLOAT. `dpd` and `status` are snapshots — the API
 * always serves values derived from the due date and the collected amount — and
 * are stored so they can be indexed and reported on.
 *
 * `amount_collected` and `payment_date` are written by the collection module in
 * a later phase; a generated schedule always starts at 0.00 / NULL.
 */

const TABLE = 'emi_schedules';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      // RESTRICT: a loan with a schedule must not be removable, and loan
      // deletion is not supported anywhere in the system.
      loan_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'loans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },

      // 1..emi_count, numbered per loan rather than globally.
      emi_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      emi_date: { type: Sequelize.DATEONLY, allowNull: false },

      emi_amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      principal: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      interest: { type: Sequelize.DECIMAL(15, 2), allowNull: false },

      dpd: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },

      amount_collected: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: '0.00' },
      payment_date: { type: Sequelize.DATEONLY, allowNull: true },

      status: {
        type: Sequelize.ENUM('PENDING', 'DUE', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED'),
        allowNull: false,
        defaultValue: 'PENDING'
      },

      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });

    // Makes a duplicate instalment impossible even under concurrent generation.
    await queryInterface.addIndex(TABLE, ['loan_id', 'emi_number'], {
      unique: true,
      name: 'uq_emi_schedules_loan_emi_number'
    });

    await queryInterface.addIndex(TABLE, ['emi_date'], { name: 'idx_emi_schedules_emi_date' });
    // Composite: serves "this loan's schedule" (leftmost prefix) and
    // "this loan's overdue instalments" with one index.
    await queryInterface.addIndex(TABLE, ['loan_id', 'status'], { name: 'idx_emi_schedules_loan_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
