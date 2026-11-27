'use strict';

const crypto = require('crypto');
const { DISCORD_SNOWFLAKE_RE, ED25519_SPKI_PREFIX } = require('./authConfig');

const INTERACTION_WINDOW_MS = 5 * 60 * 1000;
const COMMAND_FUTURE_SKEW_MS = 30 * 1000;
const INTERACTION_DEADLINE_MS = 2500;
const EPHEMERAL_FLAG = 64;
const SIGNATURE_HEX_RE = /^[0-9a-fA-F]{128}$/;
const TIMESTAMP_SEC_RE = /^\d{1,15}$/;

function createEd25519PublicKey(hex) {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

function verifyDiscordSignature({ publicKey, timestamp, rawBody, signatureHex }) {
  if (!publicKey || !Buffer.isBuffer(rawBody)) return false;
  if (typeof timestamp !== 'string' || !TIMESTAMP_SEC_RE.test(timestamp)) return false;
  if (typeof signatureHex !== 'string' || !SIGNATURE_HEX_RE.test(signatureHex)) return false;
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  try {
    return crypto.verify(null, message, publicKey, Buffer.from(signatureHex, 'hex'));
  } catch (_) {
    return false;
  }
}

function ephemeralReply(content) {
  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] },
      content,
    },
  };
}

function formatTokenReply(token, canonicalOrigin) {
  const accountUrl = canonicalOrigin ? `${canonicalOrigin}/account` : '/account';
  return [
    'Your private Nuvio sign-in token (reusable, does not expire):',
    '```',
    token,
    '```',
    `Open ${accountUrl}, choose **Access token**, and paste it. Keep this token private — anyone with it can sign in to your account.`,
  ].join('\n');
}

/**
 * Builds the Express handler for signed Discord HTTP interactions (`PING` and `/token`).
 * Avoids logging request bodies, tokens, or interaction payloads.
 */
function createDiscordInteractionHandler({ service, config, now = () => Date.now(), deadlineMs = INTERACTION_DEADLINE_MS }) {
  const discordConfig = (config && config.discord) || {};
  const publicKey = discordConfig.enabled && discordConfig.publicKeyHex
    ? createEd25519PublicKey(discordConfig.publicKeyHex)
    : null;

  return function discordInteractionHandler(req, res) {
    if (!discordConfig.enabled || !publicKey) {
      return res.status(404).json({ error: 'discord_disabled' });
    }

    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent) res.status(503).json({ error: 'interaction_timeout' });
    }, deadlineMs);
    deadlineTimer.unref();
    const clearDeadline = () => clearTimeout(deadlineTimer);
    res.once('finish', clearDeadline);
    res.once('close', clearDeadline);

    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const timestampHeader = req.get('x-signature-timestamp');
    const signatureHeader = req.get('x-signature-ed25519');
    if (!verifyDiscordSignature({
      publicKey,
      timestamp: timestampHeader,
      rawBody: req.body,
      signatureHex: signatureHeader,
    })) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const signedAtMs = Number(timestampHeader) * 1000;
    const nowMs = now();
    if (!Number.isFinite(signedAtMs)
        || nowMs - signedAtMs > INTERACTION_WINDOW_MS
        || signedAtMs - nowMs > INTERACTION_WINDOW_MS) {
      return res.status(401).json({ error: 'stale_timestamp' });
    }

    let interaction;
    try {
      interaction = JSON.parse(req.body.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    if (String(interaction.application_id || '') !== discordConfig.applicationId) {
      return res.status(401).json({ error: 'invalid_application' });
    }

    if (interaction.type === 1) {
      return res.status(200).json({ type: 1 });
    }

    if (interaction.type !== 2) {
      return res.status(400).json({ error: 'unsupported_interaction' });
    }

    if (signedAtMs - nowMs > COMMAND_FUTURE_SKEW_MS) {
      return res.status(401).json({ error: 'stale_timestamp' });
    }

    if (String(interaction.guild_id || '') !== discordConfig.guildId) {
      return res.status(200).json(ephemeralReply('Run `/token` inside the Nuvio Discord server.'));
    }

    const cmd = interaction.data;
    if (!cmd || typeof cmd !== 'object'
        || (cmd.type !== undefined && cmd.type !== 1)
        || cmd.name !== 'token') {
      return res.status(200).json(ephemeralReply('Unknown command. Run `/token` to get a sign-in token.'));
    }

    const interactionId = typeof interaction.id === 'string' ? interaction.id.trim() : '';
    const member = interaction.member;
    const user = member && member.user;
    const userId = user && typeof user.id === 'string' ? user.id.trim() : '';
    if (!interactionId || interactionId.length > 64 || !DISCORD_SNOWFLAKE_RE.test(userId) || user.bot === true) {
      return res.status(200).json(ephemeralReply('Unable to verify your Discord member account.'));
    }

    if (discordConfig.roleId) {
      const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
      if (!roles.includes(discordConfig.roleId)) {
        return res.status(200).json(ephemeralReply('You do not have the required Discord role to generate a sign-in token.'));
      }
    }

    if (timedOut || res.headersSent) return undefined;

    const displayName = String(member.nick || user.global_name || user.username || '').trim().slice(0, 80);
    let issued;
    try {
      issued = service.issueDiscordAccessToken({
        interactionId,
        subject: userId,
        name: displayName,
        signedAtMs,
      });
    } catch (err) {
      if (timedOut || res.headersSent) return undefined;
      if (err && err.code === 'storage_busy') {
        return res.status(200).json(ephemeralReply('Sign-in service is busy right now. Please run `/token` again in a moment.'));
      }
      throw err;
    }

    if (timedOut || res.headersSent) return undefined;
    if (!issued) {
      return res.status(200).json(ephemeralReply('A token was already issued for this command. Run `/token` again if you need a new one.'));
    }

    return res.status(200).json(ephemeralReply(formatTokenReply(issued.token, discordConfig.canonicalOrigin)));
  };
}

module.exports = { createDiscordInteractionHandler, verifyDiscordSignature };
