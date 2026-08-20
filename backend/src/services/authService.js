'use strict';

const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const { signToken } = require('../utils/jwt');
const { USER_STATUS } = require('../config/roles');

/**
 * Authenticates a set of credentials and issues an access token.
 * The same message is returned for an unknown email and a wrong password so the
 * endpoint cannot be used to enumerate accounts.
 */
async function login({ email, password }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  // withRole is needed so the issued token and the response carry the role name
  // and the effective permission list.
  const user = await User.scope('withPassword', 'withRole').findOne({ where: { email: normalizedEmail } });

  if (!user || !(await user.verifyPassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  if (user.status !== USER_STATUS.ACTIVE) {
    throw ApiError.forbidden('This account is inactive, please contact an administrator');
  }

  const token = signToken({ id: user.id, role: user.role });

  return { token, user: user.toAuthJSON() };
}

/** Returns the profile of an already-authenticated user, with permissions. */
async function getProfile(userId) {
  const user = await User.scope('withRole').findByPk(userId);

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  return user.toAuthJSON();
}

module.exports = { login, getProfile };
