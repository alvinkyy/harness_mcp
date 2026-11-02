// Mandatory integrity labels for the sandbox (Windows). Sandboxed commands run at Low integrity, so
// they can only write to objects labelled Low. These helpers label the workspaces Low, keep `.git`
// at Medium (read-only for the sandbox), and remove the labels again. SetNamedSecurityInfoW
// propagates the inheritable label to existing files and folders.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type Api = {
  ConvertSddl: (sddl: string, rev: number, out: unknown[], size: unknown) => boolean
  GetSecurityDescriptorSacl: (sd: unknown, present: number[], acl: unknown[], defaulted: number[]) => boolean
  SetNamedSecurityInfoW: (...a: unknown[]) => number
  LocalFree: (p: unknown) => unknown
  GetLastError: () => number
}

let api: Api | null | undefined

function load(): Api | null {
  if (api !== undefined) return api
  api = null
  if (process.platform !== 'win32') return api
  const koffi = require('koffi')
  const adv = koffi.load('advapi32.dll')
  const k32 = koffi.load('kernel32.dll')
  api = {
    ConvertSddl: adv.func('bool ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32_t, _Out_ void **, void *)'),
    GetSecurityDescriptorSacl: adv.func('bool GetSecurityDescriptorSacl(void *, _Out_ int *, _Out_ void **, _Out_ int *)'),
    SetNamedSecurityInfoW: adv.func('uint32_t SetNamedSecurityInfoW(str16, int, uint32_t, void *, void *, void *, void *)'),
    LocalFree: k32.func('void * LocalFree(void *)'),
    GetLastError: k32.func('uint32_t GetLastError()'),
  }
  return api
}

const SE_FILE_OBJECT = 1
const LABEL_SECURITY_INFORMATION = 0x10

export class LabelError extends Error {}

/** Apply a SACL holding only a mandatory label (or none) to `path`, inherited by everything below. */
function setLabel(path: string, sddl: string): void {
  const a = load()
  if (!a) throw new LabelError('Windows security API unavailable')
  const sd: unknown[] = [null]
  if (!a.ConvertSddl(sddl, 1, sd, null)) throw new LabelError(`building label ${sddl} failed (Win32 error ${a.GetLastError()})`)
  const present = [0]
  const sacl: unknown[] = [null]
  const defaulted = [0]
  if (!a.GetSecurityDescriptorSacl(sd[0], present, sacl, defaulted)) {
    a.LocalFree(sd[0])
    throw new LabelError(`reading label ${sddl} failed (Win32 error ${a.GetLastError()})`)
  }
  const err = a.SetNamedSecurityInfoW(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null, null, null, sacl[0])
  a.LocalFree(sd[0])
  if (err === 5) throw new LabelError(`not allowed to label ${path} (you may not own it)`)
  if (err) throw new LabelError(`labelling ${path} failed (Win32 error ${err})`)
}

/** Make `path` and everything below it writable by Low-integrity (sandboxed) processes. */
export function labelLow(path: string): void {
  setLabel(path, 'S:(ML;OICI;NW;;;LW)')
}

/** Keep `path` read-only for the sandbox even inside a Low-labelled folder (e.g. `.git`). */
export function labelMedium(path: string): void {
  setLabel(path, 'S:(ML;OICI;NW;;;ME)')
}

/** Remove harness-mcp's label from `path`; it falls back to the Windows default (Medium). */
export function clearLabel(path: string): void {
  setLabel(path, 'S:')
}

export function labelsAvailable(): boolean {
  return load() !== null
}
