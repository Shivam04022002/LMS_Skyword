'use strict';

const { DataTypes, Model } = require('sequelize');
const { ASSIGNMENT_STATUS, ASSIGNMENT_STATUS_VALUES } = require('../config/routes');

/**
 * Assignment of a loan to a collection route.
 *
 * A history table, like route_collectors: moving a loan to another route closes
 * the old row (REMOVED + `unassigned_at`) and opens a new one, so the route a
 * loan sat on at any past date remains recoverable.
 *
 * A loan is on at most ONE active route at a time — enforced by a generated
 * column with a unique index (see the migration) so demand is unambiguous.
 * No route column is added to `loans` or `customers`.
 */
class LoanRoute extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      status: this.status,
      assignedAt: this.assignedAt,
      unassignedAt: this.unassignedAt,
      route: this.Route ? { id: this.Route.id, routeCode: this.Route.routeCode, name: this.Route.name, status: this.Route.status } : null,
      loan: this.Loan ? { id: this.Loan.id, loanNumber: this.Loan.loanNumber, status: this.Loan.status } : null,
      assignedBy: this.AssignedBy ? { id: this.AssignedBy.id, name: this.AssignedBy.name } : null
    };
  }
}

module.exports = (sequelize) => {
  LoanRoute.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      loanId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      routeId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      status: {
        type: DataTypes.ENUM(...ASSIGNMENT_STATUS_VALUES),
        allowNull: false,
        defaultValue: ASSIGNMENT_STATUS.ACTIVE
      },
      assignedAt: { type: DataTypes.DATEONLY, allowNull: false },
      unassignedAt: { type: DataTypes.DATEONLY, allowNull: true },
      assignedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
    },
    {
      sequelize,
      modelName: 'LoanRoute',
      tableName: 'loan_routes',
      indexes: [{ fields: ['route_id', 'status'] }, { fields: ['loan_id', 'status'] }]
    }
  );

  LoanRoute.associate = ({ Route, Loan, User }) => {
    LoanRoute.belongsTo(Route, { foreignKey: 'routeId', as: 'Route' });
    LoanRoute.belongsTo(Loan, { foreignKey: 'loanId', as: 'Loan' });
    LoanRoute.belongsTo(User, { foreignKey: 'assignedBy', as: 'AssignedBy' });
    Loan.hasMany(LoanRoute, { foreignKey: 'loanId', as: 'RouteAssignments' });
  };

  return LoanRoute;
};
