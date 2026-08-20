'use strict';

/**
 * Creates the first administrator from environment variables.
 *
 *   ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD  (see backend/.env.example)
 *   npm run seed:admin
 *
 * The password is never stored in source and is hashed by the User model's
 * beforeSave hook before it reaches MySQL.
 */

const { sequelize, connectDatabase } = require('../config/database');
const { User, Role } = require('../models');
const config = require('../config/env');
const { ROLES, USER_STATUS } = require('../config/roles');

const WEAK_PLACEHOLDERS = ['change_me', 'password', 'admin'];

async function seedAdmin() {
  const { name, email, password } = config.seedAdmin;

  if (!name || !email || !password) {
    console.error('[seed:admin] ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD must all be set in backend/.env');
    process.exitCode = 1;
    return;
  }

  const isWeak = password.length < 8 || WEAK_PLACEHOLDERS.includes(password.toLowerCase());
  if (isWeak) {
    if (config.isProduction) {
      console.error('[seed:admin] ADMIN_PASSWORD is a placeholder or shorter than 8 characters. Refusing to seed in production.');
      process.exitCode = 1;
      return;
    }
    console.warn('[seed:admin] Warning: ADMIN_PASSWORD is weak. Acceptable for local development only.');
  }

  const roleName = (process.env.ADMIN_ROLE || ROLES.ADMIN).toUpperCase();
  if (!Object.values(ROLES).includes(roleName)) {
    console.error(`[seed:admin] ADMIN_ROLE "${roleName}" is not one of: ${Object.values(ROLES).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  try {
    await connectDatabase();

    const role = await Role.findOne({ where: { name: roleName } });
    if (!role) {
      console.error(`[seed:admin] Role "${roleName}" does not exist. Run "npm run db:migrate" and "npm run seed:rbac" first.`);
      process.exitCode = 1;
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await User.scope('withRole').findOne({ where: { email: normalizedEmail } });

    if (existing) {
      console.log(`[seed:admin] User "${normalizedEmail}" already exists (id=${existing.id}, role=${existing.role}, status=${existing.status}). Nothing to do.`);
      console.log('[seed:admin] To seed a different administrator, change ADMIN_EMAIL in backend/.env.');
      return;
    }

    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      roleId: role.id,
      status: USER_STATUS.ACTIVE
    });

    console.log(`[seed:admin] Created administrator id=${user.id} email=${user.email} role=${roleName}`);
  } catch (error) {
    console.error(`[seed:admin] Failed: ${error.message}`);
    if (/doesn't exist|Unknown table|no such table/i.test(error.message)) {
      console.error('[seed:admin] Run "npm run db:migrate" first to create the tables.');
    }
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

seedAdmin();
