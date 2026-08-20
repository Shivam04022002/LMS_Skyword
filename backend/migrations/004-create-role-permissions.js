'use strict';

/** Join table granting permissions to roles. */

const TABLE = 'role_permissions';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      role_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'roles', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      permission_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'permissions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });

    // A role holds a given permission at most once.
    await queryInterface.addIndex(TABLE, ['role_id', 'permission_id'], {
      unique: true,
      name: 'uq_role_permissions_role_permission'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
