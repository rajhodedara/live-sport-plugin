/**
 * DashCencEngine — facade over the `cenc/` primitives.
 *
 * The ISO-BMFF parsing and the AES-CTR work live in `cenc/*`; this file exists
 * so the rest of the app has one stable import point and does not need to know
 * how the modules are split.
 *
 * See docs/DASH_CLEARKEY_HLS_IMPLEMENTATION_PLAN.md for the contract.
 */

'use strict';

const {
  parseInit,
  uncloakInit,
  decryptSegment,
  CencError
} = require('./cenc');

module.exports = { parseInit, uncloakInit, decryptSegment, CencError };
