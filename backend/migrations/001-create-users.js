'use strict';

/**
 * Baseline of the Phase 1 `users` table.
 *
 * Phase 1 created this table with sequelize.sync(). This migration reproduces
 * that exact shape so a fresh database can be built from migrations alone, and
 * is skipped when the table already exists.
 */

const TABLE = 'users';

async function tableExists(queryInterface, table) {
  const tables = await queryInterface.showAllTables();
  return tables.map((name) => String(name).toLowerCase()).includes(table);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, TABLE)) {
      console.log(`[migrate] "${TABLE}" already exists — leaving existing data untouched`);
      return;
    }

    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      email: { type: Sequelize.STRING(160), allowNull: false, unique: true },
      password: { type: Sequelize.STRING(255), allowNull: false },
      role: {
        type: Sequelize.ENUM('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'COLLECTOR', 'STAFF'),
        allowNull: false,
        defaultValue: 'STAFF'
      },
      status: {
        type: Sequelize.ENUM('ACTIVE', 'INACTIVE'),
        allowNull: false,
        defaultValue: 'ACTIVE'
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
