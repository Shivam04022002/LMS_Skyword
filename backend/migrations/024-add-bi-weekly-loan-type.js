'use strict';

/**
 * Bi-weekly collection: one instalment every 14 days.
 *
 * Adding a value to the end of an ENUM is an in-place change in MySQL 8 — no
 * row is rewritten and no existing loan_type value is touched. Every loan
 * already in the table keeps DAILY, WEEKLY or MONTHLY exactly as stored.
 */

const TABLE = 'loans';
const WITH_BI_WEEKLY = "ENUM('DAILY','WEEKLY','MONTHLY','BI_WEEKLY')";
const WITHOUT_BI_WEEKLY = "ENUM('DAILY','WEEKLY','MONTHLY')";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`loan_type\` ${WITH_BI_WEEKLY} NOT NULL`);
  },

  async down(queryInterface) {
    // Refuses rather than silently rewriting live loans to another frequency.
    const [rows] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n FROM \`${TABLE}\` WHERE loan_type = 'BI_WEEKLY'`
    );
    if (Number(rows[0]?.n ?? 0) > 0) {
      throw new Error(`Cannot remove BI_WEEKLY: ${rows[0].n} loan(s) still use it`);
    }
    await queryInterface.sequelize.query(`ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`loan_type\` ${WITHOUT_BI_WEEKLY} NOT NULL`);
  }
};
