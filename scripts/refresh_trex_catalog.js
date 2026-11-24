#!/usr/bin/env node
'use strict';

/**
 * Rebuilds the Trex catalog database from the upstream generic catalog.
 *
 *   node scripts/refresh_trex_catalog.js --db data/trex_catalog.sqlite
 *   node scripts/refresh_trex_catalog.js --from-csv trex_channels.csv
 *
 * Runs as a standalone nightly cron job on the VPS, never inside a worker:
 * it pages the catalog in small batches, keeps only compact { id, name, type }
 * tuples, and replaces the database in one transaction (WAL keeps readers on
 * the previous catalog until the commit). On any failure the database is left
 * exactly as it was and the process exits 1.
 *
 * The manifest URL is never logged; failures report a bounded kind only.
 */

// Cron does not inherit the application environment, and the manifest URL is a
// secret that must never live in the crontab. Load the app's .env when the job
// runs from the deploy directory; --base-url or an exported variable still wins
// when dotenv or the file is absent.
try {
  require('dotenv').config({ quiet: true });
} catch (_) {
  /* standalone use without dotenv */
}
const fs = require('fs');
const path = require('path');

const { writeCatalogFile } = require('../src/services/TrexCatalogDb');

const CATALOG_ID = 'flix-live-tv-v2-trex';
const PAGE_SIZE = 100;
const DEFAULT_DB = path.join('data', 'trex_catalog.sqlite');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function errorKind(error) {
  return String((error && (error.code || error.name)) || 'Error').replace(/[^a-z0-9_.-]/gi, '').slice(0, 80);
}

/** Minimal RFC 4180 line parser: double quotes, doubled-quote escapes, no embedded newlines. */
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  const text = String(line == null ? '' : line).replace(/\r$/, '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function readCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/);
  const metas = [];
  let header = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (header) {
      header = false;
      continue;
    }
    const fields = parseCsvLine(line);
    const id = (fields[0] || '').trim();
    const name = (fields[1] || '').trim();
    if (!id || !name) continue;
    metas.push({ id, name, type: (fields[3] || 'tv').trim() || 'tv' });
  }
  return metas;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      parsed[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function baseFromEnv() {
  return String(process.env.KAFKA_MANIFEST_URL || '')
    .replace(/\/manifest\.json$/, '')
    .replace(/\/+$/, '');
}

async function fetchJsonPage(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`catalog page request failed: HTTP ${response.status}`);
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    const body = await response.json();
    const metas = Array.isArray(body && body.metas) ? body.metas : [];
    return metas
      .map((meta) => ({
        id: meta && meta.id ? String(meta.id) : '',
        name: meta && meta.name ? String(meta.name) : '',
        type: meta && meta.type ? String(meta.type) : 'tv'
      }))
      .filter((meta) => meta.id && meta.name);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pages the catalog with `skip=` in batches of `concurrency` requests and
 * stops at the first page shorter than `pageSize`. Returns
 * { metas, pages, truncated } where `truncated` means `maxPages` was reached
 * before a short page.
 */
async function fetchCatalogRows({
  baseUrl,
  catalogId = CATALOG_ID,
  pageSize = PAGE_SIZE,
  concurrency = 4,
  maxPages = 600,
  fetchImpl = global.fetch,
  timeoutMs = 15000
} = {}) {
  if (!baseUrl) throw new Error('missing upstream base URL');
  const base = String(baseUrl).replace(/\/manifest\.json$/, '').replace(/\/+$/, '');
  const batch = Math.max(1, Math.min(8, Number(concurrency) || 1));
  const pagesLimit = Math.max(1, Number(maxPages) || 1);

  const metas = [];
  let pages = 0;
  let done = false;

  for (let start = 0; start < pagesLimit && !done; start += batch) {
    const skips = [];
    for (let index = start; index < Math.min(start + batch, pagesLimit); index += 1) {
      skips.push(index * pageSize);
    }
    const results = await Promise.all(
      skips.map((skip) => fetchJsonPage(`${base}/catalog/tv/${catalogId}/skip=${skip}.json`, fetchImpl, timeoutMs))
    );
    for (const pageMetas of results) {
      pages += 1;
      metas.push(...pageMetas);
      if (pageMetas.length < pageSize) {
        done = true;
        break;
      }
    }
  }

  return { metas, pages, truncated: !done };
}

async function run(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const quiet = Boolean(args.quiet);
  const dbPath = typeof args.db === 'string' ? args.db : DEFAULT_DB;

  try {
    if (typeof args['from-csv'] === 'string') {
      const metas = readCsv(args['from-csv']);
      if (metas.length === 0) {
        console.error('[trex-refresh] CSV produced no channels');
        return 1;
      }
      const stats = writeCatalogFile(dbPath, metas, { generatedAt: new Date().toISOString(), source: 'csv' });
      if (!quiet) {
        console.log(`[trex-refresh] csv: ${stats.rows} channels (${stats.teamChannels} team, ${stats.linearChannels} linear, ${stats.eventChannels} event), ${stats.keys} keys`);
      }
      return 0;
    }

    const baseUrl = (typeof args['base-url'] === 'string' && args['base-url']) || baseFromEnv();
    if (!baseUrl) {
      console.error('[trex-refresh] no upstream base URL (set KAFKA_MANIFEST_URL or pass --base-url)');
      return 1;
    }

    const startedAt = Date.now();
    const { metas, pages, truncated } = await fetchCatalogRows({
      baseUrl,
      concurrency: args.concurrency,
      maxPages: args['max-pages'],
      fetchImpl: deps.fetchImpl
    });
    if (metas.length === 0) {
      console.error('[trex-refresh] upstream returned no channels');
      return 1;
    }
    const stats = writeCatalogFile(dbPath, metas, { generatedAt: new Date().toISOString(), source: 'live' });
    if (!quiet) {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[trex-refresh] live: ${stats.rows} channels (${stats.teamChannels} team, ${stats.linearChannels} linear, ${stats.eventChannels} event), ` +
          `${stats.keys} keys, ${pages} page(s) in ${seconds}s${truncated ? ' (truncated at --max-pages)' : ''}`
      );
    }
    return 0;
  } catch (error) {
    console.error(`[trex-refresh] failed: ${errorKind(error)}`);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  CATALOG_ID,
  parseCsvLine,
  readCsv,
  parseArgs,
  fetchCatalogRows,
  run
};
