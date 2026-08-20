'use strict';

/**
 * Loan-to-route assignment history.
 *
 * Moving a loan to another route closes the previous row (REMOVED +
 * `unassigned_at`) and opens a new one, so the route a loan sat on at any past
 * date remains recoverable.
 *
 * Existing loans are untouched by this migration: they simply have no
 * assignment row until one is created, and remain fully readable without one.
 */

const TABLE = 'loan_routes';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      loan_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'loans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      route_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'routes', key: 'id' },
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
     * A loan sits on at most ONE active route at a time, so demand is never
     * ambiguous — while unlimited historical REMOVED rows may exist. Generated
     * column + UNIQUE index, as elsewhere in the schema.
     */
    await queryInterface.sequelize.query(
      `ALTER TABLE \`${TABLE}\`
         ADD COLUMN \`active_loan_key\` INT UNSIGNED
         GENERATED ALWAYS AS (
           CASE WHEN \`status\` = 'ACTIVE' THEN \`loan_id\` ELSE NULL END
         ) VIRTUAL`
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE \`${TABLE}\`
         ADD UNIQUE INDEX \`uq_loan_routes_active_loan\` (\`active_loan_key\`)`
    );

    await queryInterface.addIndex(TABLE, ['route_id', 'status'], { name: 'idx_loan_routes_route_status' });
    await queryInterface.addIndex(TABLE, ['loan_id', 'status'], { name: 'idx_loan_routes_loan_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
