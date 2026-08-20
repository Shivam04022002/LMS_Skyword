'use strict';

const { DataTypes, Model } = require('sequelize');

/**
 * Per-year counter backing route code allocation.
 *
 * Read with a row-level lock inside the creating transaction, so concurrent
 * route creation can never produce the same code.
 */
class RouteSequence extends Model {}

module.exports = (sequelize) => {
  RouteSequence.init(
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
      modelName: 'RouteSequence',
      tableName: 'route_sequences'
    }
  );

  return RouteSequence;
};
