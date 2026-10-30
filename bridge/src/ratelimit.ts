// Fixed-window rate limits for the public OAuth endpoints. The SDK's own limiters can't be used
// because the auth router is built per public hostname, on the first request for that hostname.

import type { NextFunction, Request, Response } from 'express'

type Rule = { path: string; windowMs: number; max: number }

// Same budgets as the MCP SDK defaults, plus the consent form.
const RULES: Rule[] = [
  { path: '/authorize', windowMs: 15 * 60_000, max: 100 },
  { path: '/token', windowMs: 15 * 60_000, max: 50 },
  { path: '/register', windowMs: 60 * 60_000, max: 20 },
  { path: '/revoke', windowMs: 15 * 60_000, max: 50 },
  { path: '/consent', windowMs: 15 * 60_000, max: 60 },
]

export function authRateLimit() {
  const hits = new Map<string, { start: number; count: number }>()
  return (req: Request, res: Response, next: NextFunction) => {
    const rule = RULES.find((r) => req.path === r.path)
    if (!rule) return next()
    const key = `${rule.path}|${req.ip}`
    const now = Date.now()
    let h = hits.get(key)
    if (!h || now - h.start > rule.windowMs) hits.set(key, (h = { start: now, count: 0 }))
    if (++h.count > rule.max) {
      res.setHeader('Retry-After', String(Math.ceil((h.start + rule.windowMs - now) / 1000)))
      return res.status(429).json({ error: 'too_many_requests', error_description: 'Too many requests; try again later.' })
    }
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start > 60 * 60_000) hits.delete(k)
    next()
  }
}
