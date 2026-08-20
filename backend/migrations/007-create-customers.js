'use strict';

/**
 * Central customer registry.
 *
 * One row per person. Later phases relate customers to loans through a join
 * table, so there are deliberately no applicant/co-applicant/guarantor columns
 * here — a person participating in several loans is still a single record.
 *
 * `created_by` / `updated_by` reference users with ON DELETE SET NULL: removing
 * a staff account must never remove customer history.
 */

const TABLE = 'customers';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      // System-generated and immutable: C000001.
      cif_id: { type: Sequelize.STRING(10), allowNull: false, unique: true },

      first_name: { type: Sequelize.STRING(60), allowNull: false },
      middle_name: { type: Sequelize.STRING(60), allowNull: true },
      last_name: { type: Sequelize.STRING(60), allowNull: true },
      // Derived by the backend from the three parts above.
      full_name: { type: Sequelize.STRING(190), allowNull: false },

      // Canonical 10-digit form. Indexed but intentionally NOT unique: family
      // members legitimately share a number.
      mobile: { type: Sequelize.STRING(10), allowNull: false },
      alternate_mobile: { type: Sequelize.STRING(10), allowNull: true },
      // Not unique either — shared household addresses are common.
      email: { type: Sequelize.STRING(160), allowNull: true },

      date_of_birth: { type: Sequelize.DATEONLY, allowNull: true },
      gender: { type: Sequelize.ENUM('MALE', 'FEMALE', 'OTHER'), allowNull: true },
      father_name: { type: Sequelize.STRING(120), allowNull: true },
      mother_name: { type: Sequelize.STRING(120), allowNull: true },
      marital_status: { type: Sequelize.ENUM('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'), allowNull: true },
      occupation: { type: Sequelize.STRING(120), allowNull: true },

      address_line1: { type: Sequelize.STRING(255), allowNull: true },
      address_line2: { type: Sequelize.STRING(255), allowNull: true },
      city: { type: Sequelize.STRING(80), allowNull: true },
      state: { type: Sequelize.STRING(80), allowNull: true },
      pincode: { type: Sequelize.STRING(6), allowNull: true },

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

    // Search paths: mobile lookup, name lookup, email lookup.
    await queryInterface.addIndex(TABLE, ['mobile'], { name: 'idx_customers_mobile' });
    await queryInterface.addIndex(TABLE, ['full_name'], { name: 'idx_customers_full_name' });
    await queryInterface.addIndex(TABLE, ['email'], { name: 'idx_customers_email' });
    await queryInterface.addIndex(TABLE, ['status'], { name: 'idx_customers_status' });
    // Composite: serves "filter by state" (leftmost prefix) and "state + city"
    // with a single index rather than two.
    await queryInterface.addIndex(TABLE, ['state', 'city'], { name: 'idx_customers_state_city' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
