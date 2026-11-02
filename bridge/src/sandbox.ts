// Command sandbox (Windows), modelled on Codex's Windows sandbox ("sandboxed by default, writes
// confined to the workspace, network off"), using Windows integrity levels for the write boundary:
//
//   workspace-write (default)
//     - Every command runs at LOW integrity with no privileges (see sandbox-launch.ts). Windows then
//       blocks writes to anything not labelled Low. harness-mcp labels Low only the workspaces,
//       write grants you approved, and the sandbox's own temp/cache folders; `.git` folders are
//       labelled Medium so they stay read-only. Your profile, other projects and the registry are
//       not writable.
//     - The process is created suspended and joins a Job Object before it runs: whole-tree kill on
//       timeout, memory and CPU caps, no start-up escape window.
//     - Network is blocked the way Codex's unelevated mode does it: proxies point at a dead port,
//       git/ssh/scp/sftp fail, npm/pip run offline. This is ADVISORY: a program that opens sockets
//       itself can still reach the network. Reads are not restricted (same as Codex).
//   limits-only (sandbox off, unavailable, or a command you approved to run outside it)
//     - Job Object limits and a scrubbed environment; full user rights.
//
// The folders whose labels were changed are recorded, so `npm run sandbox:remove` can undo them.
// Trade-off (the reason Codex chose a different mechanism): a Low-labelled workspace is also
// writable by any other Low-integrity program on the PC. Such programs are rare (legacy
// "protected mode" apps); browsers' sandboxes run below Low and can't write there.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit } from './audit.ts'
import { homePath, writeJsonAtomic, type Config } from './config.ts'
import { clearLabel, labelLow, labelMedium, labelsAvailable } from './sandbox-label.ts'

const require = createRequire(import.meta.url)
const isWin = process.platform === 'win32'

// ---------------------------------------------------------------- Job Object (limits-only path)

type Kernel = {
  createJob: () => bigint
  setInfo: (job: bigint, cls: number, info: Buffer, len: number) => boolean
  openProcess: (access: number, inherit: boolean, pid: number) => bigint
  assign: (job: bigint, proc: bigint) => boolean
  terminate: (job: bigint, code: number) => boolean
  close: (h: bigint) => boolean
}

let kernel: Kernel | null | undefined

function loadKernel(): Kernel | null {
  if (kernel !== undefined) return kernel
  kernel = null
  if (!isWin) return kernel
  try {
    const koffi = require('koffi')
    const k32 = koffi.load('kernel32.dll')
    kernel = {
      createJob: k32.func('void * CreateJobObjectW(void *, void *)').bind(null, null, null),
      setInfo: k32.func('bool SetInformationJobObject(void *, int, void *, uint32_t)'),
      openProcess: k32.func('void * OpenProcess(uint32_t, bool, uint32_t)'),
      assign: k32.func('bool AssignProcessToJobObject(void *, void *)'),
      terminate: k32.func('bool TerminateJobObject(void *, uint32_t)'),
      close: k32.func('bool CloseHandle(void *)'),
    }
  } catch {
    kernel = null
  }
  return kernel
}

export type JobLimits = { memoryMb: number; cpuSeconds: number }

/** Create a job with limits and put `pid` into it. Returns a handle object or null if unavailable. */
export function confine(pid: number, limits: JobLimits): { kill: () => void; release: () => void } | null {
  const k = loadKernel()
  if (!k) return null
  const job = k.createJob()
  if (!job) return null
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64): 64-byte basic block, 48-byte IO counters, 4 SIZE_T.
  const info = Buffer.alloc(144)
  info.writeBigInt64LE(BigInt(limits.cpuSeconds) * 10_000_000n, 8) // PerJobUserTimeLimit, 100 ns units
  info.writeUInt32LE(0x4 | 0x200 | 0x400 | 0x2000, 16) // JOB_TIME | JOB_MEMORY | DIE_ON_UNHANDLED_EXCEPTION | KILL_ON_JOB_CLOSE
  info.writeBigUInt64LE(BigInt(limits.memoryMb) * 1024n * 1024n, 64 + 48 + 8) // JobMemoryLimit
  if (!k.setInfo(job, 9, info, info.length)) {
    k.close(job)
    return null
  }
  const proc = k.openProcess(0x0100 | 0x0001, false, pid) // PROCESS_SET_QUOTA | PROCESS_TERMINATE
  const assigned = proc ? k.assign(job, proc) : false
  if (proc) k.close(proc)
  if (!assigned) {
    k.close(job)
    return null
  }
  let closed = false
  return {
    kill: () => {
      if (!closed) k.terminate(job, 1)
    },
    release: () => {
      if (!closed) {
        closed = true
        k.close(job) // KILL_ON_JOB_CLOSE: anything still running in the job dies here.
      }
    },
  }
}

const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|^AWS_|^AZURE_|^GCP_|^GOOGLE_|^GH_|^GITHUB_|^OPENAI|^ANTHROPIC|^CLOUDFLARE|^CF_|^NPM_|^HARNESS_/i

export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v
  env.CI = '1'
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

// ---------------------------------------------------------------- sandbox state

export type SandboxMode = 'workspace-write' | 'limits-only'

export type SandboxStatus = {
  /** What actually applies to commands right now. */
  mode: SandboxMode
  /** What the configuration asks for. */
  requested: 'workspace-write' | 'off'
  detail: string
  writableRoots: string[]
  errors: string[]
  network: 'blocked (advisory)' | 'allowed'
}

type Meta = { applied: { path: string; kind: 'low' | 'medium' }[] }

let status: SandboxStatus = {
  mode: 'limits-only',
  requested: 'off',
  detail: 'Sandbox not initialised.',
  writableRoots: [],
  errors: [],
  network: 'allowed',
}
let meta: Meta | null = null
let currentRoots: string[] = []

export function sandboxStatus(): SandboxStatus {
  return status
}

/** The sandbox's own folders: temp, caches, and stub commands that block network tools. */
export function sandboxDir(...parts: string[]): string {
  const base = process.env.HARNESS_SANDBOX_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'harness-mcp-sandbox')
  return join(base, ...parts)
}

function metaFile(): string {
  return homePath('sandbox.json')
}

function loadMeta(): Meta {
  if (meta) return meta
  meta = existsSync(metaFile()) ? (JSON.parse(readFileSync(metaFile(), 'utf8')) as Meta) : { applied: [] }
  if (!Array.isArray(meta.applied)) meta = { applied: [] }
  // Entries from the earlier restricted-token prototype are not labels; forget them.
  meta.applied = meta.applied.filter((a) => a.kind === 'low' || a.kind === 'medium')
  return meta
}

function saveMeta(): void {
  if (meta) writeJsonAtomic(metaFile(), meta)
}

const DENY_STUB = '@echo [harness-mcp sandbox] network tools are blocked inside the sandbox. Ask the user to approve this command to run outside it. 1>&2\r\n@exit /b 1\r\n'

function prepareDirs(): void {
  for (const d of ['tmp', 'cache', 'denybin']) mkdirSync(sandboxDir(d), { recursive: true })
  for (const tool of ['ssh', 'scp', 'sftp', 'ftp', 'telnet']) {
    const f = sandboxDir('denybin', `${tool}.cmd`)
    if (!existsSync(f)) writeFileSync(f, DENY_STUB)
  }
}

const key = (p: string) => p.toLowerCase()

/**
 * Bring folder labels in line with the current writable roots: label new ones Low, keep `.git`
 * Medium inside them, and clear the labels from roots that are no longer writable. Cheap when
 * nothing changed, so it also runs before each sandboxed command (to catch a new `.git`).
 */
export function syncSandboxAcls(roots: string[] = currentRoots): void {
  currentRoots = roots
  if (status.requested !== 'workspace-write' || !meta) return
  const desired: Meta['applied'] = []
  for (const r of [...new Set([...roots, sandboxDir('tmp'), sandboxDir('cache')])]) {
    if (!existsSync(r)) continue
    desired.push({ path: r, kind: 'low' })
    if (existsSync(join(r, '.git'))) desired.push({ path: join(r, '.git'), kind: 'medium' })
  }
  const want = new Set(desired.map((d) => `${d.kind}|${key(d.path)}`))
  const have = new Set(meta.applied.map((d) => `${d.kind}|${key(d.path)}`))
  const stale = meta.applied.filter((d) => !want.has(`${d.kind}|${key(d.path)}`))
  const fresh = desired.filter((d) => !have.has(`${d.kind}|${key(d.path)}`))
  if (!stale.length && !fresh.length) return
  const errors: string[] = []
  for (const a of stale) {
    try {
      if (existsSync(a.path)) clearLabel(a.path)
      audit('sandbox-label', { action: 'clear', path: a.path })
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  meta.applied = meta.applied.filter((d) => want.has(`${d.kind}|${key(d.path)}`))
  // Low before Medium, so a .git Medium label sits on top of the label inherited from the workspace.
  for (const d of [...fresh.filter((x) => x.kind === 'low'), ...fresh.filter((x) => x.kind === 'medium')]) {
    try {
      if (d.kind === 'low') labelLow(d.path)
      else labelMedium(d.path)
      meta.applied.push(d)
      audit('sandbox-label', { action: d.kind, path: d.path })
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  saveMeta()
  status = { ...status, writableRoots: meta.applied.filter((d) => d.kind === 'low').map((d) => d.path), errors }
}

/** Run one command through the launcher synchronously (start-up self-test only). */
function launchSync(command: string, cwd: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [LAUNCHER, request(command, cwd, { memoryMb: 512, cpuSeconds: 20 })], {
    cwd,
    env: sandboxEnv(),
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/** Prove the sandbox works and confines: a write inside its temp folder succeeds, one outside fails. */
function selfTest(): string | null {
  const cwd = sandboxDir('tmp')
  const inside = launchSync('echo sandbox-ok> probe.txt && type probe.txt', cwd)
  if (inside.code !== 0 || !inside.out.includes('sandbox-ok')) return `a sandboxed command could not run (exit ${inside.code}): ${inside.out.slice(0, 200)}`
  const target = homePath('sandbox-escape-probe.txt')
  rmSync(target, { force: true })
  launchSync(`echo escaped> "${target}"`, cwd)
  if (existsSync(target)) {
    rmSync(target, { force: true })
    return 'a sandboxed command was able to write outside its folders'
  }
  return null
}

/** Set up the sandbox at start. Falls back to limits-only (and says why) when it can't be enforced. */
export function initSandbox(config: Config, roots: string[]): SandboxStatus {
  const requested = config.sandbox.mode
  currentRoots = roots
  status = { mode: 'limits-only', requested, detail: '', writableRoots: [], errors: [], network: 'allowed' }
  if (requested === 'off') {
    status.detail = 'Sandbox switched off in config.json (sandbox.mode = "off").'
    return status
  }
  if (!isWin || !labelsAvailable()) {
    status.detail = 'The write sandbox is only available on Windows.'
    return status
  }
  try {
    loadMeta()
    prepareDirs()
    syncSandboxAcls(roots)
    const problem = selfTest()
    if (problem) {
      status.detail = `Sandbox self-test failed: ${problem}. Commands run limits-only until this is fixed.`
      audit('sandbox', { state: 'failed', problem })
      return status
    }
  } catch (e) {
    status.detail = `Sandbox setup failed: ${(e as Error).message}. Commands run limits-only until this is fixed.`
    audit('sandbox', { state: 'failed', problem: (e as Error).message })
    return status
  }
  status = { ...status, mode: 'workspace-write', network: 'blocked (advisory)', detail: 'Writes confined to the workspaces (Low integrity); network blocked for common tools.' }
  audit('sandbox', { state: 'on', writableRoots: status.writableRoots })
  return status
}

/** Undo every label the sandbox applied (npm run sandbox:remove). */
export function removeSandbox(): string[] {
  if (!existsSync(metaFile())) return []
  const m = loadMeta()
  const done: string[] = []
  // Clear .git labels before their workspace's.
  for (const a of [...m.applied].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'medium' ? -1 : 1))) {
    try {
      if (existsSync(a.path)) clearLabel(a.path)
      done.push(a.path)
    } catch (e) {
      done.push(`${a.path} (failed: ${(e as Error).message})`)
    }
  }
  m.applied = []
  saveMeta()
  return done
}

// ---------------------------------------------------------------- running commands

const LAUNCHER = fileURLToPath(new URL('./sandbox-launch.ts', import.meta.url))
const DEAD_PROXY = 'http://127.0.0.1:9'

/** Environment for sandboxed commands: scrubbed, temp/caches redirected, network tools pointed nowhere. */
export function sandboxEnv(): NodeJS.ProcessEnv {
  const env = scrubbedEnv()
  const tmp = sandboxDir('tmp')
  Object.assign(env, {
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: sandboxDir('cache', 'npm'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    PIP_CACHE_DIR: sandboxDir('cache', 'pip'),
    PIP_NO_INDEX: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    YARN_CACHE_FOLDER: sandboxDir('cache', 'yarn'),
    GOCACHE: sandboxDir('cache', 'go'),
    GOPROXY: 'off',
    COMPOSER_CACHE_DIR: sandboxDir('cache', 'composer'),
    NUGET_PACKAGES: sandboxDir('cache', 'nuget'),
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    ALL_PROXY: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    all_proxy: DEAD_PROXY,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    GIT_SSH_COMMAND: 'cmd /c exit 1',
    GIT_TERMINAL_PROMPT: '0',
    HARNESS_SANDBOX: 'workspace-write',
  })
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
  env[pathKey] = `${sandboxDir('denybin')};${env[pathKey] ?? ''}`
  return env
}

function request(command: string, cwd: string, limits: JobLimits): string {
  return Buffer.from(JSON.stringify({ command, cwd, memoryMb: limits.memoryMb, cpuSeconds: limits.cpuSeconds })).toString('base64')
}

export type Sandboxed = { child: ChildProcess; confined: boolean; mode: SandboxMode | 'outside'; kill: () => void; done: Promise<number | null> }

/**
 * Run a shell command line. Inside the sandbox unless it is off/unavailable, or `outside` is set
 * (only for commands the user approved to run outside it).
 */
export function runSandboxed(command: string, cwd: string, limits: JobLimits & { timeoutSec: number }, opts: { outside?: boolean } = {}): Sandboxed {
  const sandboxed = isWin && !opts.outside && status.mode === 'workspace-write'
  let child: ChildProcess
  let job: ReturnType<typeof confine> = null
  if (sandboxed) {
    syncSandboxAcls() // keep a .git created since the last command read-only
    // The launcher creates the command suspended inside its own Job Object, so no separate confine().
    child = spawn(process.execPath, [LAUNCHER, request(command, cwd, limits)], { cwd, env: sandboxEnv(), windowsHide: true })
  } else {
    child = isWin
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { cwd, env: scrubbedEnv(), windowsHide: true, windowsVerbatimArguments: true })
      : spawn('/bin/sh', ['-c', command], { cwd, env: scrubbedEnv(), detached: true })
    job = child.pid ? confine(child.pid, limits) : null
  }
  const killTree = () => {
    job?.kill()
    if (child.pid && child.exitCode === null) {
      if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
    }
  }
  const timer = setTimeout(killTree, limits.timeoutSec * 1000)
  const done = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      job?.release()
      resolve(code)
    })
    child.on('error', () => {
      clearTimeout(timer)
      job?.release()
      resolve(null)
    })
  })
  const mode = opts.outside ? 'outside' : sandboxed ? 'workspace-write' : 'limits-only'
  return { child, confined: sandboxed || job !== null, mode, kill: killTree, done }
}
