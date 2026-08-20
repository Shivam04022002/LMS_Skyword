'use strict';

const { DataTypes, Model } = require('sequelize');

/**
 * Per-year counter backing collection number allocation.
 *
 * Read with a row-level lock inside the posting transaction, so concurrent
 * collections serialise and can never receive the same number.
 */
class CollectionSequence extends Model {}

module.exports = (sequelize) => {
  CollectionSequence.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      year: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, unique: true },
      currentNumber: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }
    },
    {
      sequelize,
      modelName: 'CollectionSequence',
      tableName: 'collection_sequences'
    }
  );

  return CollectionSequence;
};
