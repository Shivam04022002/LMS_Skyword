'use strict';

const { DataTypes, Model } = require('sequelize');
const { ROUTE_STATUS, ROUTE_STATUS_VALUES, ASSIGNMENT_STATUS } = require('../config/routes');

/**
 * A field collection route (area).
 *
 * Collectors are attached through `route_collectors` and loans through
 * `loan_routes` — both history tables. There are deliberately no collector or
 * loan columns here, and no route columns on `users` or `customers`.
 */
class Route extends Model {
  activeCollectors() {
    return Array.isArray(this.Collectors)
      ? this.Collectors.filter((a) => a.status === ASSIGNMENT_STATUS.ACTIVE)
      : [];
  }

  toPublicJSON() {
    return {
      id: this.id,
      routeCode: this.routeCode,
      name: this.name,
      description: this.description,
      status: this.status,
      collectors: this.activeCollectors().map((assignment) => assignment.toPublicJSON()),
      createdBy: this.CreatedBy ? { id: this.CreatedBy.id, name: this.CreatedBy.name } : null,
      updatedBy: this.UpdatedBy ? { id: this.UpdatedBy.id, name: this.UpdatedBy.name } : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  toListJSON({ collectorCount = null, loanCount = null } = {}) {
    return {
      id: this.id,
      routeCode: this.routeCode,
      name: this.name,
      description: this.description,
      status: this.status,
      collectorCount,
      loanCount,
      createdAt: this.createdAt
    };
  }
}

module.exports = (sequelize) => {
  Route.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      // System-generated and immutable: RT26-000001.
      routeCode: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: { msg: 'This route code already exists' }
      },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
        validate: { notEmpty: { msg: 'Route name is required' } }
      },
      description: { type: DataTypes.STRING(255), allowNull: true },
      status: {
        type: DataTypes.ENUM(...ROUTE_STATUS_VALUES),
        allowNull: false,
        defaultValue: ROUTE_STATUS.ACTIVE
      },
      createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
    },
    {
      sequelize,
      modelName: 'Route',
      tableName: 'routes',
      hooks: {
        beforeValidate: (route) => {
          if (typeof route.name === 'string') route.name = route.name.trim();
          if (typeof route.description === 'string') {
            const description = route.description.trim();
            route.description = description === '' ? null : description;
          }
        }
      }
    }
  );

  Route.associate = ({ RouteCollector, LoanRoute, User }) => {
    Route.hasMany(RouteCollector, { foreignKey: 'routeId', as: 'Collectors' });
    Route.hasMany(LoanRoute, { foreignKey: 'routeId', as: 'LoanAssignments' });
    Route.belongsTo(User, { foreignKey: 'createdBy', as: 'CreatedBy' });
    Route.belongsTo(User, { foreignKey: 'updatedBy', as: 'UpdatedBy' });
  };

  return Route;
};
