'use strict';

const { DataTypes, Model } = require('sequelize');
const { normalizeMobile } = require('../utils/mobile');
const { CUSTOMER_STATUS, CUSTOMER_STATUS_VALUES, GENDER_VALUES, MARITAL_STATUS_VALUES } = require('../config/customers');

/**
 * A customer is a reusable person record identified by an immutable CIFID.
 *
 * There is deliberately no applicant/co-applicant/guarantor column: a later
 * phase relates customers to loans through a join table, so one person is one
 * row regardless of how many loans they participate in.
 */
class Customer extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      cifId: this.cifId,
      firstName: this.firstName,
      middleName: this.middleName,
      lastName: this.lastName,
      fullName: this.fullName,
      mobile: this.mobile,
      alternateMobile: this.alternateMobile,
      email: this.email,
      dateOfBirth: this.dateOfBirth,
      gender: this.gender,
      fatherName: this.fatherName,
      motherName: this.motherName,
      maritalStatus: this.maritalStatus,
      occupation: this.occupation,
      addressLine1: this.addressLine1,
      addressLine2: this.addressLine2,
      city: this.city,
      state: this.state,
      pincode: this.pincode,
      status: this.status,
      createdBy: this.CreatedBy ? { id: this.CreatedBy.id, name: this.CreatedBy.name } : null,
      updatedBy: this.UpdatedBy ? { id: this.UpdatedBy.id, name: this.UpdatedBy.name } : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

/** Backend-owned: "Rahul Kumar Sharma" from the three name parts. */
function buildFullName({ firstName, middleName, lastName }) {
  return [firstName, middleName, lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
}

module.exports = (sequelize) => {
  Customer.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      cifId: {
        type: DataTypes.STRING(10),
        allowNull: false,
        unique: { msg: 'This CIFID already exists' }
      },
      firstName: {
        type: DataTypes.STRING(60),
        allowNull: false,
        validate: { notEmpty: { msg: 'First name is required' } }
      },
      middleName: { type: DataTypes.STRING(60), allowNull: true },
      lastName: { type: DataTypes.STRING(60), allowNull: true },
      // Derived from the parts above; never accepted from a client.
      fullName: {
        type: DataTypes.STRING(190),
        allowNull: false
      },
      mobile: {
        type: DataTypes.STRING(10),
        allowNull: false,
        validate: { is: { args: /^[6-9]\d{9}$/, msg: 'A valid 10-digit Indian mobile number is required' } }
      },
      alternateMobile: {
        type: DataTypes.STRING(10),
        allowNull: true,
        validate: { is: { args: /^[6-9]\d{9}$/, msg: 'A valid 10-digit Indian mobile number is required' } }
      },
      email: {
        type: DataTypes.STRING(160),
        allowNull: true,
        validate: { isEmail: { msg: 'A valid email address is required' } }
      },
      dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
      gender: { type: DataTypes.ENUM(...GENDER_VALUES), allowNull: true },
      fatherName: { type: DataTypes.STRING(120), allowNull: true },
      motherName: { type: DataTypes.STRING(120), allowNull: true },
      maritalStatus: { type: DataTypes.ENUM(...MARITAL_STATUS_VALUES), allowNull: true },
      occupation: { type: DataTypes.STRING(120), allowNull: true },
      addressLine1: { type: DataTypes.STRING(255), allowNull: true },
      addressLine2: { type: DataTypes.STRING(255), allowNull: true },
      city: { type: DataTypes.STRING(80), allowNull: true },
      state: { type: DataTypes.STRING(80), allowNull: true },
      pincode: {
        type: DataTypes.STRING(6),
        allowNull: true,
        validate: { is: { args: /^\d{6}$/, msg: 'Pincode must be 6 digits' } }
      },
      status: {
        type: DataTypes.ENUM(...CUSTOMER_STATUS_VALUES),
        allowNull: false,
        defaultValue: CUSTOMER_STATUS.ACTIVE
      },
      createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
    },
    {
      sequelize,
      modelName: 'Customer',
      tableName: 'customers',
      hooks: {
        // Normalisation lives on the model so no call site can persist a
        // differently-formatted mobile or a client-supplied full name.
        beforeValidate: (customer) => {
          ['firstName', 'middleName', 'lastName', 'fatherName', 'motherName', 'occupation', 'city', 'state'].forEach((field) => {
            if (typeof customer[field] === 'string') {
              customer[field] = customer[field].trim();
            }
          });

          if (customer.mobile !== undefined && customer.mobile !== null) {
            customer.mobile = normalizeMobile(customer.mobile) ?? customer.mobile;
          }

          if (customer.alternateMobile) {
            customer.alternateMobile = normalizeMobile(customer.alternateMobile) ?? customer.alternateMobile;
          } else if (customer.alternateMobile === '') {
            customer.alternateMobile = null;
          }

          if (typeof customer.email === 'string') {
            const email = customer.email.trim().toLowerCase();
            customer.email = email === '' ? null : email;
          }

          customer.fullName = buildFullName(customer);
        }
      }
    }
  );

  Customer.associate = ({ User }) => {
    Customer.belongsTo(User, { foreignKey: 'createdBy', as: 'CreatedBy' });
    Customer.belongsTo(User, { foreignKey: 'updatedBy', as: 'UpdatedBy' });
  };

  return Customer;
};

module.exports.buildFullName = buildFullName;
