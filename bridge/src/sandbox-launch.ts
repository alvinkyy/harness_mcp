// Sandbox launcher (Windows). Runs as its own small Node process with the parent's stdio pipes, then:
//   1. mints a token from this process's token with every privilege removed and the integrity level
//      lowered to Low. Windows' mandatory integrity check then blocks writes to anything not labelled
//      Low: in practice everything except the workspaces and the sandbox's temp/cache folders,
//      which harness-mcp labels Low (see sandbox-label.ts);
//   2. creates the command SUSPENDED under that token, inheriting stdio;
//   3. puts it in a Job Object (memory/CPU caps, kill-on-close) before it runs a single instruction;
//   4. resumes it, waits, and exits with its exit code.
// Killing this launcher closes the job handle, which kills the whole sandboxed tree.
//
// Why Low integrity rather than Codex's write-restricted token: under a write-restricted token,
// named pipes the sandboxed process creates are only writable by its user SID, so Node/libuv child
// processes with piped stdio fail with EPERM (the same bug Codex tracks as openai/codex#47868).
// Low-integrity processes own their pipes normally. No Codex code is used.
//
// Usage: node sandbox-launch.ts <base64 JSON {command, cwd, memoryMb, cpuSeconds}>

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const koffi = require('koffi')

type Request = { command: string; cwd: string; memoryMb: number; cpuSeconds: number }

const k32 = koffi.load('kernel32.dll')
const adv = koffi.load('advapi32.dll')

const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'void *',
  lpDesktop: 'void *',
  lpTitle: 'void *',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void *',
  hStdInput: 'void *',
  hStdOutput: 'void *',
  hStdError: 'void *',
})
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', { hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32' })

const GetCurrentProcess = k32.func('void * GetCurrentProcess()')
const GetStdHandle = k32.func('void * GetStdHandle(int32_t)')
const SetHandleInformation = k32.func('bool SetHandleInformation(void *, uint32_t, uint32_t)')
const CreateJobObjectW = k32.func('void * CreateJobObjectW(void *, void *)')
const SetInformationJobObject = k32.func('bool SetInformationJobObject(void *, int, void *, uint32_t)')
const AssignProcessToJobObject = k32.func('bool AssignProcessToJobObject(void *, void *)')
const ResumeThread = k32.func('uint32_t ResumeThread(void *)')
const WaitForSingleObject = k32.func('uint32_t WaitForSingleObject(void *, uint32_t)')
const GetExitCodeProcess = k32.func('bool GetExitCodeProcess(void *, _Out_ uint32_t *)')
const TerminateProcess = k32.func('bool TerminateProcess(void *, uint32_t)')
const CloseHandle = k32.func('bool CloseHandle(void *)')
const GetLastError = k32.func('uint32_t GetLastError()')
const OpenProcessToken = adv.func('bool OpenProcessToken(void *, uint32_t, _Out_ void **)')
const ConvertStringSidToSidW = adv.func('bool ConvertStringSidToSidW(str16, _Out_ void **)')
const CreateRestrictedToken = adv.func('bool CreateRestrictedToken(void *, uint32_t, uint32_t, void *, uint32_t, void *, uint32_t, void *, _Out_ void **)')
const SetTokenInformation = adv.func('bool SetTokenInformation(void *, int, void *, uint32_t)')
const CreateProcessAsUserW = adv.func(
  'bool CreateProcessAsUserW(void *, str16, void *, void *, void *, bool, uint32_t, void *, str16, STARTUPINFOW *, _Out_ PROCESS_INFORMATION *)',
)

const TOKEN_ACCESS = 0x0001 | 0x0002 | 0x0008 | 0x0080 // ASSIGN_PRIMARY | DUPLICATE | QUERY | ADJUST_DEFAULT
const DISABLE_MAX_PRIVILEGE = 0x1
const TokenIntegrityLevel = 25
const SE_GROUP_INTEGRITY = 0x20
const LOW_INTEGRITY_SID = 'S-1-16-4096'
const CREATE_SUSPENDED = 0x4
const CREATE_NO_WINDOW = 0x08000000
const STARTF_USESTDHANDLES = 0x100
const HANDLE_FLAG_INHERIT = 0x1
const INFINITE = 0xffffffff

const tracing = process.env.HARNESS_SANDBOX_TRACE === '1'
function trace(step: string): void {
  if (tracing) process.stderr.write(`[sandbox trace] ${step}\n`)
}

function fail(step: string): never {
  process.stderr.write(`[harness-mcp sandbox] ${step} failed (Win32 error ${GetLastError()}). The command did not run.\n`)
  process.exit(126)
}

const req = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')) as Request

// 1. Low-integrity token without privileges.
const own: unknown[] = [null]
if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ACCESS, own)) fail('OpenProcessToken')
const token: unknown[] = [null]
if (!CreateRestrictedToken(own[0], DISABLE_MAX_PRIVILEGE, 0, null, 0, null, 0, null, token)) fail('CreateRestrictedToken')
const lowSid: unknown[] = [null]
if (!ConvertStringSidToSidW(LOW_INTEGRITY_SID, lowSid)) fail('ConvertStringSidToSid')
const label = koffi.alloc('uint8', 16) // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { PSID, DWORD } }
koffi.encode(label, 'void *', lowSid[0])
koffi.encode(label, 8, 'uint32', SE_GROUP_INTEGRITY)
if (!SetTokenInformation(token[0], TokenIntegrityLevel, label, 16)) fail('SetTokenInformation(TokenIntegrityLevel)')
trace('low-integrity token ok')

// 2. Job Object with limits; the child joins it before it runs.
const job = CreateJobObjectW(null, null)
if (!job) fail('CreateJobObject')
const info = Buffer.alloc(144) // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64)
info.writeBigInt64LE(BigInt(req.cpuSeconds) * 10_000_000n, 8)
info.writeUInt32LE(0x4 | 0x200 | 0x400 | 0x2000, 16) // JOB_TIME | JOB_MEMORY | DIE_ON_UNHANDLED_EXCEPTION | KILL_ON_JOB_CLOSE
info.writeBigUInt64LE(BigInt(req.memoryMb) * 1024n * 1024n, 64 + 48 + 8)
if (!SetInformationJobObject(job, 9, info, info.length)) fail('SetInformationJobObject')
trace('job ok')

// 3. Start suspended with inherited stdio.
const std = [GetStdHandle(-10), GetStdHandle(-11), GetStdHandle(-12)]
for (const h of std) if (h) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
const si = {
  cb: koffi.sizeof(STARTUPINFOW),
  lpReserved: null,
  lpDesktop: null,
  lpTitle: null,
  dwX: 0,
  dwY: 0,
  dwXSize: 0,
  dwYSize: 0,
  dwXCountChars: 0,
  dwYCountChars: 0,
  dwFillAttribute: 0,
  dwFlags: STARTF_USESTDHANDLES,
  wShowWindow: 0,
  cbReserved2: 0,
  lpReserved2: null,
  hStdInput: std[0],
  hStdOutput: std[1],
  hStdError: std[2],
}
const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
// CreateProcessW may write into the command-line buffer, so pass a private UTF-16 copy.
const cmdline = Buffer.from(`"${comspec}" /d /s /c ${req.command}\0`, 'utf16le')
const pi: Record<string, unknown> = {}
if (!CreateProcessAsUserW(token[0], null, cmdline, null, null, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, null, req.cwd, si, pi)) {
  fail('CreateProcessAsUser')
}
if (!AssignProcessToJobObject(job, pi.hProcess)) {
  TerminateProcess(pi.hProcess, 126)
  fail('AssignProcessToJobObject')
}
ResumeThread(pi.hThread)
CloseHandle(pi.hThread)
trace('process running')

// 4. Wait off the main thread so a kill signal from the parent still lands, then mirror the exit code.
WaitForSingleObject.async(pi.hProcess, INFINITE, () => {
  const code = [0]
  GetExitCodeProcess(pi.hProcess, code)
  process.exit(code[0])
})
