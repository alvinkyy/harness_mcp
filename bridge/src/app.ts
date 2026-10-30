// Wires the two HTTP surfaces:
//   MCP app (127.0.0.1:mcpPort, exposed through the tunnel): OAuth endpoints, consent pages, /mcp
//   control app (127.0.0.1:controlPort, never exposed): the local control page

import type { Server } from 'node:http'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { audit } from './audit.ts'
import { consentRouter, HarnessAuth } from './auth.ts'
import type { Config } from './config.ts'
import { controlApp } from './control.ts'
import { refuseCompressedBodies } from './encoding.ts'
import { notePublicOrigin, originFor } from './origin.ts'
import { authRateLimit } from './ratelimit.ts'
import { needsReview } from './review.ts'
import { loadRuns, setAutoRunGuard, syncWatchers } from './runner.ts'
import { cleanup } from './retention.ts'
import { Scope } from './scope.ts'
import { Store } from './store.ts'
import { buildServer } from './tools.ts'
import { QuickTunnel } from './tunnel.ts'

export type Running = { mcp: Server; control: Server; store: Store; auth: HarnessAuth; tunnel: QuickTunnel; close: () => Promise<void> }

type OriginHandlers = { auth: RequestHandler; bearer: RequestHandler }

/** Record a new public connector URL, remembering the previous one so the page can say it changed. */
export function rememberConnectorUrl(store: Store, origin: string): void {
  const url = `${origin}/mcp`
  if (store.state.connectorUrl?.current === url) return
  store.state.connectorUrl = { current: url, previous: store.state.connectorUrl?.current ?? null, changedAt: new Date().toISOString() }
  store.save()
}

export function mcpApp(config: Config, store: Store, scope: Scope, auth: HarnessAuth): express.Express {
  const app = express()
  app.disable('x-powered-by')
  // Only cloudflared/tunnel-client on this machine connect to this port.
  app.set('trust proxy', 'loopback')
  app.use(refuseCompressedBodies)

  // OAuth metadata must name the URL the agent actually used. With a rotating quick-tunnel hostname
  // that is only known per request, so the auth router and bearer check are built per origin.
  const perOrigin = new Map<string, OriginHandlers>()
  function handlersFor(origin: string): OriginHandlers {
    let h = perOrigin.get(origin)
    if (!h) {
      const issuerUrl = new URL(origin)
      const resourceUrl = new URL('/mcp', issuerUrl)
      h = {
        auth: mcpAuthRouter({
          provider: auth,
          issuerUrl,
          resourceServerUrl: resourceUrl,
          scopesSupported: ['mcp', 'offline_access'],
          resourceName: 'harness-mcp',
          // Rate limits are applied once, app-wide (authRateLimit), not per hostname.
          authorizationOptions: { rateLimit: false },
          tokenOptions: { rateLimit: false },
          clientRegistrationOptions: { rateLimit: false },
          revocationOptions: { rateLimit: false },
        }),
        bearer: requireBearerAuth({ verifier: auth, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) }),
      }
      perOrigin.set(origin, h)
    }
    return h
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = originFor(req, config)
    if (!origin) return res.status(421).json({ error: 'This hostname is not configured for harness-mcp (see publicUrl / publicHosts in config.json).' })
    res.locals.origin = origin
    notePublicOrigin(origin)
    if (origin.startsWith('https://')) rememberConnectorUrl(store, origin)
    next()
  })

  app.use((req: Request, res: Response, next) => {
    if (store.state.mode === 'off' && !req.path.startsWith('/.well-known')) {
      return res.status(503).json({ error: 'harness-mcp is switched off on the owner\'s computer.' })
    }
    next()
  })

  app.use(authRateLimit())
  app.use((req: Request, res: Response, next: NextFunction) => handlersFor(res.locals.origin as string).auth(req, res, next))
  app.use(consentRouter(auth, store, config))

  const bearer: RequestHandler = (req, res, next) => handlersFor(res.locals.origin as string).bearer(req, res, next)

  app.post('/mcp', bearer, express.json({ limit: '10mb' }), async (req: Request, res: Response) => {
    const clientId = req.auth!.clientId
    const client = store.state.clients[clientId]
    // Stateless: a fresh server per request, carrying the caller's current profile.
    const server = buildServer({ config, store, scope, clientId, profile: client?.profile ?? 'read-only' })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (e) {
      audit('mcp-error', { clientId, error: (e as Error).message })
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })
  // Stateless server: no standalone SSE stream or session deletion.
  app.get('/mcp', bearer, (_req, res) => res.status(405).set('Allow', 'POST').end())
  app.delete('/mcp', bearer, (_req, res) => res.status(405).set('Allow', 'POST').end())

  app.get('/', (_req, res) => res.type('text').send('harness-mcp. Connect your agent to /mcp.'))
  app.use((_req, res) => res.status(404).json({ error: 'not found' }))
  return app
}

export async function start(config: Config, store = new Store()): Promise<Running> {
  // Runs live in memory, so command approvals left over from a previous process can no longer run.
  for (const action of store.state.actions) {
    if (action.status === 'pending' && action.kind === 'command') action.status = 'denied'
  }
  store.save()
  const { removed } = cleanup(config)
  if (removed) audit('cleanup', { removed, days: config.retention.days })
  loadRuns()
  const scope = new Scope(config, store)
  const auth = new HarnessAuth(config, store)
  const tunnel = new QuickTunnel(config)
  tunnel.onChange((s) => {
    if (s.state === 'up' && s.url) rememberConnectorUrl(store, s.url)
  })
  const mcp = await listen(mcpApp(config, store, scope, auth), config.mcpPort)
  const control = await listen(controlApp(config, store, scope, auth, tunnel), config.controlPort)
  tunnel.start()
  setAutoRunGuard((ws) => !needsReview(ws, config, store, scope))
  syncWatchers(config, config.workspaces)
  const sweeper = setInterval(() => auth.sweep(), 5_000)
  sweeper.unref()
  return {
    mcp,
    control,
    store,
    auth,
    tunnel,
    close: async () => {
      clearInterval(sweeper)
      tunnel.stop()
      await Promise.all([mcp, control].map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))))
    },
  }
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Both surfaces bind to loopback only. The tunnel connects from this machine.
    const server = app.listen(port, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve(server)))
    server.on('error', reject)
  })
}
