'use strict';

const { DataTypes, Model } = require('sequelize');

/**
 * Counter backing CIFID generation.
 *
 * One row per sequence. The number is read with a row-level lock inside the
 * same transaction that inserts the customer, which is what makes concurrent
 * creations safe — see customerService.generateCifId.
 */
class CifSequence extends Model {}

module.exports = (sequelize) => {
  CifSequence.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true
      },
      currentNumber: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      }
    },
    {
      sequelize,
      modelName: 'CifSequence',
      tableName: 'cif_sequences'
    }
  );

  return CifSequence;
};
