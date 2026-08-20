'use strict';

const express = require('express');
const config = require('../config/env');

const router = express.Router();

/** GET /api/health — liveness probe for local development and deployments. */
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'LMS API is running',
    environment: config.env
  });
});

module.exports = router;
