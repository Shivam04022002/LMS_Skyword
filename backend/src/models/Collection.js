'use strict';

const { DataTypes, Model } = require('sequelize');
const { LEDGER_TYPE_VALUES, COLLECTION_STATUS, COLLECTION_STATUS_VALUES } = require('../config/collections');

/**
 * Money actually received from a customer.
 *
 * This is the transaction record; how it is applied to instalments lives in
 * collection_allocations. Together they are the ledger, and the ledger is the
 * only authority on what an EMI has been paid — `emi_schedules.amount_collected`
 * is a snapshot recomputed from these rows.
 *
 * A posted collection is immutable: there is no update path and no delete. A
 * correction is a REVERSED collection plus, if needed, a replacement.
 */
class Collection extends Model {
  isPosted() {
    return this.status === COLLECTION_STATUS.POSTED;
  }

  toPublicJSON() {
    return {
      id: this.id,
      collectionNumber: this.collectionNumber,
      amount: this.amount,
      collectionDate: this.collectionDate,
      ledgerType: this.ledgerType,
      paymentReference: this.paymentReference,
      notes: this.notes,
      status: this.status,
      loan: this.Loan
        ? { id: this.Loan.id, loanNumber: this.Loan.loanNumber, status: this.Loan.status }
        : null,
      customer: this.Customer
        ? {
            id: this.Customer.id,
            cifId: this.Customer.cifId,
            fullName: this.Customer.fullName,
            mobile: this.Customer.mobile
          }
        : null,
      allocations: Array.isArray(this.Allocations)
        ? this.Allocations.map((allocation) => allocation.toPublicJSON())
        : [],
      createdBy: this.CreatedBy ? { id: this.CreatedBy.id, name: this.CreatedBy.name } : null,
      updatedBy: this.UpdatedBy ? { id: this.UpdatedBy.id, name: this.UpdatedBy.name } : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  /** Compact shape for the list view — no internal ids beyond the row key. */
  toListJSON() {
    return {
      id: this.id,
      collectionNumber: this.collectionNumber,
      amount: this.amount,
      collectionDate: this.collectionDate,
      ledgerType: this.ledgerType,
      status: this.status,
      loanNumber: this.Loan?.loanNumber ?? null,
      customer: this.Customer ? { cifId: this.Customer.cifId, fullName: this.Customer.fullName } : null,
      createdBy: this.CreatedBy?.name ?? null,
      createdAt: this.createdAt
    };
  }
}

module.exports = (sequelize) => {
  Collection.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      // System-generated and immutable: COL26-000001.
      collectionNumber: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: { msg: 'This collection number already exists' }
      },
      loanId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      // The payer: any active party on the loan, not necessarily the applicant.
      customerId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
      collectionDate: { type: DataTypes.DATEONLY, allowNull: false },

      ledgerType: { type: DataTypes.ENUM(...LEDGER_TYPE_VALUES), allowNull: false },
      paymentReference: { type: DataTypes.STRING(120), allowNull: true },
      notes: { type: DataTypes.STRING(500), allowNull: true },

      status: {
        type: DataTypes.ENUM(...COLLECTION_STATUS_VALUES),
        allowNull: false,
        defaultValue: COLLECTION_STATUS.POSTED
      },

      createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
    },
    {
      sequelize,
      modelName: 'Collection',
      tableName: 'collections'
    }
  );

  Collection.associate = ({ Loan, Customer, CollectionAllocation, User }) => {
    Collection.belongsTo(Loan, { foreignKey: 'loanId', as: 'Loan' });
    Collection.belongsTo(Customer, { foreignKey: 'customerId', as: 'Customer' });
    Collection.hasMany(CollectionAllocation, { foreignKey: 'collectionId', as: 'Allocations' });
    Collection.belongsTo(User, { foreignKey: 'createdBy', as: 'CreatedBy' });
    Collection.belongsTo(User, { foreignKey: 'updatedBy', as: 'UpdatedBy' });

    Loan.hasMany(Collection, { foreignKey: 'loanId', as: 'Collections' });
    Customer.hasMany(Collection, { foreignKey: 'customerId', as: 'Collections' });
  };

  return Collection;
};
