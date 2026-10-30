// Local control page: loopback only, never tunnelled. Approve connections, commands, reverts and
// folder access; switch clients between read-only and full; pause/off/rotate; paste-to-apply.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express, { type NextFunction, type Request, type Response } from 'express'
import { audit, recentAudit } from './audit.ts'
import type { HarnessAuth } from './auth.ts'
import { getCheckpoint, listCheckpoints, restoreCheckpoint } from './checkpoints.ts'
import type { Config } from './config.ts'
import { applyPatchText } from './edits.ts'
import { refuseCompressedBodies } from './encoding.ts'
import { changesUnder, clearUnder, isTrusted, rootFor } from './review.ts'
import { createRun, denyRun, getRun, killRun, listRuns, recipeFor, startRun } from './runner.ts'
import { canonical, deniedReason, type Scope } from './scope.ts'
import { lastPublicOrigin } from './origin.ts'
import type { Store } from './store.ts'
import type { QuickTunnel } from './tunnel.ts'

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

export function controlApp(config: Config, store: Store, scope: Scope, auth: HarnessAuth, tunnel: QuickTunnel): express.Express {
  const app = express()
  const csrf = randomBytes(24).toString('base64url')
  const allowedHosts = new Set([`127.0.0.1:${config.controlPort}`, `localhost:${config.controlPort}`, `[::1]:${config.controlPort}`])

  // Every refusal says why, on the page and in the server window, so a blocked browser can be fixed.
  function refuse(req: Request, res: Response, reason: string): void {
    console.warn(`[control] refused ${req.method} ${req.path}: ${reason}`)
    res.status(403).json({ error: reason })
  }

  // Loopback guard: reject non-loopback peers and foreign Host/Origin headers (DNS rebinding).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const peer = req.socket.remoteAddress ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
      return refuse(req, res, `Refused: the request came from ${peer || 'an unknown address'}, not from this PC. If you use a proxy, exclude 127.0.0.1 from it.`)
    }
    const host = String(req.headers.host ?? '')
    if (!allowedHosts.has(host)) {
      return refuse(req, res, `Refused: open the control page as http://127.0.0.1:${config.controlPort}/ (this request used the address "${host}").`)
    }
    // Some embedded browsers send Origin on same-page requests, and without the port. Any loopback
    // origin is accepted: other local pages can't read our responses (no CORS headers) and can't
    // act without the CSRF token embedded in this page. Origins on other hosts are refused.
    const origin = req.headers.origin
    if (origin && !isLoopbackOrigin(origin)) {
      return refuse(req, res, `Refused: the request came from another web page (${origin}). Use the control page itself at http://127.0.0.1:${config.controlPort}/.`)
    }
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use(refuseCompressedBodies)
  app.use(express.json({ limit: '5mb' }))
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.headers['x-csrf'] !== csrf) {
      return refuse(req, res, 'stale-page: This page is from before harness-mcp restarted. Reload the page.')
    }
    next()
  })

  app.get('/', (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
    // Read per request, so page edits show up on reload without restarting the server.
    const page = readFileSync(new URL('./control-page.html', import.meta.url), 'utf8')
    res.type('html').send(page.replace('__CSRF__', csrf))
  })

  app.get('/api/state', (_req, res) => {
    auth.sweep()
    const clients = Object.values(store.state.clients).map((c) => ({
      id: c.client_id,
      name: c.client_name ?? '(unnamed)',
      origin: c.origin,
      approved: c.approved,
      profile: c.profile,
      lastSeen: c.lastSeen ?? null,
      connected: store.state.tokens.some((t) => t.clientId === c.client_id && t.kind === 'access' && t.expiresAt > Date.now()),
    }))
    const connects = [...store.connects.values()]
      .filter((r) => r.stage === 'awaiting-local')
      .map((r) => {
        const c = store.state.clients[r.clientId]
        const since = r.awaitingSince ?? r.createdAt
        return { id: r.id, clientName: c?.client_name ?? '(unnamed)', origin: c?.origin, isNew: !c?.approved, profile: c?.profile ?? 'read-only', since, expiresAt: since + config.auth.consentTimeoutSec * 1000 }
      })
    res.json({
      serverTime: Date.now(),
      connection: {
        publicUrlMode: config.publicUrl === 'auto' ? 'auto' : 'fixed',
        fixedUrl: config.publicUrl === 'auto' ? null : `${config.publicUrl.replace(/\/+$/, '')}/mcp`,
        tunnel: tunnel.status,
        connectorUrl: store.state.connectorUrl ?? null,
        lastRequest: lastPublicOrigin(),
      },
      toolWaitSec: config.limits.toolWaitSec,
      mode: store.state.mode,
      locked: auth.isLocked(),
      alerts: auth.alerts.slice(-10).reverse(),
      connects,
      actions: store.state.actions
        .filter((a) => a.status === 'pending')
        .map((a) => {
          const base = { ...a, clientName: store.state.clients[a.clientId]?.client_name ?? a.clientId, waitUntil: a.createdAt + config.limits.toolWaitSec * 1000 }
          if (a.kind !== 'command') return base
          // What the command would run: everything agents changed in that workspace since you last approved there.
          const root = rootFor(String(a.detail.cwd), scope)
          return { ...base, workspace: root, trusted: isTrusted(root, config, store), changes: changesUnder(root) }
        }),
      clients,
      grants: store.activeGrants(),
      readRoots: scope.readRoots(),
      writeRoots: scope.writeRoots(),
      trust: scope.writeRoots().map((p) => ({ path: p, trusted: isTrusted(p, config, store), unseen: changesUnder(p).length })),
      activeWorkspace: scope.activeWorkspace(),
      runs: listRuns(30),
      checkpoints: listCheckpoints(20),
      audit: recentAudit(100),
    })
  })

  app.post('/api/connect/:id/:decision', (req, res) => {
    if (req.params.decision === 'approve') {
      const profile = req.body?.profile === 'full' ? 'full' : 'read-only'
      if (auth.approveConnect(req.params.id, profile) === null) {
        return res.status(409).json({ error: 'This connection request has expired or was already handled. Start the connection again from the chat app.' })
      }
      return res.json({ ok: true })
    }
    auth.denyConnect(req.params.id)
    res.json({ ok: true })
  })

  app.post('/api/action/:id/:decision', (req, res) => {
    const action = store.state.actions.find((a) => a.id === req.params.id && a.status === 'pending')
    if (!action) return res.status(404).json({ error: 'This request was already handled or no longer exists.' })
    const approve = req.params.decision === 'approve'
    action.status = approve ? 'approved' : 'denied'
    audit('local-decision', { actionId: action.id, actionKind: action.kind, approve, summary: action.summary })
    if (action.kind === 'command') {
      const run = getRun(String(action.detail.runId))
      // The card showed every unseen change in this workspace; approving counts them as seen.
      if (approve) clearUnder(rootFor(String(action.detail.cwd), scope))
      if (run) approve ? void startRun(run, config) : denyRun(run)
    } else if (action.kind === 'revert' && approve) {
      const cp = getCheckpoint(String(action.detail.checkpoint))
      if (cp) action.detail.restored = restoreCheckpoint(cp)
    } else if (action.kind === 'access' && approve) {
      const path = canonical(String(req.body?.path || action.detail.path))
      const denied = deniedReason(path, config)
      if (denied) {
        action.status = 'denied'
        store.save()
        return res.status(400).json({ error: denied })
      }
      const mode = req.body?.mode === 'read' || action.detail.mode === 'read' ? 'read' : 'write'
      const hours = Number(req.body?.durationHours ?? action.detail.durationHours ?? 0)
      store.state.grants.push({ id: action.id, path, mode, expiresAt: hours > 0 ? Date.now() + hours * 3600_000 : null, grantedAt: new Date().toISOString(), clientId: action.clientId })
    }
    store.save()
    res.json({ ok: true })
  })

  app.post('/api/run/:id/kill', (req, res) => {
    if (!killRun(req.params.id)) return res.status(404).json({ error: 'That run is not running any more.' })
    res.json({ ok: true })
  })

  app.post('/api/tunnel/:op', (req, res) => {
    if (config.tunnel.mode !== 'quick') return res.status(400).json({ error: 'The tunnel is not managed by harness-mcp. Set "tunnel": {"mode": "quick"} in config.json, or restart your own cloudflared.' })
    if (req.params.op === 'restart') tunnel.restart()
    else if (req.params.op === 'stop') tunnel.stop()
    else if (req.params.op === 'start') tunnel.start()
    else return res.status(400).end()
    audit('tunnel', { op: req.params.op })
    res.json({ ok: true })
  })

  /** Local undo: the user is at this PC, so no extra approval is needed. */
  app.post('/api/checkpoint/:id/revert', (req, res) => {
    const cp = getCheckpoint(req.params.id)
    if (!cp) return res.status(404).json({ error: 'Unknown checkpoint.' })
    const restored = restoreCheckpoint(cp)
    audit('local-revert', { checkpoint: cp.id, restored })
    res.json({ ok: true, restored })
  })

  app.post('/api/client/:id/profile', (req, res) => {
    const c = store.state.clients[req.params.id]
    if (!c) return res.status(404).end()
    c.profile = req.body?.profile === 'full' ? 'full' : 'read-only'
    store.save()
    audit('profile-change', { clientId: c.client_id, profile: c.profile })
    res.json({ ok: true })
  })

  app.post('/api/client/:id/revoke', (req, res) => {
    store.revokeClientTokens(req.params.id)
    audit('revoke', { clientId: req.params.id })
    res.json({ ok: true })
  })

  app.post('/api/grant/:id/revoke', (req, res) => {
    store.state.grants = store.state.grants.filter((g) => g.id !== req.params.id)
    store.save()
    res.json({ ok: true })
  })

  app.post('/api/mode', (req, res) => {
    const mode = req.body?.mode
    if (!['on', 'paused', 'off'].includes(mode)) return res.status(400).end()
    store.state.mode = mode
    store.save()
    audit('mode', { mode })
    res.json({ ok: true })
  })

  app.post('/api/rotate', (_req, res) => {
    store.revokeAll()
    audit('rotate', {})
    res.json({ ok: true })
  })

  app.post('/api/trust', (req, res) => {
    const path = scope.writeRoots().find((p) => p.toLowerCase() === String(req.body?.path ?? '').toLowerCase())
    if (!path) return res.status(400).json({ error: 'That folder is not one agents can edit.' })
    const trusted = req.body?.trusted === true
    store.state.trust = { ...store.state.trust, [path.toLowerCase()]: trusted }
    store.save()
    audit('trust', { path, trusted })
    res.json({ ok: true })
  })

  /** Mark agent changes as seen without approving a run (e.g. after reviewing them in an editor). */
  app.post('/api/reviewed', (req, res) => {
    const path = scope.writeRoots().find((p) => p.toLowerCase() === String(req.body?.path ?? '').toLowerCase())
    if (!path) return res.status(400).json({ error: 'That folder is not one agents can edit.' })
    clearUnder(path)
    audit('reviewed', { path })
    res.json({ ok: true })
  })

  app.post('/api/workspace', (req, res) => {
    try {
      store.state.activeWorkspace = scope.check(String(req.body?.path ?? ''), 'write')
      store.save()
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** Paste-to-apply: for chats that can only propose patches. The click is the approval. */
  app.post('/api/apply', (req, res) => {
    try {
      const ws = scope.activeWorkspace()
      if (!ws) throw new Error('No active workspace.')
      const result = applyPatchText(String(req.body?.patch ?? ''), ws, scope, 'local', false)
      audit('local-apply', result)
      let runId: string | null = null
      const recipe = recipeFor(ws, config)
      if (req.body?.runTests && recipe) {
        const run = createRun({ kind: 'tests', trigger: 'local', clientId: 'local', cwd: ws, commands: recipe.commands }, false)
        runId = run.id
        void startRun(run, config)
      }
      res.json({ ok: true, ...result, runId })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  app.post('/api/run-tests', (_req, res) => {
    const ws = scope.activeWorkspace()
    const recipe = ws ? recipeFor(ws, config) : null
    if (!ws || !recipe) return res.status(400).json({ error: 'No active workspace with a test recipe.' })
    const run = createRun({ kind: 'tests', trigger: 'local', clientId: 'local', cwd: ws, commands: recipe.commands }, false)
    void startRun(run, config)
    res.json({ ok: true, runId: run.id })
  })

  return app
}
