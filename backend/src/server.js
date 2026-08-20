'use strict';

const app = require('./app');
const config = require('./config/env');
const { sequelize, connectDatabase } = require('./config/database');
const { migrateUp, getPending } = require('./utils/migrator');
require('./models'); // registers the models on the shared Sequelize instance

let server;

async function start() {
  try {
    await connectDatabase();

    // Development applies pending migrations automatically. Production never
    // changes the schema implicitly — it refuses to start instead, so a deploy
    // cannot half-migrate a live database.
    if (config.isProduction) {
      const pending = await getPending();
      if (pending.length > 0) {
        throw new Error(
          `${pending.length} pending migration(s): ${pending.join(', ')}. Run "npm run db:migrate" before starting.`
        );
      }
    } else {
      await migrateUp();
    }
  } catch (error) {
    console.error('[startup] Unable to connect to MySQL. The API was NOT started.');
    console.error(`[startup] ${error.name}: ${error.message}`);
    console.error(
      `[startup] Check that MySQL is running and that DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD in backend/.env are correct ` +
        `(currently host=${config.db.host}:${config.db.port}, database=${config.db.name}, user=${config.db.user}).`
    );
    process.exit(1);
  }

  server = app.listen(config.port, () => {
    // In production the API sits behind a reverse proxy on a real hostname, so
    // printing a localhost URL there would be misleading. The port is what the
    // process actually knows about itself.
    const listeningOn = config.isProduction ? `port ${config.port}` : `http://localhost:${config.port}`;
    console.log(`[server] LMS API listening on ${listeningOn} (${config.env})`);
    console.log(`[server] Allowed origins: ${config.frontendUrls.join(', ')}`);
    if (!config.isProduction) {
      console.log(`[server] Health check: http://localhost:${config.port}/api/health`);
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] Port ${config.port} is already in use.`);
    } else {
      console.error('[server] Failed to start:', error);
    }
    process.exit(1);
  });
}

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down...`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await sequelize.close();
  process.exit(0);
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    shutdown(signal).catch(() => process.exit(1));
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

start();
