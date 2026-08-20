'use strict';

const { DataTypes, Model } = require('sequelize');
const { PARTY_ROLE_VALUES, PARTY_STATUS, PARTY_STATUS_VALUES, isPrimaryRole } = require('../config/loanParties');

/**
 * Relationship between a loan and a customer, carrying the role that customer
 * holds *on that loan*.
 *
 * No customer profile data is duplicated here — name, mobile, email and CIFID
 * are read through the Customer association, which remains the single source of
 * truth. If a legal requirement for point-in-time snapshots emerges, that is a
 * separate table in a later phase, not columns on this one.
 *
 * `loanId` references the loans table introduced in Phase 5.
 */
class LoanParty extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      loanId: this.loanId,
      partyRole: this.partyRole,
      isPrimary: this.isPrimary,
      status: this.status,
      customer: this.Customer
        ? {
            id: this.Customer.id,
            cifId: this.Customer.cifId,
            fullName: this.Customer.fullName,
            mobile: this.Customer.mobile,
            status: this.Customer.status
          }
        : null,
      createdBy: this.CreatedBy ? { id: this.CreatedBy.id, name: this.CreatedBy.name } : null,
      updatedBy: this.UpdatedBy ? { id: this.UpdatedBy.id, name: this.UpdatedBy.name } : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = (sequelize) => {
  LoanParty.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      loanId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      customerId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      partyRole: {
        type: DataTypes.ENUM(...PARTY_ROLE_VALUES),
        allowNull: false
      },
      // Derived from partyRole, never accepted from a request.
      isPrimary: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      status: {
        type: DataTypes.ENUM(...PARTY_STATUS_VALUES),
        allowNull: false,
        defaultValue: PARTY_STATUS.ACTIVE
      },
      createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
    },
    {
      sequelize,
      modelName: 'LoanParty',
      tableName: 'loan_parties',
      hooks: {
        // Keeps isPrimary consistent with the role no matter which call site
        // writes the row, including a role swap.
        beforeValidate: (party) => {
          party.isPrimary = isPrimaryRole(party.partyRole);
        }
      }
    }
  );

  LoanParty.associate = ({ Customer, User, Loan }) => {
    LoanParty.belongsTo(Customer, { foreignKey: 'customerId', as: 'Customer' });
    LoanParty.belongsTo(User, { foreignKey: 'createdBy', as: 'CreatedBy' });
    LoanParty.belongsTo(User, { foreignKey: 'updatedBy', as: 'UpdatedBy' });
    Customer.hasMany(LoanParty, { foreignKey: 'customerId', as: 'LoanParties' });

    // The reciprocal Loan.hasMany(LoanParty) is declared in Loan.associate.
    LoanParty.belongsTo(Loan, { foreignKey: 'loanId', as: 'Loan' });
  };

  return LoanParty;
};
