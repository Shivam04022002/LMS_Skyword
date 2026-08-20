'use strict';

const { DataTypes, Model } = require('sequelize');

/** Join table between roles and permissions. */
class RolePermission extends Model {}

module.exports = (sequelize) => {
  RolePermission.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      roleId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      permissionId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      }
    },
    {
      sequelize,
      modelName: 'RolePermission',
      tableName: 'role_permissions',
      indexes: [{ unique: true, fields: ['role_id', 'permission_id'] }]
    }
  );

  return RolePermission;
};
