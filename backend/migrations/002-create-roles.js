'use strict';

/**
 * Creates `roles` and inserts the five system roles.
 *
 * The rows live in the migration rather than only in the seed because
 * 005-update-users-role backfills users.role_id by joining on these names — the
 * FK cannot be satisfied without them.
 */

const TABLE = 'roles';

const SYSTEM_ROLES = [
  { name: 'SUPER_ADMIN', description: 'Full system access, including permission management' },
  { name: 'ADMIN', description: 'Administrative access to users and operational modules' },
  { name: 'MANAGER', description: 'Operational management and reporting' },
  { name: 'COLLECTOR', description: 'Field collection duties' },
  { name: 'STAFF', description: 'Basic operational access' }
];

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
      description: { type: Sequelize.STRING(255), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });

    const now = new Date();
    await queryInterface.bulkInsert(
      TABLE,
      SYSTEM_ROLES.map((role) => ({ ...role, created_at: now, updated_at: now }))
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
