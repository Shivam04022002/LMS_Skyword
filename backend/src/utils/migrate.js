'use strict';

/**
 * Migration CLI.
 *
 *   npm run db:migrate           apply all pending migrations
 *   npm run db:migrate:status    show applied / pending
 *   npm run db:migrate:undo      revert the most recent migration
 */

const { sequelize, connectDatabase } = require('../config/database');
const { migrateUp, migrateDown, status } = require('./migrator');

const command = process.argv[2] || 'up';

async function run() {
  try {
    await connectDatabase();

    if (command === 'up') {
      await migrateUp();
    } else if (command === 'down') {
      await migrateDown();
    } else if (command === 'status') {
      const report = await status();
      console.log(`[migrate] ${report.executed.length}/${report.total} applied`);
      report.executed.forEach((name) => console.log(`  applied  ${name}`));
      report.pending.forEach((name) => console.log(`  pending  ${name}`));
    } else {
      console.error(`[migrate] Unknown command "${command}". Use: up | down | status`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[migrate] Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

run();
