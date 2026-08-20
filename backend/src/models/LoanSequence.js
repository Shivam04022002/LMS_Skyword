'use strict';

const { DataTypes, Model } = require('sequelize');

/**
 * Per-year counter backing loan number allocation.
 *
 * One row per calendar year. The row is read with a row-level lock inside the
 * same transaction that inserts the loan, so concurrent creations serialise and
 * can never receive the same number — see loanService.generateLoanNumber.
 */
class LoanSequence extends Model {}

module.exports = (sequelize) => {
  LoanSequence.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      year: {
        type: DataTypes.INTEGER.UNSIGNED,
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
      modelName: 'LoanSequence',
      tableName: 'loan_sequences'
    }
  );

  return LoanSequence;
};
