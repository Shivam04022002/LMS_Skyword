'use strict';

/**
 * Counter table backing CIFID generation.
 *
 * A dedicated counter is used instead of MAX(cif_id) + 1: the latter races
 * under concurrent creation and can hand the same number to two customers. The
 * service reads this row with SELECT ... FOR UPDATE inside the customer's own
 * transaction, so allocations serialise.
 */

const TABLE = 'cif_sequences';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      name: { type: Sequelize.STRING(50), allowNull: false, unique: true },
      current_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });

    const now = new Date();
    await queryInterface.bulkInsert(TABLE, [{ name: 'CUSTOMER', current_number: 0, created_at: now, updated_at: now }]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
