'use strict';

const { DataTypes, Model } = require('sequelize');

/**
 * Append-only record of security-relevant actions.
 * Deliberately generic (`entity` + `entityId` + `details`) so later phases can
 * log loan, collection and demand activity without a schema change.
 */
class AuditLog extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      userId: this.userId,
      action: this.action,
      entity: this.entity,
      entityId: this.entityId,
      details: this.details,
      ipAddress: this.ipAddress,
      createdAt: this.createdAt
    };
  }
}

module.exports = (sequelize) => {
  AuditLog.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      // The actor. Nullable so the row survives if the actor is ever removed.
      userId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true
      },
      action: {
        type: DataTypes.STRING(60),
        allowNull: false
      },
      entity: {
        type: DataTypes.STRING(60),
        allowNull: false
      },
      entityId: {
        type: DataTypes.STRING(60),
        allowNull: true
      },
      // Never contains passwords, hashes or tokens — see auditService.
      details: {
        type: DataTypes.JSON,
        allowNull: true
      },
      ipAddress: {
        type: DataTypes.STRING(45),
        allowNull: true
      }
    },
    {
      sequelize,
      modelName: 'AuditLog',
      tableName: 'audit_logs',
      updatedAt: false,
      indexes: [{ fields: ['user_id'] }, { fields: ['entity', 'entity_id'] }, { fields: ['action'] }]
    }
  );

  AuditLog.associate = ({ User }) => {
    AuditLog.belongsTo(User, { foreignKey: 'userId', as: 'Actor' });
  };

  return AuditLog;
};
