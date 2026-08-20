'use strict';

const { DataTypes, Model } = require('sequelize');

class Role extends Model {
  /** Permission names held by this role. Requires `Permissions` to be loaded. */
  permissionNames() {
    return Array.isArray(this.Permissions) ? this.Permissions.map((permission) => permission.name) : [];
  }

  toPublicJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      permissions: this.permissionNames(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = (sequelize) => {
  Role.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: { msg: 'A role with this name already exists' },
        validate: { notEmpty: { msg: 'Role name is required' } }
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: true
      }
    },
    {
      sequelize,
      modelName: 'Role',
      tableName: 'roles'
    }
  );

  Role.associate = ({ Permission, RolePermission, User }) => {
    Role.belongsToMany(Permission, {
      through: RolePermission,
      foreignKey: 'roleId',
      otherKey: 'permissionId',
      as: 'Permissions'
    });
    Role.hasMany(User, { foreignKey: 'roleId', as: 'Users' });
  };

  return Role;
};
