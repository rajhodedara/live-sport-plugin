import { run } from '../resolve/run.js'
import { serveStatic } from './static.js'
import { cacheGet, cacheClaim, cacheSet, cacheDelete, cachePrune, cacheStats } from '../cache.js'

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 1024 * 1024

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const err = new Error('request body too large')
      err.tooLarge = true
      throw err
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}

export async function route(req, res) {
  if (!req.headers.host && !process.env.BASE_URL) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('missing host')
    return
  }

  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  const host = req.headers['x-forwarded-host'] || req.headers.host
  
  let baseOrigin = process.env.BASE_URL || `${proto}://${host}`
  if (req.headers['x-forwarded-host']) {
    const fwHost = req.headers['x-forwarded-host'].split(',')[0].trim()
    baseOrigin = `${proto}://${fwHost}`
  }

  const loc = new URL(req.url ?? '/', baseOrigin)
  const { pathname, searchParams, origin } = loc

  try {
    if (pathname === '/health' || pathname === '/api/health') {
      json(res, 200, { ok: true, uptime: process.uptime() })
      return
    }

    // ── Shared resolve cache (L2 for both cluster workers) ─────────────────
    // GET    /api/cache/:key            → hit/miss/minting/failed snapshot
    // GET    /api/cache/:key?claim=1    → reserve the mint (ok:false = held)
    // POST   /api/cache/:key            → store { streams, ttlMs, status }
    //                                     or { activeIds } for prune
    // DELETE /api/cache/:key            → drop entry + claim (noteFailure)
    // GET    /api/cache-stats           → entry counters
    if (pathname === '/api/cache-stats') {
      json(res, 200, cacheStats())
      return
    }
    if (pathname.startsWith('/api/cache/')) {
      const key = decodeURIComponent(pathname.slice('/api/cache/'.length))
      if (!key) {
        json(res, 400, { ok: false, error: 'missing key' })
        return
      }
      if (req.method === 'GET') {
        if (searchParams.get('claim') === '1') {
          json(res, 200, cacheClaim(key, Number(searchParams.get('ttl')) || undefined))
          return
        }
        json(res, 200, cacheGet(key))
        return
      }
      if (req.method === 'POST') {
        let body
        try {
          body = await readJson(req)
        } catch (err) {
          json(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        if (body && Array.isArray(body.activeIds)) {
          json(res, 200, cachePrune(body.activeIds))
          return
        }
        json(res, 200, cacheSet(key, body ? body.streams : [], body ? body.ttlMs : undefined, body ? body.status : undefined))
        return
      }
      if (req.method === 'DELETE') {
        json(res, 200, cacheDelete(key))
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }

    if (pathname === '/api/stream') {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST required' })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        if (err.tooLarge) {
          json(res, 413, { ok: false, error: 'request body too large' })
        } else {
          json(res, 400, { ok: false, error: 'invalid json' })
        }
        return
      }
      json(res, 200, await run(body, origin))
      return
    }

    if (serveStatic(pathname, res)) return

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  } catch (err) {
    json(res, 500, { ok: false, error: String(err.message || err) })
  }
}
