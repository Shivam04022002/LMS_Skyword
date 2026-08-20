'use strict';

const { DataTypes, Model } = require('sequelize');
const { ASSIGNMENT_STATUS, ASSIGNMENT_STATUS_VALUES } = require('../config/routes');

/**
 * Assignment of a collector (a COLLECTOR-role user) to a route.
 *
 * A history table: unassigning sets status REMOVED and stamps `unassigned_at`
 * rather than deleting the row, so who covered which route and when stays
 * recoverable. A route may have several active collectors.
 *
 * No collector columns are added to `users` — the relationship lives here.
 */
class RouteCollector extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      status: this.status,
      assignedAt: this.assignedAt,
      unassignedAt: this.unassignedAt,
      collector: this.Collector
        ? { id: this.Collector.id, name: this.Collector.name, email: this.Collector.email, status: this.Collector.status }
        : null,
      route: this.Route ? { id: this.Route.id, routeCode: this.Route.routeCode, name: this.Route.name } : null,
      assignedBy: this.AssignedBy ? { id: this.AssignedBy.id, name: this.AssignedBy.name } : null
    };
  }
}

module.exports = (sequelize) => {
  RouteCollector.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      routeId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
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
      modelName: 'RouteCollector',
      tableName: 'route_collectors',
      indexes: [{ fields: ['route_id', 'status'] }, { fields: ['user_id', 'status'] }]
    }
  );

  RouteCollector.associate = ({ Route, User }) => {
    RouteCollector.belongsTo(Route, { foreignKey: 'routeId', as: 'Route' });
    RouteCollector.belongsTo(User, { foreignKey: 'userId', as: 'Collector' });
    RouteCollector.belongsTo(User, { foreignKey: 'assignedBy', as: 'AssignedBy' });
  };

  return RouteCollector;
};
