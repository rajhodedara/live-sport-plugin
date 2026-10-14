'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scryptAsync(String(password), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return { salt, hash: Buffer.from(derived).toString('base64url') };
}

async function verifyPassword(password, salt, expectedHash) {
  try {
    const derived = await scryptAsync(String(password), String(salt), SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
    const expected = Buffer.from(String(expectedHash), 'base64url');
    const actual = Buffer.from(derived);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

function createOpaqueToken(prefix, byteLength = 32) {
  return `${prefix || 'nuvio'}_${crypto.randomBytes(byteLength).toString('base64url')}`;
}

function hashOpaqueToken(token, pepper) {
  return crypto.createHmac('sha256', String(pepper)).update(String(token)).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createOpaqueToken,
  hashOpaqueToken,
  normalizeEmail,
};
