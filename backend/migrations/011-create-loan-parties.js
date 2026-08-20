'use strict';

/**
 * Relationship between a loan and a customer, carrying the role that customer
 * holds on that loan.
 *
 * Written in Phase 4 and parked under migrations/pending/ because `loan_id` had
 * to reference a `loans` table that did not exist yet. Phase 5 created that
 * table in 009-create-loans.js, so this migration was moved into the active
 * sequence — after 009 — and its foreign key enabled. It is the only migration
 * that creates loan_parties.
 */

const TABLE = 'loan_parties';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      // RESTRICT: a loan with parties must not be removable out from under them.
      loan_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'loans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },

      // RESTRICT: a customer who is party to a loan must not be removable.
      customer_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'customers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },

      party_role: {
        type: Sequelize.ENUM('APPLICANT', 'CO_APPLICANT', 'GUARANTOR'),
        allowNull: false
      },
      // Derived from party_role by the model; true only for the applicant.
      is_primary: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // Soft removal — rows are never deleted, so participant history survives.
      status: { type: Sequelize.ENUM('ACTIVE', 'REMOVED'), allowNull: false, defaultValue: 'ACTIVE' },

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

    // One customer appears at most once per loan, in any role.
    await queryInterface.addIndex(TABLE, ['loan_id', 'customer_id'], {
      unique: true,
      name: 'uq_loan_parties_loan_customer'
    });

    /**
     * Exactly one ACTIVE applicant per loan, enforced by the database.
     *
     * MySQL has no partial indexes, so a generated column holds the loan_id only
     * for rows that are an active applicant and NULL otherwise. A UNIQUE index
     * ignores NULLs, so unlimited co-applicants and guarantors coexist while a
     * second active applicant on the same loan is rejected outright — including
     * under concurrent inserts, which service-level checks alone cannot prevent.
     */
    await queryInterface.sequelize.query(
      `ALTER TABLE \`${TABLE}\`
         ADD COLUMN \`active_applicant_key\` INT UNSIGNED
         GENERATED ALWAYS AS (
           CASE WHEN \`party_role\` = 'APPLICANT' AND \`status\` = 'ACTIVE'
                THEN \`loan_id\` ELSE NULL END
         ) VIRTUAL`
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE \`${TABLE}\`
         ADD UNIQUE INDEX \`uq_loan_parties_active_applicant\` (\`active_applicant_key\`)`
    );

    await queryInterface.addIndex(TABLE, ['loan_id', 'party_role'], { name: 'idx_loan_parties_loan_role' });
    await queryInterface.addIndex(TABLE, ['customer_id'], { name: 'idx_loan_parties_customer' });
    await queryInterface.addIndex(TABLE, ['status'], { name: 'idx_loan_parties_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
