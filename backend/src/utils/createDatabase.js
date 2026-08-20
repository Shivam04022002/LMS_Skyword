'use strict';

/**
 * Creates the MySQL schema named by DB_NAME if it does not exist yet.
 * Sequelize can only connect to an existing database, so this runs first.
 *
 *   npm run db:create
 */

const mysql = require('mysql2/promise');
const config = require('../config/env');

async function createDatabase() {
  let connection;

  try {
    connection = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password
    });

    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    console.log(`[db:create] Database "${config.db.name}" is ready.`);
  } catch (error) {
    console.error(`[db:create] Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
  }
}

createDatabase();
