'use strict';

/**
 * Seeds roles, permissions and the role→permission grants.
 *
 *   npm run seed:rbac
 *
 * Idempotent: re-running never creates duplicates. It also re-applies the
 * matrix, so adding a permission to config/permissions.js and re-running is the
 * supported way to roll out new permissions in later phases.
 */

const { sequelize, connectDatabase } = require('../config/database');
const { Role, Permission } = require('../models');
const {
  PERMISSION_DEFINITIONS,
  ROLE_DEFINITIONS,
  ROLE_PERMISSION_MATRIX,
  ALL_PERMISSIONS
} = require('../config/permissions');

async function seedRoles() {
  let created = 0;

  for (const definition of ROLE_DEFINITIONS) {
    const [role, wasCreated] = await Role.findOrCreate({
      where: { name: definition.name },
      defaults: definition
    });

    if (wasCreated) {
      created += 1;
    } else if (role.description !== definition.description) {
      await role.update({ description: definition.description });
    }
  }

  console.log(`[seed:rbac] roles: ${created} created, ${ROLE_DEFINITIONS.length - created} already present`);
}

async function seedPermissions() {
  let created = 0;

  for (const definition of PERMISSION_DEFINITIONS) {
    const [permission, wasCreated] = await Permission.findOrCreate({
      where: { name: definition.name },
      defaults: definition
    });

    if (wasCreated) {
      created += 1;
    } else if (permission.description !== definition.description) {
      await permission.update({ description: definition.description });
    }
  }

  console.log(`[seed:rbac] permissions: ${created} created, ${PERMISSION_DEFINITIONS.length - created} already present`);
}

async function seedGrants() {
  const allPermissions = await Permission.findAll();
  const permissionByName = new Map(allPermissions.map((permission) => [permission.name, permission]));

  for (const [roleName, grant] of Object.entries(ROLE_PERMISSION_MATRIX)) {
    const role = await Role.findOne({ where: { name: roleName } });
    if (!role) continue;

    const granted = grant === ALL_PERMISSIONS ? allPermissions : grant.map((name) => permissionByName.get(name)).filter(Boolean);

    // setPermissions makes the stored grants match the matrix exactly, which is
    // what makes repeated runs safe.
    await role.setPermissions(granted);
    console.log(`[seed:rbac] ${roleName}: ${granted.length} permission(s)`);
  }
}

async function run() {
  try {
    await connectDatabase();
    await seedRoles();
    await seedPermissions();
    await seedGrants();
    console.log('[seed:rbac] Done.');
  } catch (error) {
    console.error(`[seed:rbac] Failed: ${error.message}`);
    if (/doesn't exist|Unknown table|no such table/i.test(error.message)) {
      console.error('[seed:rbac] Run "npm run db:migrate" first to create the tables.');
    }
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

run();
