'use strict';

const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const { sequelize } = require('../config/database');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
const META_TABLE = 'sequelize_meta';

/**
 * Minimal migration runner.
 *
 * Migration files use the standard `up(queryInterface, Sequelize)` /
 * `down(queryInterface, Sequelize)` signature and the same `sequelize_meta`
 * bookkeeping table as sequelize-cli, so the project can move to sequelize-cli
 * or umzug later without rewriting a single migration.
 */

async function ensureMetaTable() {
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS \`${META_TABLE}\` (
       \`name\` VARCHAR(255) NOT NULL,
       PRIMARY KEY (\`name\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

/** Migration files in deterministic (filename) order. */
function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort();
}

async function getExecuted() {
  await ensureMetaTable();
  const [rows] = await sequelize.query(`SELECT \`name\` FROM \`${META_TABLE}\` ORDER BY \`name\``);
  return rows.map((row) => row.name);
}

async function getPending() {
  const executed = new Set(await getExecuted());
  return listMigrationFiles().filter((file) => !executed.has(file));
}

/** Applies every pending migration in order. Returns the names applied. */
async function migrateUp() {
  const pending = await getPending();
  const queryInterface = sequelize.getQueryInterface();
  const applied = [];

  for (const file of pending) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    console.log(`[migrate] applying ${file}`);
    await migration.up(queryInterface, Sequelize);
    await sequelize.query(`INSERT INTO \`${META_TABLE}\` (\`name\`) VALUES (?)`, { replacements: [file] });
    applied.push(file);
  }

  if (applied.length === 0) {
    console.log('[migrate] no pending migrations');
  } else {
    console.log(`[migrate] applied ${applied.length} migration(s)`);
  }

  return applied;
}

/** Reverts the most recently applied migration. */
async function migrateDown() {
  const executed = await getExecuted();
  if (executed.length === 0) {
    console.log('[migrate] nothing to revert');
    return null;
  }

  const last = executed[executed.length - 1];
  const migration = require(path.join(MIGRATIONS_DIR, last));

  if (typeof migration.down !== 'function') {
    throw new Error(`Migration ${last} has no down() and cannot be reverted`);
  }

  console.log(`[migrate] reverting ${last}`);
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await sequelize.query(`DELETE FROM \`${META_TABLE}\` WHERE \`name\` = ?`, { replacements: [last] });

  return last;
}

async function status() {
  const executed = await getExecuted();
  const all = listMigrationFiles();
  return {
    executed,
    pending: all.filter((file) => !executed.includes(file)),
    total: all.length
  };
}

module.exports = { migrateUp, migrateDown, status, getPending, MIGRATIONS_DIR };
