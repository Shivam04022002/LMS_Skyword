'use strict';

const { Sequelize } = require('sequelize');
const config = require('./env');

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mysql',
  logging: config.isProduction ? false : (sql) => console.log(`[sequelize] ${sql}`),
  define: {
    // Model attributes stay camelCase in JS, columns stay snake_case in MySQL.
    underscored: true,
    timestamps: true,
    freezeTableName: true
  },
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

/**
 * Verifies that MySQL is reachable with the configured credentials.
 * Throws on failure so the caller can decide whether to abort startup.
 */
async function connectDatabase() {
  await sequelize.authenticate();
  console.log(`[database] Connected to MySQL database "${config.db.name}" at ${config.db.host}:${config.db.port}`);
}

module.exports = { sequelize, connectDatabase };
