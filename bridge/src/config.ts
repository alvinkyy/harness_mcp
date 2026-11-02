// Configuration and on-disk layout. Everything lives under HARNESS_HOME (default ~/.harness-mcp).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type TestRecipe = {
  /** Commands run in order inside the workspace; the run stops at the first failure. */
  commands: string[]
  /** Re-run the recipe automatically when files in the workspace change. */
  watch?: boolean
}

export type Config = {
  /**
   * Public HTTPS origin the web agents use, e.g. https://mcp.example.com, or "auto" to take it from
   * each request's Host header (for Cloudflare quick tunnels, whose hostname changes on every start).
   */
  publicUrl: string
  /** Host patterns accepted as the public origin when publicUrl is "auto"; `*` matches one DNS label. */
  publicHosts: string[]
  tunnel: {
    /** "quick": harness-mcp starts a Cloudflare quick tunnel itself and shows its URL. "none": you run the tunnel. */
    mode: 'none' | 'quick'
    /** cloudflared executable; found on PATH or in its default install folder when empty. */
    cloudflared: string
    /** Transport between cloudflared and Cloudflare; http2 works on networks that block QUIC. */
    protocol: 'http2' | 'quic' | 'auto'
  }
  mcpPort: number
  controlPort: number
  /** Folders the agent may read. Writes are limited to `workspaces`. */
  readRoots: string[]
  /** Project folders the agent may write to and run commands in. */
  workspaces: string[]
  /** Extra always-denied path patterns (added to the built-in list; the built-in list cannot be reduced). */
  extraDeny: string[]
  /** Commands that run without local approval. `*` matches any run of characters without shell operators. */
  commandAllowlist: string[]
  /** Test recipe per workspace path; workspaces without one get an auto-detected recipe. */
  recipes: Record<string, TestRecipe>
  /**
   * Command sandbox. "workspace-write" (default): commands can only write in the workspaces (and
   * approved write grants), `.git` stays read-only, and network tools are blocked (advisory).
   * "off": limits-only, commands run with your full Windows rights.
   */
  sandbox: { mode: 'workspace-write' | 'off' }
  /** How long audit logs, run logs, stored outputs and checkpoints are kept. */
  retention: { days: number; maxCheckpoints: number }
  limits: {
    commandTimeoutSec: number
    commandMemoryMb: number
    /**
     * How long a tool call waits for a run, or for the user's approval plus the run, before returning
     * the run id. Keep it under Cloudflare's 100 s origin timeout and ChatGPT's 120 s tunnel deadline.
     */
    toolWaitSec: number
    /** Tool output above this many characters is stored and returned as head + tail + handle. */
    inlineChars: number
    maxReadBytes: number
  }
  auth: {
    accessTokenMinutes: number
    refreshTokenDays: number
    idleDisconnectHours: number
    consentTimeoutSec: number
    maxFailedLogins: number
    lockoutMinutes: number
    /** Redirect-URI origins pre-trusted for client registration (each connection still needs local approval). */
    knownClientOrigins: string[]
  }
}

export function harnessHome(): string {
  return process.env.HARNESS_HOME ?? join(homedir(), '.harness-mcp')
}

export function homePath(...parts: string[]): string {
  return join(harnessHome(), ...parts)
}

export function defaultConfig(): Config {
  return {
    publicUrl: 'auto',
    publicHosts: ['*.trycloudflare.com'],
    tunnel: { mode: 'none', cloudflared: '', protocol: 'http2' },
    mcpPort: 8787,
    controlPort: 8788,
    readRoots: [join(homedir(), 'Desktop', 'Project')],
    workspaces: [],
    extraDeny: [],
    // Only commands that can't run code the agent wrote. Each workspace's own test command (its
    // recipe) is allowed too, exactly as written. Wildcards like `npm run *` are deliberately absent:
    // the agent can edit package.json, so they would let it run anything without asking.
    commandAllowlist: ['git status', 'git status *', 'git log *', 'git diff *', 'git show *', 'git branch', 'git branch --list *'],
    recipes: {},
    sandbox: { mode: 'workspace-write' },
    retention: { days: 14, maxCheckpoints: 200 },
    limits: {
      commandTimeoutSec: 600,
      commandMemoryMb: 4096,
      toolWaitSec: 85,
      inlineChars: 40_000,
      maxReadBytes: 2_000_000,
    },
    auth: {
      accessTokenMinutes: 15,
      refreshTokenDays: 30,
      idleDisconnectHours: 2,
      consentTimeoutSec: 120,
      maxFailedLogins: 5,
      lockoutMinutes: 15,
      knownClientOrigins: ['https://claude.ai', 'https://chatgpt.com', 'https://chat.openai.com'],
    },
  }
}

export function loadConfig(): Config {
  const file = homePath('config.json')
  const base = defaultConfig()
  if (!existsSync(file)) return base
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>
  return {
    ...base,
    ...raw,
    limits: { ...base.limits, ...raw.limits },
    auth: { ...base.auth, ...raw.auth },
    tunnel: { ...base.tunnel, ...raw.tunnel },
    retention: { ...base.retention, ...raw.retention },
    sandbox: { ...base.sandbox, ...raw.sandbox },
  }
}

export function saveConfig(config: Config): void {
  writeJsonAtomic(homePath('config.json'), config)
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}
