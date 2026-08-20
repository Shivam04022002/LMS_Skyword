'use strict';

const { validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

/**
 * Runs a list of express-validator chains and converts any failures into a
 * single 422 response using the standard error envelope.
 */
function validate(validations) {
  return async (req, res, next) => {
    await Promise.all(validations.map((validation) => validation.run(req)));

    const result = validationResult(req);
    if (result.isEmpty()) {
      return next();
    }

    const errors = result.array().map((error) => ({
      field: error.path ?? error.param,
      message: error.msg
    }));

    return next(ApiError.validation('Validation failed', errors));
  };
}

module.exports = validate;
