import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate all state before any module reads HARNESS_HOME.
export const root = mkdtempSync(join(tmpdir(), 'harness-test-'))
process.env.HARNESS_HOME = join(root, 'home')
export const workspace = join(root, 'ws')
export const outside = join(root, 'outside')
mkdirSync(workspace, { recursive: true })
mkdirSync(outside, { recursive: true })

const { defaultConfig } = await import('../src/config.ts')
const { createSecrets, totp } = await import('../src/secrets.ts')
const { start } = await import('../src/app.ts')

export const PASS = 'correct horse battery staple'
export const { totpSecret } = createSecrets(PASS)

export const config = defaultConfig()
const base = 20000 + Math.floor(Math.random() * 20000)
config.mcpPort = base
config.controlPort = base + 1
config.publicUrl = `http://localhost:${base}`
config.readRoots = [workspace]
config.workspaces = [workspace]
config.limits.commandTimeoutSec = 4
config.limits.toolWaitSec = 6
config.auth.consentTimeoutSec = 3
config.commandAllowlist = [...config.commandAllowlist, 'npm run *']

export const running = await start(config)
export const MCP = `http://127.0.0.1:${config.mcpPort}`
export const CONTROL = `http://127.0.0.1:${config.controlPort}`
export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

export function code(): string {
  return totp(totpSecret)
}

export async function csrf(): Promise<string> {
  const html = await (await fetch(`${CONTROL}/`)).text()
  return /const CSRF\s*=\s*'([^']+)'/.exec(html)![1]
}

export async function control(path: string, body: unknown = {}, token?: string): Promise<Response> {
  return fetch(`${CONTROL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': token ?? (await csrf()) }, body: JSON.stringify(body) })
}

export async function register(redirect = REDIRECT, name = 'Test agent'): Promise<Response> {
  return fetch(`${MCP}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  })
}

export type Started = { id: string; secret: string; verifier: string; clientId: string }

export async function startAuthorize(clientId: string): Promise<Started> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const u = new URL(`${MCP}/authorize`)
  u.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st', scope: 'mcp offline_access' }).toString()
  const html = await (await fetch(u)).text()
  const id = /name="id" value="([^"]+)"/.exec(html)?.[1]
  const secret = /name="secret" value="([^"]+)"/.exec(html)?.[1]
  if (!id || !secret) throw new Error(`no consent form: ${html.slice(0, 300)}`)
  return { id, secret, verifier, clientId }
}

export async function submitCredentials(s: Started, passphrase = PASS, totpCode = code()): Promise<Response> {
  // redirect: 'manual' — failures answer with a 303 to the chat app's callback, which must not be fetched.
  return fetch(`${MCP}/consent`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: s.id, secret: s.secret, passphrase, totp: totpCode }).toString() })
}

/** Correct credentials answer 303 → the waiting page (Post/Redirect/Get). */
export function acceptedCredentials(r: Response): boolean {
  const loc = r.headers.get('location') ?? ''
  return r.status === 303 && loc.startsWith('/consent/wait?') && !loc.includes('e=')
}

/** Wrong credentials answer 303 → the form again, with an error flag. */
export function rejectedCredentials(r: Response): boolean {
  const loc = r.headers.get('location') ?? ''
  return r.status === 303 && loc.startsWith('/consent/wait?') && loc.includes('e=wrong')
}

export async function cancel(s: Started): Promise<Response> {
  return fetch(`${MCP}/consent/cancel`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: s.id, secret: s.secret }).toString() })
}

/** A failed sign-in must send the browser back to the chat app with error=access_denied. */
export function assertDeniedRedirect(location: string | null | undefined): URL {
  if (!location) throw new Error('expected a redirect back to the chat app')
  const u = new URL(location)
  if (!location.startsWith(REDIRECT)) throw new Error(`redirect went to ${location}`)
  if (u.searchParams.get('error') !== 'access_denied') throw new Error(`expected error=access_denied in ${location}`)
  if (u.searchParams.get('state') !== 'st') throw new Error('state must be echoed back')
  if (u.searchParams.has('code')) throw new Error('a failed sign-in must not carry a code')
  return u
}

export async function status(s: Started): Promise<{ stage: string; redirect?: string }> {
  return (await fetch(`${MCP}/consent/status?id=${s.id}&secret=${s.secret}`)).json() as Promise<{ stage: string; redirect?: string }>
}

export async function tokenRequest(params: Record<string, string>): Promise<Response> {
  return fetch(`${MCP}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
}

export type Tokens = { access_token: string; refresh_token: string; clientId: string }

/** Full happy-path connection; returns tokens. */
export async function connect(profile: 'read-only' | 'full' = 'full'): Promise<Tokens> {
  const reg = (await (await register()).json()) as { client_id: string }
  const s = await startAuthorize(reg.client_id)
  const r = await submitCredentials(s)
  if (!acceptedCredentials(r)) throw new Error(`credentials rejected: ${r.status} ${r.headers.get('location')}`)
  await control(`/api/connect/${s.id}/approve`, { profile })
  const st = await status(s)
  const codeParam = new URL(st.redirect!).searchParams.get('code')!
  const tok = (await (await tokenRequest({ grant_type: 'authorization_code', code: codeParam, code_verifier: s.verifier, client_id: reg.client_id, redirect_uri: REDIRECT })).json()) as Tokens
  return { ...tok, clientId: reg.client_id }
}

let rpcId = 0
export async function rpc(token: string, method: string, params: unknown = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await r.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: r.status, body }
}

export async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args })
  if (body.error) return { isError: true, text: JSON.stringify(body.error) }
  return { isError: !!body.result.isError, text: body.result.content.map((c: { text: string }) => c.text).join('\n') }
}

export function write(path: string, content: string): void {
  writeFileSync(path, content)
}
