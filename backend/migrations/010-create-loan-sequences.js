'use strict';

/**
 * Per-year counter backing loan number allocation.
 *
 * A dedicated counter is used instead of MAX(loan_number) + 1, which races under
 * concurrent creation and can hand the same number to two loans. The service
 * reads the row with SELECT ... FOR UPDATE inside the loan's own transaction.
 *
 * No rows are seeded: the first loan of a year creates its own counter, so the
 * table never needs maintenance as years roll over.
 */

const TABLE = 'loan_sequences';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      year: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, unique: true },
      current_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
