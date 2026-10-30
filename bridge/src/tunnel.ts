// Managed Cloudflare quick tunnel (tunnel.mode "quick"): start cloudflared, read the random
// https://<words>.trycloudflare.com URL it prints, and keep it running.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { audit } from './audit.ts'
import type { Config } from './config.ts'

export type TunnelStatus = {
  mode: 'none' | 'quick'
  state: 'off' | 'starting' | 'up' | 'stopped' | 'error'
  url: string | null
  since: string | null
  message: string | null
  log: string[]
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

function findCloudflared(configured: string): string {
  if (configured) return configured
  for (const dir of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    const p = dir ? join(dir, 'cloudflared', 'cloudflared.exe') : ''
    if (p && existsSync(p)) return p
  }
  return 'cloudflared'
}

export class QuickTunnel {
  status: TunnelStatus
  private config: Config
  private child: ChildProcess | null = null
  private stopping = false
  private restarts = 0
  private listeners = new Set<(s: TunnelStatus) => void>()

  constructor(config: Config) {
    this.config = config
    this.status = { mode: config.tunnel.mode, state: 'off', url: null, since: null, message: null, log: [] }
  }

  onChange(listener: (s: TunnelStatus) => void): void {
    this.listeners.add(listener)
  }

  private set(patch: Partial<TunnelStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const l of this.listeners) l(this.status)
  }

  private logLine(line: string): void {
    const log = [...this.status.log, line.slice(0, 300)].slice(-40)
    this.status = { ...this.status, log }
  }

  start(): void {
    if (this.config.tunnel.mode !== 'quick' || this.child) return
    this.stopping = false
    const exe = findCloudflared(this.config.tunnel.cloudflared)
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.config.mcpPort}`]
    if (this.config.tunnel.protocol !== 'auto') args.push('--protocol', this.config.tunnel.protocol)
    this.set({ state: 'starting', url: null, message: 'Starting Cloudflare quick tunnel…', since: new Date().toISOString() })
    let child: ChildProcess
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      this.set({ state: 'error', message: `Could not start cloudflared: ${(e as Error).message}` })
      return
    }
    this.child = child
    const onData = (d: Buffer) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        this.logLine(line)
        const m = URL_RE.exec(line)
        if (m && this.status.url !== m[0]) {
          this.restarts = 0
          this.set({ state: 'up', url: m[0], message: null, since: new Date().toISOString() })
          audit('tunnel-up', { url: m[0] })
        }
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => this.set({ state: 'error', message: `cloudflared failed to start (${e.message}). Install it or set tunnel.cloudflared in config.json.` }))
    child.on('exit', (code) => {
      this.child = null
      if (this.stopping) return this.set({ state: 'stopped', url: null, message: 'Tunnel stopped.' })
      audit('tunnel-exit', { code })
      if (this.restarts++ < 5) {
        this.set({ state: 'starting', url: null, message: `cloudflared exited (code ${code}); restarting…` })
        setTimeout(() => this.start(), 3000 * this.restarts).unref()
      } else {
        this.set({ state: 'error', url: null, message: `cloudflared keeps exiting (code ${code}). Check the log below.` })
      }
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
    this.child = null
    this.set({ state: 'stopped', url: null })
  }

  restart(): void {
    this.stop()
    this.restarts = 0
    setTimeout(() => this.start(), 500).unref()
  }
}
