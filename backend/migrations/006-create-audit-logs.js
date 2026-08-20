'use strict';

/** Append-only audit trail, reusable by later phases. */

const TABLE = 'audit_logs';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      user_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        // Keep the trail intact if the acting user is ever removed.
        onDelete: 'SET NULL'
      },
      action: { type: Sequelize.STRING(60), allowNull: false },
      entity: { type: Sequelize.STRING(60), allowNull: false },
      entity_id: { type: Sequelize.STRING(60), allowNull: true },
      details: { type: Sequelize.JSON, allowNull: true },
      ip_address: { type: Sequelize.STRING(45), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false }
    });

    await queryInterface.addIndex(TABLE, ['user_id'], { name: 'idx_audit_logs_user_id' });
    await queryInterface.addIndex(TABLE, ['entity', 'entity_id'], { name: 'idx_audit_logs_entity' });
    await queryInterface.addIndex(TABLE, ['action'], { name: 'idx_audit_logs_action' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
