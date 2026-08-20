'use strict';

const { DataTypes, Model } = require('sequelize');

/**
 * How one collection was applied to one instalment.
 *
 * There is deliberately no status column here: an allocation is valid exactly
 * when its parent collection is POSTED. Keeping validity in one place means a
 * reversal cannot leave the two states disagreeing.
 */
class CollectionAllocation extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      allocatedAmount: this.allocatedAmount,
      emi: this.Emi
        ? {
            id: this.Emi.id,
            emiNumber: this.Emi.emiNumber,
            emiDate: this.Emi.emiDate,
            emiAmount: this.Emi.emiAmount,
            amountCollected: this.Emi.amountCollected,
            outstanding: this.Emi.outstanding(),
            status: this.Emi.computeStatus(),
            dpd: this.Emi.computeDpd()
          }
        : null,
      collection: this.Collection
        ? {
            id: this.Collection.id,
            collectionNumber: this.Collection.collectionNumber,
            collectionDate: this.Collection.collectionDate,
            status: this.Collection.status
          }
        : null
    };
  }
}

module.exports = (sequelize) => {
  CollectionAllocation.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      collectionId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      emiId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      allocatedAmount: { type: DataTypes.DECIMAL(15, 2), allowNull: false }
    },
    {
      sequelize,
      modelName: 'CollectionAllocation',
      tableName: 'collection_allocations',
      // One row per collection/instalment pair: a collection allocates to a
      // given EMI once, with a single amount.
      indexes: [{ unique: true, fields: ['collection_id', 'emi_id'] }]
    }
  );

  CollectionAllocation.associate = ({ Collection, EmiSchedule }) => {
    CollectionAllocation.belongsTo(Collection, { foreignKey: 'collectionId', as: 'Collection' });
    CollectionAllocation.belongsTo(EmiSchedule, { foreignKey: 'emiId', as: 'Emi' });
    EmiSchedule.hasMany(CollectionAllocation, { foreignKey: 'emiId', as: 'Allocations' });
  };

  return CollectionAllocation;
};
