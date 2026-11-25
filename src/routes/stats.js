'use strict';

const crypto = require('node:crypto');
const express = require('express');
const container = require('../container');
const { isLocalDirectRequest } = require('../services/localRequest');

const router = express.Router();

function safeTokenEquals(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAuthorizedStatsRequest(req) {
  if (isLocalDirectRequest(req)) return true;

  const expectedToken = (process.env.STATS_TOKEN || '').trim();
  if (!expectedToken) return false;

  const authHeader = req.headers && req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (safeTokenEquals(bearer, expectedToken)) return true;
  }

  const queryToken = req.query && typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (queryToken && safeTokenEquals(queryToken, expectedToken)) return true;

  return false;
}

router.get('/api/stats', (req, res) => {
  if (!isAuthorizedStatsRequest(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const daysParam = req.query && req.query.days ? parseInt(req.query.days, 10) : 14;
  const days = Number.isFinite(daysParam) ? daysParam : 14;

  const usageStatsService = container.resolve('usageStatsService');
  res.setHeader('Cache-Control', 'no-store');
  return res.json(usageStatsService.getSummary(new Date(), days));
});

module.exports = router;
