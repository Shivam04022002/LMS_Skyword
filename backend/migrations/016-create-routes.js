'use strict';

/**
 * Field collection routes.
 *
 * Additive only — no existing table is altered and no existing row is touched.
 * Collectors and loans attach through history tables (018, 019), so there are
 * no collector/loan columns here.
 */

const TABLE = 'routes';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      // System-generated and immutable: RT26-000001.
      route_code: { type: Sequelize.STRING(20), allowNull: false, unique: true },

      name: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.STRING(255), allowNull: true },

      // Routes are deactivated, never deleted.
      status: { type: Sequelize.ENUM('ACTIVE', 'INACTIVE'), allowNull: false, defaultValue: 'ACTIVE' },

      created_by: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      updated_by: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },

      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });

    await queryInterface.addIndex(TABLE, ['status'], { name: 'idx_routes_status' });
    await queryInterface.addIndex(TABLE, ['name'], { name: 'idx_routes_name' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
