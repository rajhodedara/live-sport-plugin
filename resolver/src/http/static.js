import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../public')

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/player.js': ['player.js', 'application/javascript; charset=utf-8'],
}

export function serveStatic(pathname, res) {
  const asset = assets[pathname]
  if (!asset) return false
  const stream = createReadStream(join(root, asset[0]))
  const stop = () => stream.destroy()
  res.once('close', stop)
  res.once('error', stop)
  stream.once('close', () => {
    res.removeListener('close', stop)
    res.removeListener('error', stop)
  })
  stream.once('error', (err) => {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR'
    res.writeHead(missing ? 404 : 500, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    })
    res.end(missing ? 'not found' : 'unable to read asset')
  })
  stream.once('open', () => {
    if (res.destroyed || res.writableEnded) {
      stop()
      return
    }
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' })
    stream.pipe(res)
  })
  if (res.destroyed || res.writableEnded) stop()
  return true
}
