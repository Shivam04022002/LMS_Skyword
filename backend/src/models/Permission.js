'use strict';

const { DataTypes, Model } = require('sequelize');

class Permission extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      // `users.view` -> `users`, so the UI can group the catalogue by module.
      module: this.name.split('.')[0]
    };
  }
}

module.exports = (sequelize) => {
  Permission.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: { msg: 'A permission with this name already exists' },
        validate: { notEmpty: { msg: 'Permission name is required' } }
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: true
      }
    },
    {
      sequelize,
      modelName: 'Permission',
      tableName: 'permissions'
    }
  );

  Permission.associate = ({ Role, RolePermission }) => {
    Permission.belongsToMany(Role, {
      through: RolePermission,
      foreignKey: 'permissionId',
      otherKey: 'roleId',
      as: 'Roles'
    });
  };

  return Permission;
};
