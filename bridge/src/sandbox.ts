// Command sandbox, phase 1 (Windows):
//   - every command runs inside a Job Object: the whole process tree is killed on timeout or close,
//     with a memory cap and CPU-time cap;
//   - the environment is scrubbed of credential-looking variables;
//   - cwd must be inside a write root (checked by the caller).
// Known gap: Node cannot create a process suspended, so a child the command spawns in the first
// milliseconds, before it is assigned to the job, can escape the job. A process-tree kill
// (taskkill /T) on timeout is the backstop. Filesystem write confinement (restricted token) is phase 2.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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
  if (process.platform !== 'win32') return kernel
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

const JobObjectExtendedLimitInformation = 9
const LIMIT_JOB_TIME = 0x4
const LIMIT_JOB_MEMORY = 0x200
const LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400
const LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001

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
  info.writeUInt32LE(LIMIT_JOB_TIME | LIMIT_JOB_MEMORY | LIMIT_DIE_ON_UNHANDLED_EXCEPTION | LIMIT_KILL_ON_JOB_CLOSE, 16)
  info.writeBigUInt64LE(BigInt(limits.memoryMb) * 1024n * 1024n, 64 + 48 + 8) // JobMemoryLimit
  if (!k.setInfo(job, JobObjectExtendedLimitInformation, info, info.length)) {
    k.close(job)
    return null
  }
  const proc = k.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
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

export type Sandboxed = { child: ChildProcess; confined: boolean; kill: () => void; done: Promise<number | null> }

/** Run a shell command line inside the sandbox. */
export function runSandboxed(command: string, cwd: string, limits: JobLimits & { timeoutSec: number }): Sandboxed {
  const isWin = process.platform === 'win32'
  const child = isWin
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { cwd, env: scrubbedEnv(), windowsHide: true, windowsVerbatimArguments: true })
    : spawn('/bin/sh', ['-c', command], { cwd, env: scrubbedEnv(), detached: true })
  const job = child.pid ? confine(child.pid, limits) : null
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
  return { child, confined: job !== null, kill: killTree, done }
}
