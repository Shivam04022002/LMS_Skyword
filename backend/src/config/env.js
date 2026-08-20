'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

// Variables without a safe default. An empty DB_PASSWORD is legitimate, so it is
// intentionally not part of this list.
const REQUIRED_VARS = ['DB_HOST', 'DB_NAME', 'DB_USER', 'JWT_SECRET'];

const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `[config] Missing required environment variable(s): ${missing.join(', ')}\n` +
      '[config] Copy backend/.env.example to backend/.env and fill in the values.'
  );
  process.exit(1);
}

const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * Browser origins allowed to call this API.
 *
 * FRONTEND_URL accepts a comma-separated list, so one deployment can serve the
 * production site while a developer still runs Vite against it. Trailing
 * slashes are stripped because an Origin header never carries one, and a value
 * like "https://lms.skywordfinance.com/" would otherwise never match.
 *
 * The default is local development only. Production sets the real origin in
 * backend/.env — no deployment hostname is baked into the code.
 */
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:5174'];

function parseOrigins(raw) {
  if (!raw || !String(raw).trim()) return DEV_ORIGINS;

  const origins = String(raw)
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return origins.length > 0 ? [...new Set(origins)] : DEV_ORIGINS;
}

const frontendUrls = parseOrigins(process.env.FRONTEND_URL);

const config = {
  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: Number(process.env.PORT) || 5000,
  // Every allowed origin, and the canonical one for anything that needs a
  // single URL (links in a future email, for instance).
  frontendUrls,
  frontendUrl: frontendUrls[0],
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || ''
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d'
  },
  // Consumed exclusively by the admin seed script.
  seedAdmin: {
    name: process.env.ADMIN_NAME,
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD
  }
};

if (config.isProduction && config.jwt.secret === 'change_this_secret') {
  console.error('[config] JWT_SECRET still holds the example value. Refusing to start in production.');
  process.exit(1);
}

module.exports = config;
