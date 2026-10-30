// Runs: every command or test recipe becomes a run with an id, a full log on disk and a digest the
// agent can read quickly (status, failures, file:line locations). Long runs keep going in the
// background; tool calls return after `toolWaitSec` with the run id.

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { audit } from './audit.ts'
import type { Config, TestRecipe } from './config.ts'
import { homePath, writeJsonAtomic } from './config.ts'
import { redact } from './redact.ts'
import { runSandboxed } from './sandbox.ts'

export type RunStatus = 'awaiting-approval' | 'running' | 'passed' | 'failed' | 'killed' | 'denied'

export type Run = {
  id: string
  kind: 'command' | 'tests'
  trigger: 'agent' | 'local' | 'watch'
  clientId: string
  cwd: string
  commands: string[]
  status: RunStatus
  exitCode: number | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  confined: boolean
  logChars: number
  /** Last ~60 lines, redacted. */
  tail: string
  /** Lines that look like errors, with file:line locations when present. */
  problems: string[]
}

const runs: Run[] = []
const live = new Map<string, () => void>()
const waiters = new Map<string, (() => void)[]>()

// ---- Run history survives restarts: ~/.harness-mcp/runs/index.json ----

let saveTimer: NodeJS.Timeout | null = null

function persist(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeJsonAtomic(homePath('runs', 'index.json'), runs.slice(-200))
  }, 300)
  saveTimer.unref()
}

/** Load the saved history. Runs that were in flight when the server stopped can't finish, so they are closed. */
export function loadRuns(): void {
  const file = homePath('runs', 'index.json')
  if (!existsSync(file) || runs.length) return
  try {
    for (const r of JSON.parse(readFileSync(file, 'utf8')) as Run[]) {
      if (r.status === 'running') r.status = 'killed'
      if (r.status === 'awaiting-approval') r.status = 'denied'
      runs.push(r)
    }
  } catch {
    // A damaged index only loses history; logs stay on disk.
  }
}

export function listRuns(limit = 20): Run[] {
  return runs.slice(-limit).reverse()
}

export function getRun(id: string): Run | undefined {
  return id === 'latest' ? runs.at(-1) : runs.find((r) => r.id === id)
}

function notify(run: Run): void {
  for (const w of waiters.get(run.id) ?? []) w()
  waiters.delete(run.id)
}

/** Wait until the run finishes (including any wait for the user's approval) or `ms` passes. */
export function waitForRun(run: Run, ms: number): Promise<Run> {
  if (run.status !== 'running' && run.status !== 'awaiting-approval') return Promise.resolve(run)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(run), ms)
    const list = waiters.get(run.id) ?? []
    list.push(() => {
      clearTimeout(timer)
      resolve(run)
    })
    waiters.set(run.id, list)
  })
}

export function createRun(init: Pick<Run, 'kind' | 'trigger' | 'clientId' | 'cwd' | 'commands'>, awaitingApproval: boolean): Run {
  const run: Run = {
    ...init,
    id: `run_${randomUUID()}`,
    status: awaitingApproval ? 'awaiting-approval' : 'running',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    confined: false,
    logChars: 0,
    tail: '',
    problems: [],
  }
  runs.push(run)
  if (runs.length > 500) runs.shift()
  persist()
  return run
}

const PROBLEM_RE = /(error|fail(ed|ure)?|exception|fatal|panic|traceback|assert|✗|✖|not ok)/i
const LOCATION_RE = /([A-Za-z]:)?[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|php|py|cs|go|rs|java|kt|rb|vue|svelte|css|scss|json|ya?ml)[:(]\d+/

function digest(run: Run, log: string): void {
  const lines = redact(log).text.split(/\r?\n/)
  run.tail = lines.slice(-60).join('\n')
  const problems: string[] = []
  for (let i = 0; i < lines.length && problems.length < 40; i++) {
    const l = lines[i]
    if (PROBLEM_RE.test(l) || LOCATION_RE.test(l)) {
      const text = l.trim().slice(0, 300)
      if (text && !problems.includes(text)) problems.push(text)
    }
  }
  run.problems = problems
}

/** Execute an already-approved run. */
export async function startRun(run: Run, config: Config): Promise<void> {
  mkdirSync(homePath('runs'), { recursive: true })
  const logFile = homePath('runs', `${run.id}.log`)
  run.status = 'running'
  run.startedAt = new Date().toISOString()
  persist()
  const t0 = Date.now()
  let log = ''
  let killed = false
  live.set(run.id, () => {
    killed = true
  })
  audit('run-start', { runId: run.id, clientId: run.clientId, trigger: run.trigger, cwd: run.cwd, commands: run.commands })
  for (const command of run.commands) {
    const header = `$ ${command}\n`
    log += header
    appendFileSync(logFile, header)
    const proc = runSandboxed(command, run.cwd, {
      memoryMb: config.limits.commandMemoryMb,
      cpuSeconds: config.limits.commandTimeoutSec,
      timeoutSec: config.limits.commandTimeoutSec,
    })
    run.confined = proc.confined
    live.set(run.id, () => {
      killed = true
      proc.kill()
    })
    const onData = (d: Buffer) => {
      const s = d.toString('utf8')
      log += s
      run.logChars = log.length
      appendFileSync(logFile, s)
    }
    proc.child.stdout?.on('data', onData)
    proc.child.stderr?.on('data', onData)
    const code = await proc.done
    run.exitCode = code
    const footer = `\n[exit ${code ?? 'killed'}]\n`
    log += footer
    appendFileSync(logFile, footer)
    if (killed || code !== 0) break
  }
  live.delete(run.id)
  run.durationMs = Date.now() - t0
  run.finishedAt = new Date().toISOString()
  run.logChars = log.length
  run.status = killed ? 'killed' : run.exitCode === 0 ? 'passed' : 'failed'
  digest(run, log)
  persist()
  audit('run-end', { runId: run.id, status: run.status, exitCode: run.exitCode, durationMs: run.durationMs })
  notify(run)
}

export function killRun(id: string): boolean {
  const k = live.get(id)
  if (!k) return false
  k()
  return true
}

export function denyRun(run: Run): void {
  run.status = 'denied'
  run.finishedAt = new Date().toISOString()
  persist()
  notify(run)
}

/** The configured recipe for a workspace, or one detected from its files. */
export function recipeFor(workspace: string, config: Config): TestRecipe | null {
  for (const [path, recipe] of Object.entries(config.recipes)) {
    if (path.toLowerCase() === workspace.toLowerCase()) return recipe
  }
  const has = (f: string) => existsSync(join(workspace, f))
  if (has('package.json')) return { commands: ['npm test'] }
  if (has('composer.json')) return { commands: [existsSync(join(workspace, 'vendor', 'bin', 'phpunit')) ? 'vendor\\bin\\phpunit' : 'composer test'] }
  if (has('pytest.ini') || has('conftest.py')) return { commands: ['python -m pytest -q'] }
  // Plain Python projects: the standard-library runner needs no installs.
  if (readdirSync(workspace).some((f) => /^test_.*\.py$|_test\.py$/i.test(f)) || has('tests')) {
    return { commands: ['python -m unittest -v'] }
  }
  if (has('pyproject.toml')) return { commands: ['python -m pytest -q'] }
  if (has('go.mod')) return { commands: ['go test ./...'] }
  if (has('Cargo.toml')) return { commands: ['cargo test'] }
  return null
}

// ---- File watcher: re-run a workspace's recipe when files change (recipes with watch: true) ----

const IGNORED = /(^|[\\/])(node_modules|\.git|vendor|dist|build|out|\.next|target|bin|obj|__pycache__|\.venv|coverage)([\\/]|$)/

const watchers = new Map<string, FSWatcher>()

/** Files an agent (or a pasted patch) just wrote: the agent tests those itself, so watch mode skips them. */
const recentWrites = new Map<string, number>()
const SKIP_MS = 5000

export function noteAgentWrite(paths: string[]): void {
  const now = Date.now()
  for (const p of paths) recentWrites.set(p.toLowerCase(), now)
  for (const [p, at] of recentWrites) if (now - at > SKIP_MS) recentWrites.delete(p)
}

export function writtenByAgent(path: string): boolean {
  const at = recentWrites.get(path.toLowerCase())
  return at !== undefined && Date.now() - at < SKIP_MS
}

/** Whether watch mode may run a workspace's tests unasked; untrusted workspaces with unseen agent changes may not. */
let mayAutoRun: (workspace: string) => boolean = () => true

export function setAutoRunGuard(guard: (workspace: string) => boolean): void {
  mayAutoRun = guard
}

export function syncWatchers(config: Config, workspaces: string[]): void {
  const wanted = new Set(workspaces.filter((w) => recipeFor(w, config)?.watch))
  for (const [ws, w] of watchers) if (!wanted.has(ws)) (w.close(), watchers.delete(ws))
  for (const ws of wanted) {
    if (watchers.has(ws) || !existsSync(ws)) continue
    let timer: NodeJS.Timeout | null = null
    const w = watch(ws, { recursive: true }, (_event, file) => {
      if (!file || IGNORED.test(file) || writtenByAgent(join(ws, file))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const recipe = recipeFor(ws, config)
        if (!recipe || !mayAutoRun(ws)) return
        const current = runs.findLast((r) => r.trigger === 'watch' && r.cwd === ws && r.status === 'running')
        if (current) killRun(current.id)
        const run = createRun({ kind: 'tests', trigger: 'watch', clientId: 'local', cwd: ws, commands: recipe.commands }, false)
        void startRun(run, config)
      }, 1500)
    })
    watchers.set(ws, w)
  }
}
