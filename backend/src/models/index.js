'use strict';

const { sequelize } = require('../config/database');

const User = require('./User')(sequelize);
const Role = require('./Role')(sequelize);
const Permission = require('./Permission')(sequelize);
const RolePermission = require('./RolePermission')(sequelize);
const AuditLog = require('./AuditLog')(sequelize);
const Customer = require('./Customer')(sequelize);
const CifSequence = require('./CifSequence')(sequelize);
const LoanParty = require('./LoanParty')(sequelize);
const Loan = require('./Loan')(sequelize);
const LoanSequence = require('./LoanSequence')(sequelize);
const EmiSchedule = require('./EmiSchedule')(sequelize);
const Collection = require('./Collection')(sequelize);
const CollectionAllocation = require('./CollectionAllocation')(sequelize);
const CollectionSequence = require('./CollectionSequence')(sequelize);
const Route = require('./Route')(sequelize);
const RouteSequence = require('./RouteSequence')(sequelize);
const RouteCollector = require('./RouteCollector')(sequelize);
const LoanRoute = require('./LoanRoute')(sequelize);

const models = {
  User,
  Role,
  Permission,
  RolePermission,
  AuditLog,
  Customer,
  CifSequence,
  LoanParty,
  Loan,
  LoanSequence,
  EmiSchedule,
  Collection,
  CollectionAllocation,
  CollectionSequence,
  Route,
  RouteSequence,
  RouteCollector,
  LoanRoute
};

Object.values(models).forEach((model) => {
  if (typeof model.associate === 'function') {
    model.associate(models);
  }
});

module.exports = { sequelize, ...models };
