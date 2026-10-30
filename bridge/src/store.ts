// Persistent state: registered clients, tokens (stored as hashes), pending approvals and grants.
// One JSON file, written atomically. Small enough to keep fully in memory.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homePath, writeJsonAtomic } from './config.ts'

export type Profile = 'read-only' | 'full'

export type ClientRecord = {
  client_id: string
  client_name?: string
  redirect_uris: string[]
  origin: string
  registeredAt: string
  /** Set once the user has approved a connection from this client on the control page. */
  approved: boolean
  profile: Profile
  lastSeen?: string
  info: Record<string, unknown>
}

export type TokenRecord = {
  hash: string
  kind: 'access' | 'refresh'
  clientId: string
  scopes: string[]
  expiresAt: number
  /** Refresh-token family; reuse of a rotated member revokes the family. */
  family: string
  used?: boolean
  resource?: string
}

export type ConnectRequest = {
  id: string
  clientId: string
  redirectUri: string
  state?: string
  codeChallenge: string
  scopes: string[]
  resource?: string
  createdAt: number
  awaitingSince?: number
  stage: 'credentials' | 'awaiting-local' | 'approved' | 'denied' | 'expired'
  code?: string
  /** Browser-side secret so only the browser that started the flow can poll its status. */
  browserSecret: string
}

export type PendingAction = {
  id: string
  kind: 'command' | 'revert' | 'access'
  clientId: string
  createdAt: number
  status: 'pending' | 'approved' | 'denied'
  summary: string
  detail: Record<string, unknown>
}

export type Grant = {
  id: string
  path: string
  mode: 'read' | 'write'
  expiresAt: number | null
  grantedAt: string
  clientId: string
}

export type State = {
  mode: 'on' | 'paused' | 'off'
  clients: Record<string, ClientRecord>
  tokens: TokenRecord[]
  grants: Grant[]
  actions: PendingAction[]
  activeWorkspace: string | null
  /** Trusted (true) or untrusted (false) per writable folder, keyed by lower-case path; unset uses the default (review.ts). */
  trust?: Record<string, boolean>
  /** Last public connector URL shown to the user, and the one before it (quick-tunnel URLs rotate). */
  connectorUrl?: { current: string; previous: string | null; changedAt: string }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export class Store {
  state: State
  /** Connect requests are short-lived and kept in memory only. */
  connects = new Map<string, ConnectRequest>()
  private file: string
  private listeners = new Set<() => void>()

  constructor(file = homePath('state.json')) {
    this.file = file
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as State)
      : { mode: 'on', clients: {}, tokens: [], grants: [], actions: [], activeWorkspace: null }
  }

  save(): void {
    const now = Date.now()
    this.state.tokens = this.state.tokens.filter((t) => t.expiresAt > now)
    this.state.grants = this.state.grants.filter((g) => g.expiresAt === null || g.expiresAt > now)
    this.state.actions = this.state.actions.filter((a) => a.status === 'pending' || now - a.createdAt < 24 * 3600_000)
    writeJsonAtomic(this.file, this.state)
    for (const l of this.listeners) l()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolve when the action leaves `pending` (approved/denied locally) or `ms` passes. */
  waitForAction(id: string, ms: number): Promise<PendingAction | undefined> {
    const find = () => this.state.actions.find((a) => a.id === id)
    if (find()?.status !== 'pending') return Promise.resolve(find())
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        off()
        resolve(find())
      }
      const timer = setTimeout(done, ms)
      const off = this.onChange(() => {
        if (find()?.status !== 'pending') done()
      })
    })
  }

  activeGrants(): Grant[] {
    const now = Date.now()
    return this.state.grants.filter((g) => g.expiresAt === null || g.expiresAt > now)
  }

  addAction(action: Omit<PendingAction, 'id' | 'createdAt' | 'status'>): PendingAction {
    const record: PendingAction = { ...action, id: randomUUID(), createdAt: Date.now(), status: 'pending' }
    this.state.actions.push(record)
    this.save()
    return record
  }

  revokeClientTokens(clientId: string): void {
    this.state.tokens = this.state.tokens.filter((t) => t.clientId !== clientId)
    this.save()
  }

  revokeAll(): void {
    this.state.tokens = []
    this.save()
  }
}
