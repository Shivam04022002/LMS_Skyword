'use strict';

/**
 * Money received from a customer.
 *
 * Financial rows are never removed, so both foreign keys use RESTRICT: a loan or
 * customer with collections against them cannot be deleted. Amounts are DECIMAL,
 * never FLOAT.
 */

const TABLE = 'collections';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      // System-generated and immutable: COL26-000001.
      collection_number: { type: Sequelize.STRING(20), allowNull: false, unique: true },

      loan_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'loans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      // The payer: any active party on the loan, not necessarily the applicant.
      customer_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'customers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },

      amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },
      collection_date: { type: Sequelize.DATEONLY, allowNull: false },

      ledger_type: { type: Sequelize.ENUM('CASH', 'BANK'), allowNull: false },
      // Required for BANK by the service; optional for CASH.
      payment_reference: { type: Sequelize.STRING(120), allowNull: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },

      // REVERSED rows stay in place; they simply stop counting.
      status: { type: Sequelize.ENUM('POSTED', 'REVERSED'), allowNull: false, defaultValue: 'POSTED' },

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

    await queryInterface.addIndex(TABLE, ['loan_id'], { name: 'idx_collections_loan' });
    await queryInterface.addIndex(TABLE, ['customer_id'], { name: 'idx_collections_customer' });
    await queryInterface.addIndex(TABLE, ['collection_date'], { name: 'idx_collections_date' });
    await queryInterface.addIndex(TABLE, ['status'], { name: 'idx_collections_status' });
    await queryInterface.addIndex(TABLE, ['ledger_type'], { name: 'idx_collections_ledger_type' });
    await queryInterface.addIndex(TABLE, ['created_by'], { name: 'idx_collections_created_by' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
