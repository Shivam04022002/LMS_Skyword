'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const config = require('./config/env');
const routes = require('./routes');
const notFoundHandler = require('./middleware/notFoundHandler');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();

// Behind a reverse proxy this makes req.ip (and therefore rate limiting) accurate.
app.set('trust proxy', 1);

app.use(helmet());
// An allow-LIST, not a wildcard: credentials are sent with every request, so
// the browser is told precisely which origins may read the response.
app.use(
  cors({
    origin: config.frontendUrls,
    credentials: true
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(morgan(config.isProduction ? 'combined' : 'dev'));

app.use('/api', apiLimiter, routes);

// Unmatched routes and every thrown error leave through the same JSON envelope.
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
