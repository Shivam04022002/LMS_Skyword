'use strict';

/**
 * Normalises the user role: `users.role` (ENUM) becomes `users.role_id` (FK).
 *
 * Existing rows — including the Phase 1 administrator — are backfilled by
 * matching the old ENUM value against roles.name, so no account loses its role
 * and no data is deleted.
 */

const TABLE = 'users';
const FK_NAME = 'fk_users_role_id';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable(TABLE);

    if (!columns.role_id) {
      // Nullable at first so existing rows can be backfilled before the
      // NOT NULL constraint is applied.
      await queryInterface.addColumn(TABLE, 'role_id', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true
      });
    }

    if (columns.role) {
      await queryInterface.sequelize.query(
        'UPDATE `users` AS u JOIN `roles` AS r ON r.`name` = u.`role` SET u.`role_id` = r.`id` WHERE u.`role_id` IS NULL'
      );
    }

    // Safety net for rows whose ENUM value has no matching role.
    await queryInterface.sequelize.query(
      "UPDATE `users` SET `role_id` = (SELECT `id` FROM `roles` WHERE `name` = 'STAFF') WHERE `role_id` IS NULL"
    );

    await queryInterface.changeColumn(TABLE, 'role_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false
    });

    await queryInterface.addConstraint(TABLE, {
      fields: ['role_id'],
      type: 'foreign key',
      name: FK_NAME,
      references: { table: 'roles', field: 'id' },
      onUpdate: 'CASCADE',
      // A role that still has users must not be removable.
      onDelete: 'RESTRICT'
    });

    if (columns.role) {
      await queryInterface.removeColumn(TABLE, 'role');
    }
  },

  async down(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable(TABLE);

    if (!columns.role) {
      await queryInterface.addColumn(TABLE, 'role', {
        type: Sequelize.ENUM('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'COLLECTOR', 'STAFF'),
        allowNull: false,
        defaultValue: 'STAFF'
      });
    }

    await queryInterface.sequelize.query(
      'UPDATE `users` AS u JOIN `roles` AS r ON r.`id` = u.`role_id` SET u.`role` = r.`name`'
    );

    await queryInterface.removeConstraint(TABLE, FK_NAME);
    await queryInterface.removeColumn(TABLE, 'role_id');
  }
};
