'use strict';

/**
 * Collector-to-route assignment history.
 *
 * Unassigning sets status REMOVED and stamps `unassigned_at` — rows are never
 * deleted, so who covered which route and when stays recoverable. RESTRICT on
 * both keys means neither a route nor a user can be removed out from under an
 * assignment.
 */

const TABLE = 'route_collectors';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      route_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'routes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      user_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },

      status: { type: Sequelize.ENUM('ACTIVE', 'REMOVED'), allowNull: false, defaultValue: 'ACTIVE' },
      assigned_at: { type: Sequelize.DATEONLY, allowNull: false },
      unassigned_at: { type: Sequelize.DATEONLY, allowNull: true },

      assigned_by: {
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

    /**
     * The same collector may be assigned to a route only once at a time, while
     * any number of historical REMOVED rows for that pair may exist.
     *
     * MySQL has no partial indexes, so a generated column carries the pair only
     * while the assignment is ACTIVE and NULL otherwise; a UNIQUE index ignores
     * NULLs. Same technique as loan_parties.active_applicant_key.
     */
    await queryInterface.sequelize.query(
      `ALTER TABLE \`${TABLE}\`
         ADD COLUMN \`active_assignment_key\` VARCHAR(48)
         GENERATED ALWAYS AS (
           CASE WHEN \`status\` = 'ACTIVE'
                THEN CONCAT(\`route_id\`, '-', \`user_id\`) ELSE NULL END
         ) VIRTUAL`
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE \`${TABLE}\`
         ADD UNIQUE INDEX \`uq_route_collectors_active\` (\`active_assignment_key\`)`
    );

    await queryInterface.addIndex(TABLE, ['route_id', 'status'], { name: 'idx_route_collectors_route_status' });
    await queryInterface.addIndex(TABLE, ['user_id', 'status'], { name: 'idx_route_collectors_user_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
