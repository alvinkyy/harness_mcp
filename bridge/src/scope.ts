// File scope: which paths the agent may read or write. Paths are canonicalized (symlinks and
// junctions resolved) before every check, and the always-denied list applies inside every root.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Config } from './config.ts'
import type { Store } from './store.ts'

export class ScopeError extends Error {
  /** Set when the path is allowed in principle but lies outside the current roots: access can be requested. */
  outside?: { path: string; access: Access }
}

/** Built-in deny patterns. Matched against every path segment (case-insensitive). Cannot be reduced remotely. */
const DENIED_SEGMENTS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git-credentials', '.npmrc', '.pypirc', '.netrc',
  '.harness-mcp',
]
const DENIED_NAMES = [
  /^\.env(\..*)?$/i,
  /^configuration\.php$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|kdb|pst|ost|ppk|asc|gpg)$/i,
  /^(secrets?|credentials?)\.(json|ya?ml|toml|xml|ini)$/i,
  /^wp-config\.php$/i,
  /^\.htpasswd$/i,
]
const DENIED_PREFIXES = () => [
  process.env.SystemRoot ?? 'C:\\Windows',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data'),
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data'),
  join(process.env.APPDATA ?? '', 'Mozilla', 'Firefox', 'Profiles'),
  join(process.env.APPDATA ?? '', 'Microsoft', 'Credentials'),
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Credentials'),
  join(process.env.APPDATA ?? '', 'Microsoft', 'Protect'),
  join(process.env.APPDATA ?? '', 'Microsoft', 'Outlook'),
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Outlook'),
]

const caseInsensitive = process.platform === 'win32'

function norm(p: string): string {
  const r = resolve(p)
  return caseInsensitive ? r.toLowerCase() : r
}

export function isInside(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  if (c === p) return true
  const rel = relative(p, c)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Resolve symlinks/junctions. For paths that don't exist yet, resolve the nearest existing ancestor. */
export function canonical(p: string): string {
  const abs = resolve(p)
  let existing = abs
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    rest.unshift(basename(existing))
    existing = parent
  }
  const real = existsSync(existing) ? realpathSync.native(existing) : existing
  return rest.length ? join(real, ...rest) : real
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

export function deniedReason(path: string, config: Config): string | null {
  const p = canonical(path)
  const segments = p.split(sep).map((s) => s.toLowerCase())
  for (const seg of DENIED_SEGMENTS) if (segments.includes(seg)) return `protected location (${seg})`
  const name = basename(p)
  for (const re of DENIED_NAMES) if (re.test(name)) return `secret-bearing file name (${name})`
  for (const prefix of DENIED_PREFIXES()) if (prefix && isInside(p, prefix)) return 'protected system or profile location'
  for (const pattern of config.extraDeny) {
    const re = globToRegex(pattern)
    if (re.test(name) || re.test(p)) return `denied by configuration (${pattern})`
  }
  // Other users' profiles.
  const usersRoot = join(process.env.SystemDrive ?? 'C:', sep, 'Users')
  const home = process.env.USERPROFILE
  if (home && isInside(p, usersRoot) && !isInside(p, home) && norm(p) !== norm(usersRoot)) return "another user's profile"
  return null
}

export type Access = 'read' | 'write'

export class Scope {
  private config: Config
  private store: Store
  constructor(config: Config, store: Store) {
    this.config = config
    this.store = store
  }

  readRoots(): string[] {
    const granted = this.store.activeGrants().map((g) => g.path)
    return [...this.config.readRoots, ...this.config.workspaces, ...granted].map(canonical)
  }

  writeRoots(): string[] {
    const granted = this.store.activeGrants().filter((g) => g.mode === 'write').map((g) => g.path)
    return [...this.config.workspaces, ...granted].map(canonical)
  }

  /** Canonicalize and check a path; throws ScopeError with a reason the agent can act on. */
  check(path: string, access: Access, base?: string): string {
    if (!path || typeof path !== 'string') throw new ScopeError('A path is required.')
    const abs = isAbsolute(path) ? path : resolve(base ?? this.defaultBase(), path)
    const p = canonical(abs)
    const denied = deniedReason(p, this.config)
    if (denied) throw new ScopeError(`Access denied: ${denied}. This path is never shared.`)
    // Git's own folder can make plain `git status`/`git diff` run programs (hooks, fsmonitor, diff
    // drivers), so agents may read it but never change it.
    if (access === 'write' && p.split(sep).some((s) => s.toLowerCase() === '.git')) {
      throw new ScopeError(`Access denied: ${p} is inside a .git folder, which agents can't change. Use git through the user instead.`)
    }
    const roots = access === 'read' ? this.readRoots() : this.writeRoots()
    if (!roots.some((r) => isInside(p, r))) {
      const err = new ScopeError(
        `${p} is outside the allowed ${access} roots. Call list_roots to see them, or request_access to ask the user for more.`,
      )
      err.outside = { path: p, access }
      throw err
    }
    return p
  }

  defaultBase(): string {
    return this.store.state.activeWorkspace ?? this.config.workspaces[0] ?? this.config.readRoots[0] ?? process.cwd()
  }

  activeWorkspace(): string | null {
    const ws = this.store.state.activeWorkspace ?? this.config.workspaces[0] ?? null
    return ws ? canonical(ws) : null
  }
}
