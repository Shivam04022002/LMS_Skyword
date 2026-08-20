'use strict';

/**
 * Per-year counter backing collection number allocation.
 *
 * A dedicated counter is used instead of MAX(collection_number) + 1, which races
 * under concurrent posting. The service reads the row with SELECT ... FOR UPDATE
 * inside the posting transaction.
 *
 * No rows are seeded: the first collection of a year creates its own counter.
 */

const TABLE = 'collection_sequences';

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
