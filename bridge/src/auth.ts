// OAuth 2.1 authorization server for web agents (dynamic client registration + PKCE + refresh
// tokens). Connecting requires three things: the owner's passphrase, a current TOTP code, and a
// click on Approve on the loopback-only control page. A remote party cannot complete the last step.

import { randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response, Router } from 'express'
import express from 'express'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { audit } from './audit.ts'
import type { Config } from './config.ts'
import { verifyOwner } from './secrets.ts'
import { newToken, sha256, type ClientRecord, type ConnectRequest, type Store } from './store.ts'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri)
    if (u.hash) return false
    if (u.protocol === 'https:') return true
    // Plain http only for local testing tools such as MCP Inspector.
    return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

export class HarnessAuth implements OAuthServerProvider {
  private config: Config
  private store: Store
  /** Timestamps of failed passphrase/TOTP attempts (global: the tunnel hides client IPs). */
  private failures: number[] = []
  private lockedUntil = 0
  private lastSeenSaved = new Map<string, number>()
  alerts: { time: string; message: string }[] = []

  constructor(config: Config, store: Store) {
    this.config = config
    this.store = store
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.state.clients[id]?.info as OAuthClientInformationFull | undefined,
      registerClient: (meta) => {
        const uris = (meta.redirect_uris ?? []).map(String)
        if (!uris.length || !uris.every(isAllowedRedirect)) {
          throw new InvalidClientMetadataError('redirect_uris must be https URLs (or http://localhost for local testing).')
        }
        const origins = new Set(uris.map((u) => new URL(u).origin))
        if (origins.size !== 1) throw new InvalidClientMetadataError('All redirect_uris must share one origin.')
        const origin = [...origins][0]
        const known = this.config.auth.knownClientOrigins.includes(origin)
        const info: OAuthClientInformationFull = {
          ...meta,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: 'none',
        }
        delete (info as { client_secret?: string }).client_secret
        const record: ClientRecord = {
          client_id: info.client_id,
          client_name: meta.client_name,
          redirect_uris: uris,
          origin,
          registeredAt: new Date().toISOString(),
          approved: false,
          profile: 'read-only',
          info: info as unknown as Record<string, unknown>,
        }
        this.store.state.clients[info.client_id] = record
        this.store.save()
        audit('client-registered', { clientId: info.client_id, name: meta.client_name, origin, knownOrigin: known })
        return info
      },
    }
  }

  isLocked(): boolean {
    return Date.now() < this.lockedUntil
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (this.store.state.mode === 'off') throw new TemporarilyUnavailableError('harness-mcp is switched off on the owner\'s computer.')
    const req: ConnectRequest = {
      id: randomUUID(),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      createdAt: Date.now(),
      stage: 'credentials',
      browserSecret: randomBytes(24).toString('base64url'),
    }
    this.store.connects.set(req.id, req)
    audit('connect-start', { clientId: client.client_id, name: client.client_name })
    renderConsent(res, req, this.store.state.clients[client.client_id], null, this.config)
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const req = [...this.store.connects.values()].find((r) => r.code === code && r.stage === 'approved')
    if (!req) throw new InvalidGrantError('Unknown or expired authorization code.')
    return req.codeChallenge
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const req = [...this.store.connects.values()].find((r) => r.code === code && r.stage === 'approved')
    if (!req || req.clientId !== client.client_id) throw new InvalidGrantError('Unknown or expired authorization code.')
    if (redirectUri && redirectUri !== req.redirectUri) throw new InvalidGrantError('redirect_uri mismatch.')
    if (Date.now() - req.createdAt > 15 * 60_000) throw new InvalidGrantError('Authorization code expired.')
    this.store.connects.delete(req.id) // single use
    audit('connect-complete', { clientId: client.client_id })
    return this.issue(client.client_id, req.scopes, randomUUID(), req.resource)
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const hash = sha256(refreshToken)
    const rec = this.store.state.tokens.find((t) => t.hash === hash && t.kind === 'refresh')
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) throw new InvalidGrantError('Invalid refresh token.')
    if (rec.used) {
      // A rotated refresh token came back: assume theft, revoke everything this client holds.
      this.store.revokeClientTokens(client.client_id)
      this.alert(`Refresh-token reuse detected for client ${client.client_name ?? client.client_id}; its tokens were revoked.`)
      throw new InvalidGrantError('Refresh token reuse detected; reconnect required.')
    }
    if (this.isIdle(client.client_id)) throw new InvalidGrantError('Disconnected after inactivity; reconnect required.')
    rec.used = true
    return this.issue(client.client_id, rec.scopes, rec.family, rec.resource)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const hash = sha256(token)
    const rec = this.store.state.tokens.find((t) => t.hash === hash && t.kind === 'access')
    if (!rec || rec.expiresAt < Date.now()) throw new InvalidTokenError('Invalid or expired token.')
    const client = this.store.state.clients[rec.clientId]
    if (!client || !client.approved) throw new InvalidTokenError('Client not approved.')
    if (this.isIdle(rec.clientId)) {
      this.store.revokeClientTokens(rec.clientId)
      throw new InvalidTokenError('Disconnected after inactivity.')
    }
    client.lastSeen = new Date().toISOString()
    const last = this.lastSeenSaved.get(rec.clientId) ?? 0
    if (Date.now() - last > 30_000) {
      this.lastSeenSaved.set(rec.clientId, Date.now())
      this.store.save()
    }
    return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: Math.floor(rec.expiresAt / 1000), resource: rec.resource ? new URL(rec.resource) : undefined }
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const hash = sha256(request.token)
    this.store.state.tokens = this.store.state.tokens.filter((t) => t.hash !== hash)
    this.store.save()
  }

  private isIdle(clientId: string): boolean {
    const last = this.store.state.clients[clientId]?.lastSeen
    return !!last && Date.now() - Date.parse(last) > this.config.auth.idleDisconnectHours * 3600_000
  }

  private issue(clientId: string, scopes: string[], family: string, resource?: string): OAuthTokens {
    const access = newToken()
    const refresh = newToken()
    const now = Date.now()
    const accessTtl = this.config.auth.accessTokenMinutes * 60_000
    this.store.state.tokens.push(
      { hash: sha256(access), kind: 'access', clientId, scopes, expiresAt: now + accessTtl, family, resource },
      { hash: sha256(refresh), kind: 'refresh', clientId, scopes, expiresAt: now + this.config.auth.refreshTokenDays * 86_400_000, family, resource },
    )
    const client = this.store.state.clients[clientId]
    if (client) client.lastSeen = new Date().toISOString()
    this.store.save()
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(accessTtl / 1000), refresh_token: refresh, scope: scopes.join(' ') || undefined }
  }

  alert(message: string): void {
    this.alerts.push({ time: new Date().toISOString(), message })
    if (this.alerts.length > 50) this.alerts.shift()
    audit('alert', { message })
  }

  /** Record a failed credential attempt; returns true when the lockout has just been triggered. */
  recordFailure(): boolean {
    const now = Date.now()
    const window = this.config.auth.lockoutMinutes * 60_000
    this.failures = this.failures.filter((t) => now - t < window)
    this.failures.push(now)
    if (this.failures.length >= this.config.auth.maxFailedLogins) {
      this.lockedUntil = now + window
      this.failures = []
      this.alert(`Consent locked for ${this.config.auth.lockoutMinutes} minutes after ${this.config.auth.maxFailedLogins} failed passphrase/TOTP attempts.`)
      return true
    }
    return false
  }

  /** Local approval from the control page. */
  approveConnect(id: string, profile: 'read-only' | 'full'): string | null {
    const req = this.store.connects.get(id)
    if (!req || req.stage !== 'awaiting-local') return null
    req.stage = 'approved'
    req.code = randomBytes(32).toString('base64url')
    const client = this.store.state.clients[req.clientId]
    if (client) {
      client.approved = true
      client.profile = profile
    }
    this.store.save()
    audit('connect-approved', { clientId: req.clientId, profile })
    return req.code
  }

  denyConnect(id: string): void {
    const req = this.store.connects.get(id)
    if (req) req.stage = 'denied'
    audit('connect-denied', { clientId: req?.clientId })
  }

  /** Expire stale connect requests. */
  sweep(): void {
    const now = Date.now()
    for (const r of this.store.connects.values()) {
      const awaitingSince = r.awaitingSince ?? r.createdAt
      if (r.stage === 'credentials' && now - r.createdAt > 10 * 60_000) r.stage = 'expired'
      if (r.stage === 'awaiting-local' && now - awaitingSince > this.config.auth.consentTimeoutSec * 1000) r.stage = 'expired'
      if (now - r.createdAt > 30 * 60_000) this.store.connects.delete(r.id)
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function page(res: Response, title: string, body: string, nonce?: string): void {
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'${nonce ? `; script-src 'nonce-${nonce}'; connect-src 'self'` : ''}`)
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'no-store')
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:440px;margin:48px auto;padding:0 16px;color:#1d1d1f}h1{font-size:20px}label{display:block;margin:14px 0 4px;font-weight:600}input{width:100%;padding:10px;font-size:15px;box-sizing:border-box;border:1px solid #bbb;border-radius:6px}button{margin-top:18px;padding:10px 18px;font-size:15px;border:0;border-radius:6px;background:#1f5eff;color:#fff;cursor:pointer}.box{background:#f4f5f7;border-radius:8px;padding:12px 14px;margin:12px 0}.err{color:#b00020}.new{color:#a15c00;font-weight:600}button.secondary{background:none;color:#1f5eff;border:1px solid #bbb}.small{font-size:13.5px;color:#555}code{font-size:13px}</style></head><body>${body}</body></html>`)
}

function controlUrl(config: Config, id: string): string {
  return `http://127.0.0.1:${config.controlPort}/#approve=${encodeURIComponent(id)}`
}

/** Where to send the browser when the connection ends without approval: back to the chat app with an explicit error. */
function failureRedirect(cr: ConnectRequest, description: string): string {
  const u = new URL(cr.redirectUri)
  u.searchParams.set('error', 'access_denied')
  u.searchParams.set('error_description', description)
  if (cr.state) u.searchParams.set('state', cr.state)
  return u.href
}

function failureReason(stage: ConnectRequest['stage']): string {
  return stage === 'denied'
    ? 'The owner refused this connection on their computer.'
    : "The connection was not approved on the owner's computer in time."
}

const LOCKED = 'Too many failed sign-in attempts; sign-in is locked for a while.'
const EXPIRED_PAGE = '<h1>This request has expired</h1><p>Start the connection again from the chat app.</p>'

function renderConsent(res: Response, req: ConnectRequest, client: ClientRecord | undefined, error: string | null, config: Config): void {
  const name = client?.client_name ?? 'Unnamed client'
  const nonce = randomBytes(16).toString('base64')
  page(
    res,
    'Connect to harness-mcp',
    `<h1>Connect “${esc(name)}” to your computer?</h1>
<div class="box">Origin: <code>${esc(client?.origin ?? '?')}</code><br>${client?.approved ? 'Previously approved client.' : '<span class="new">New client — it starts read-only unless you choose otherwise on your computer.</span>'}</div>
<p>This agent will be able to read your code${client?.profile === 'full' ? ', change files and run commands' : ''} in the folders you allowed.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/consent" id="f">
<input type="hidden" name="id" value="${esc(req.id)}"><input type="hidden" name="secret" value="${esc(req.browserSecret)}">
<label for="p">Passphrase</label><input id="p" name="passphrase" type="password" autocomplete="current-password" required>
<label for="t">Authenticator code</label><input id="t" name="totp" inputmode="numeric" pattern="[0-9 ]{6,7}" autocomplete="one-time-code" required>
<button type="submit">Continue</button> <button type="submit" formaction="/consent/cancel" formnovalidate class="secondary">Cancel</button></form>
<p class="small">Continue opens the approval page on this computer in a new tab. Allow the connection there, and this tab returns to ${esc(name)} by itself.</p>
<script nonce="${nonce}">
${RELOAD_IF_RESTORED}
document.getElementById('f').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.getAttribute('formaction')) return
  window.open(${JSON.stringify(controlUrl(config, req.id))}, 'harness-approve')
})
</script>`,
    nonce,
  )
}

// A page restored from the browser's back/forward cache would act on stale state: reload it.
const RELOAD_IF_RESTORED = "addEventListener('pageshow', (e) => { if (e.persisted) location.reload() })"

function waitUrl(cr: ConnectRequest, error?: string): string {
  const q = new URLSearchParams({ id: cr.id, secret: cr.browserSecret })
  if (error) q.set('e', error)
  return `/consent/wait?${q}`
}

function approvedRedirect(cr: ConnectRequest): string {
  const u = new URL(cr.redirectUri)
  u.searchParams.set('code', cr.code!)
  if (cr.state) u.searchParams.set('state', cr.state)
  return u.href
}

function renderWait(res: Response, cr: ConnectRequest, client: ClientRecord | undefined, config: Config): void {
  const nonce = randomBytes(16).toString('base64')
  const approve = controlUrl(config, cr.id)
  const end = (cr.awaitingSince ?? Date.now()) + config.auth.consentTimeoutSec * 1000
  page(
    res,
    'Allow on your computer',
    `<h1>Allow the connection on your computer</h1><p>The approval page opened in a new tab. Choose the access level for “${esc(client?.client_name ?? 'this client')}” and click <b>Allow connection</b>. This tab then returns to the chat app by itself.</p>
<p><a href="${esc(approve)}" target="harness-approve">Open the approval page again</a></p>
<p id="s">Waiting for you… <span id="left">${Math.max(0, Math.ceil((end - Date.now()) / 1000))}</span> s left</p>
<form method="post" action="/consent/cancel"><input type="hidden" name="id" value="${esc(cr.id)}"><input type="hidden" name="secret" value="${esc(cr.browserSecret)}"><button type="submit" class="secondary">Cancel and return to the chat app</button></form>
<script nonce="${nonce}">
${RELOAD_IF_RESTORED}
const u = '/consent/status?id=${encodeURIComponent(cr.id)}&secret=${encodeURIComponent(cr.browserSecret)}'
const end = ${end}
setInterval(() => { document.getElementById('left').textContent = Math.max(0, Math.ceil((end - Date.now()) / 1000)) }, 1000)
async function poll() {
  try {
    const j = await (await fetch(u, { cache: 'no-store' })).json()
    if (j.redirect) {
      document.getElementById('s').textContent = j.stage === 'approved' ? 'Allowed. Returning to the chat app…' : 'Not allowed. Returning to the chat app…'
      location.replace(j.redirect)
      return
    }
    if (j.stage === 'expired') { document.getElementById('s').textContent = 'This request has expired. Start again from the chat app.'; return }
  } catch (e) {}
  setTimeout(poll, 1500)
}
poll()
</script>`,
    nonce,
  )
}

/** Public routes for the consent flow (mounted on the tunnelled MCP port). */
export function consentRouter(auth: HarnessAuth, store: Store, config: Config): Router {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false, limit: '8kb' }))

  function lookup(id: unknown, secret: unknown): ConnectRequest | null {
    const cr = store.connects.get(String(id ?? ''))
    return cr && cr.browserSecret === String(secret ?? '') ? cr : null
  }

  /**
   * Show whatever this sign-in needs next. Used by every entry point, so Back, Forward, Reload and
   * double submits never strand the browser: it resumes the form or the wait, or goes back to the
   * chat app with the final answer.
   */
  function resume(res: Response, cr: ConnectRequest, error?: string): void {
    const client = store.state.clients[cr.clientId]
    if (cr.stage === 'approved' && cr.code) return res.redirect(303, approvedRedirect(cr))
    if (cr.stage === 'denied' || cr.stage === 'expired') return res.redirect(303, failureRedirect(cr, failureReason(cr.stage)))
    if (cr.stage === 'awaiting-local') return renderWait(res, cr, client, config)
    renderConsent(res.status(error ? 401 : 200), cr, client, error === 'wrong' ? 'Passphrase or authenticator code is wrong.' : null, config)
  }

  router.post('/consent/cancel', (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    const cr = lookup(body.id, body.secret)
    if (!cr) return page(res.status(400), 'Expired', EXPIRED_PAGE)
    if (cr.stage === 'approved') return resume(res, cr)
    cr.stage = 'denied'
    audit('connect-cancelled', { clientId: cr.clientId })
    res.redirect(303, failureRedirect(cr, 'The connection was cancelled.'))
  })

  router.post('/consent', (req: Request, res: Response) => {
    auth.sweep()
    const body = req.body as Record<string, string>
    const cr = lookup(body.id, body.secret)
    if (!cr) return page(res.status(400), 'Expired', EXPIRED_PAGE)
    // Re-submitted after Back, or already decided: carry on from the current stage.
    if (cr.stage !== 'credentials') return res.redirect(303, waitUrl(cr))
    if (auth.isLocked()) {
      cr.stage = 'denied'
      return res.redirect(303, failureRedirect(cr, LOCKED))
    }
    if (!verifyOwner(String(body.passphrase ?? ''), String(body.totp ?? ''))) {
      audit('consent-failed', { clientId: cr.clientId })
      if (auth.recordFailure()) {
        cr.stage = 'denied'
        return res.redirect(303, failureRedirect(cr, LOCKED))
      }
      return res.redirect(303, waitUrl(cr, 'wrong'))
    }
    cr.stage = 'awaiting-local'
    cr.awaitingSince = Date.now()
    audit('consent-credentials-ok', { clientId: cr.clientId })
    // Post/Redirect/Get: the waiting page is a plain GET, so Reload and Back never re-post the form.
    res.redirect(303, waitUrl(cr))
  })

  router.get('/consent/wait', (req: Request, res: Response) => {
    auth.sweep()
    const cr = lookup(req.query.id, req.query.secret)
    if (!cr) return page(res.status(400), 'Expired', EXPIRED_PAGE)
    resume(res, cr, typeof req.query.e === 'string' ? req.query.e : undefined)
  })

  router.get('/consent/status', (req: Request, res: Response) => {
    auth.sweep()
    const cr = lookup(req.query.id, req.query.secret)
    res.setHeader('Cache-Control', 'no-store')
    if (!cr) return res.status(404).json({ stage: 'expired' })
    if (cr.stage === 'approved' && cr.code) return res.json({ stage: 'approved', redirect: approvedRedirect(cr) })
    // Refused or timed out: end the sign-in explicitly, so the chat app records a failure.
    if (cr.stage === 'denied' || cr.stage === 'expired') return res.json({ stage: cr.stage, redirect: failureRedirect(cr, failureReason(cr.stage)) })
    res.json({ stage: cr.stage })
  })

  return router
}
