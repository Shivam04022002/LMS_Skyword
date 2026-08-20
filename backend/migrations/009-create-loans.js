'use strict';

/**
 * The loan entity.
 *
 * Money is DECIMAL, never FLOAT — a float column would make stored balances
 * approximate. Customers are attached only through loan_parties, so there is no
 * applicant_id/co_applicant_id/guarantor_id and no CIFID here.
 */

const TABLE = 'loans';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      // System-generated and immutable: LN26-000001.
      loan_number: { type: Sequelize.STRING(20), allowNull: false, unique: true },

      loan_amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      // Annual percentage: 12.5000 means 12.50%.
      roi: { type: Sequelize.DECIMAL(7, 4), allowNull: false },
      // Repayment periods; the period length comes from loan_type.
      tenure: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      loan_type: { type: Sequelize.ENUM('DAILY', 'WEEKLY', 'MONTHLY'), allowNull: false },

      total_repayment: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      emi_amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      emi_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },

      status: {
        type: Sequelize.ENUM('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'DRAFT'
      },
      start_date: { type: Sequelize.DATEONLY, allowNull: false },

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

    await queryInterface.addIndex(TABLE, ['status'], { name: 'idx_loans_status' });
    await queryInterface.addIndex(TABLE, ['loan_type'], { name: 'idx_loans_loan_type' });
    await queryInterface.addIndex(TABLE, ['start_date'], { name: 'idx_loans_start_date' });
    await queryInterface.addIndex(TABLE, ['created_at'], { name: 'idx_loans_created_at' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
