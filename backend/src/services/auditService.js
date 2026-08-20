'use strict';

const { AuditLog } = require('../models');

// Anything resembling a credential is dropped before a detail object is stored.
const REDACTED_KEYS = ['password', 'newpassword', 'currentpassword', 'passwordhash', 'token', 'secret'];

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return null;

  return Object.entries(details).reduce((accumulator, [key, value]) => {
    if (REDACTED_KEYS.includes(key.toLowerCase())) return accumulator;
    accumulator[key] = value;
    return accumulator;
  }, {});
}

/**
 * Writes an audit entry.
 *
 * Auditing must never break the operation it records, so failures are logged
 * and swallowed rather than propagated to the caller.
 */
async function record({ actorId = null, action, entity, entityId = null, details = null, ipAddress = null }) {
  try {
    await AuditLog.create({
      userId: actorId,
      action,
      entity,
      entityId: entityId === null ? null : String(entityId),
      details: sanitizeDetails(details),
      ipAddress
    });
  } catch (error) {
    console.error(`[audit] Failed to record ${action} on ${entity}:`, error.message);
  }
}

/** Extracts the actor and client IP from a request. */
function contextFrom(req) {
  return {
    actorId: req.user ? req.user.id : null,
    ipAddress: req.ip || null
  };
}

module.exports = { record, contextFrom, sanitizeDetails };
