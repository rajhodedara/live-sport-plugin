'use strict';
const state = require('./ResolverConflictState');

function createResolverConflictGate(conflictState = state) {
  return function resolverConflictGate(req, res, next) {
    let conflict = true;
    try { conflict = conflictState.hasConflict() !== false; } catch (_) { /* fail closed */ }
    if (!conflict) return next();
    return res.status(503).send('Internal stream resolver unavailable.');
  };
}

module.exports = createResolverConflictGate();
module.exports.createResolverConflictGate = createResolverConflictGate;
