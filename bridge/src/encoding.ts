// Refuses compressed request bodies before any body parser runs. Express's parsers decompress
// gzip/deflate/br bodies themselves, and Node's bundled Brotli decoder before 24.22.1 has an
// out-of-bounds write (CVE-2026-111497, "Node2Shell"). Chat apps never compress requests, so
// nothing legitimate needs this, and on a patched Node it removes a decompression-bomb surface too.

import type { NextFunction, Request, Response } from 'express'

export function refuseCompressedBodies(req: Request, res: Response, next: NextFunction): void {
  const encoding = String(req.headers['content-encoding'] ?? '').trim().toLowerCase()
  if (encoding && encoding !== 'identity') {
    res.status(415).json({ error: 'Compressed request bodies are not accepted. Send the body without Content-Encoding.' })
    return
  }
  next()
}
