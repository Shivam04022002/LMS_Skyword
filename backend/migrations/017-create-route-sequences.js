'use strict';

/**
 * Per-year counter backing route code allocation.
 *
 * A dedicated counter, not MAX(route_code) + 1, which races under concurrent
 * creation. Read with SELECT ... FOR UPDATE inside the creating transaction.
 * No rows are seeded: the first route of a year creates its own counter.
 */

const TABLE = 'route_sequences';

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
