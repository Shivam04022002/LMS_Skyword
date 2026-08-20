'use strict';

/**
 * How each collection was applied to individual instalments.
 *
 * These rows are the ledger: `emi_schedules.amount_collected`, `payment_date`,
 * `status` and `dpd` are all recomputed from them. There is deliberately no
 * status column — an allocation counts exactly when its parent collection is
 * POSTED, so the two states cannot disagree.
 *
 * RESTRICT on both foreign keys: reversal is a status change, never a delete, so
 * financial history is never cascaded away.
 */

const TABLE = 'collection_allocations';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },

      collection_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'collections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      emi_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'emi_schedules', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },

      allocated_amount: { type: Sequelize.DECIMAL(15, 2), allowNull: false },

      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false }
    });

    // A collection allocates to a given instalment once, with a single amount.
    await queryInterface.addIndex(TABLE, ['collection_id', 'emi_id'], {
      unique: true,
      name: 'uq_collection_allocations_collection_emi'
    });

    await queryInterface.addIndex(TABLE, ['emi_id'], { name: 'idx_collection_allocations_emi' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  }
};
