// Which public origin a request arrived on. Quick-tunnel hostnames change on every cloudflared
// start, so with publicUrl "auto" the origin is taken from the Host header and checked against
// `publicHosts`. Only cloudflared on this machine reaches the port, and it forwards the hostname the
// agent actually used, so the OAuth issuer and resource URLs always match what the agent sees.

import type { Request } from 'express'
import type { Config } from './config.ts'

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

function hostMatches(host: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`)
  return re.test(host.toLowerCase())
}

/** The origin (scheme + host) for this request, or null if the host is not allowed. */
export function originFor(req: Request, config: Config): string | null {
  const host = String(req.headers.host ?? '').trim()
  if (!host) return null
  if (LOCAL.test(host)) return `http://${host}` // local testing tools (MCP Inspector, tests)
  if (config.publicUrl !== 'auto') {
    const fixed = new URL(config.publicUrl)
    return host.toLowerCase() === fixed.host.toLowerCase() ? fixed.origin : null
  }
  const bare = host.replace(/:\d+$/, '')
  if (!config.publicHosts.some((p) => hostMatches(bare, p))) return null
  return `https://${bare}`
}

/** Most recent public (non-local) origin seen on an incoming request. */
let lastSeen: { origin: string; at: string } | null = null

export function notePublicOrigin(origin: string): void {
  if (origin.startsWith('https://')) lastSeen = { origin, at: new Date().toISOString() }
}

export function lastPublicOrigin(): { origin: string; at: string } | null {
  return lastSeen
}
