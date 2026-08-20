'use strict';

const { DataTypes, Model } = require('sequelize');
const bcrypt = require('bcrypt');
const { USER_STATUS, USER_STATUS_VALUES } = require('../config/roles');

const BCRYPT_SALT_ROUNDS = 12;

class User extends Model {
  /** Timing-safe comparison of a plain-text candidate against the stored hash. */
  async verifyPassword(plainPassword) {
    if (!this.password) return false;
    return bcrypt.compare(plainPassword, this.password);
  }

  /** Permission names granted through this user's role. Requires `Role.Permissions`. */
  permissionNames() {
    if (!this.Role || !Array.isArray(this.Role.Permissions)) return [];
    return this.Role.Permissions.map((permission) => permission.name);
  }

  hasPermission(permissionName) {
    return this.permissionNames().includes(permissionName);
  }

  /** Shape returned to API clients. Never includes the password hash. */
  toPublicJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      role: this.role,
      roleId: this.roleId,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  /** Profile shape for the authenticated user, including effective permissions. */
  toAuthJSON() {
    return { ...this.toPublicJSON(), permissions: this.permissionNames() };
  }
}

module.exports = (sequelize) => {
  User.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
        validate: { notEmpty: { msg: 'Name is required' } }
      },
      email: {
        type: DataTypes.STRING(160),
        allowNull: false,
        unique: { msg: 'This email address is already registered' },
        validate: { isEmail: { msg: 'A valid email address is required' } }
      },
      password: {
        type: DataTypes.STRING(255),
        allowNull: false
      },
      roleId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      // Phase 1 stored the role name directly on the user. It is now normalised
      // into `roles`, and this virtual keeps `user.role` returning "ADMIN" for
      // existing callers (JWT payload, requireRole, API responses).
      role: {
        type: DataTypes.VIRTUAL,
        get() {
          return this.Role ? this.Role.name : null;
        }
      },
      status: {
        type: DataTypes.ENUM(...USER_STATUS_VALUES),
        allowNull: false,
        defaultValue: USER_STATUS.ACTIVE
      }
    },
    {
      sequelize,
      modelName: 'User',
      tableName: 'users',
      // The hash is opt-in so it can never leak through a forgotten `exclude`.
      defaultScope: { attributes: { exclude: ['password'] } },
      scopes: {
        withPassword: { attributes: { include: ['password'] } },
        // Loads the role and its permissions, which is what authorisation needs.
        withRole: {
          include: [
            {
              association: 'Role',
              include: [{ association: 'Permissions', through: { attributes: [] } }]
            }
          ]
        }
      },
      hooks: {
        // Hashing lives on the model, so no call site can ever persist a
        // plain-text password.
        beforeSave: async (user) => {
          if (user.changed('password')) {
            user.password = await bcrypt.hash(user.password, BCRYPT_SALT_ROUNDS);
          }
        },
        beforeValidate: (user) => {
          if (typeof user.email === 'string') {
            user.email = user.email.trim().toLowerCase();
          }
          if (typeof user.name === 'string') {
            user.name = user.name.trim();
          }
        }
      }
    }
  );

  User.associate = ({ Role }) => {
    User.belongsTo(Role, { foreignKey: 'roleId', as: 'Role' });
  };

  return User;
};
