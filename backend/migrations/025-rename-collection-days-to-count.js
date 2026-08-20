'use strict';

/**
 * `collection_days` counted daily instalments. The same number now counts
 * weekly and bi-weekly collections too, so the column says what it holds: a
 * count of collections, whatever one collection is for that loan type.
 *
 * A rename preserves every stored value — no loan is re-priced, and no schedule
 * is regenerated.
 */

const TABLE = 'loans';

module.exports = {
  async up(queryInterface) {
    await queryInterface.renameColumn(TABLE, 'collection_days', 'collection_count');
  },

  async down(queryInterface) {
    await queryInterface.renameColumn(TABLE, 'collection_count', 'collection_days');
  }
};
