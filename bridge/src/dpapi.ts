// Windows DPAPI (CryptProtectData): encrypts data so only the same Windows user on the same PC can
// decrypt it. Used for secrets.json, so a copied file (backup, sync folder, another account) is
// useless on its own.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Extra input mixed into the key: another program running as you can't decrypt by calling DPAPI alone. */
const ENTROPY = Buffer.from('harness-mcp secrets v2')
const CRYPTPROTECT_UI_FORBIDDEN = 0x1

type Blob = { cbData: number; pbData: unknown }
type Api = {
  protect: (input: Blob, desc: string, entropy: Blob, res: null, prompt: null, flags: number, out: Partial<Blob>) => boolean
  unprotect: (input: Blob, desc: null, entropy: Blob, res: null, prompt: null, flags: number, out: Partial<Blob>) => boolean
  localFree: (p: unknown) => unknown
  decode: (p: unknown, n: number) => Buffer
}

let api: Api | null | undefined

function load(): Api | null {
  if (api !== undefined) return api
  api = null
  if (process.platform !== 'win32') return api
  const koffi = require('koffi')
  koffi.struct('HMCP_DATA_BLOB', { cbData: 'uint32', pbData: 'void *' })
  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  api = {
    protect: crypt32.func('bool CryptProtectData(HMCP_DATA_BLOB *in, str16 desc, HMCP_DATA_BLOB *entropy, void *res, void *prompt, uint32 flags, _Out_ HMCP_DATA_BLOB *out)'),
    unprotect: crypt32.func('bool CryptUnprotectData(HMCP_DATA_BLOB *in, void *desc, HMCP_DATA_BLOB *entropy, void *res, void *prompt, uint32 flags, _Out_ HMCP_DATA_BLOB *out)'),
    localFree: kernel32.func('void * LocalFree(void *)'),
    decode: (p, n) => Buffer.from(koffi.decode(p, koffi.array('uint8', n))),
  }
  return api
}

export function dpapiAvailable(): boolean {
  return load() !== null
}

function run(encrypt: boolean, data: Buffer): Buffer {
  const a = load()
  if (!a) throw new Error('Windows DPAPI is not available on this system.')
  const out: Partial<Blob> = {}
  const input = { cbData: data.length, pbData: data }
  const entropy = { cbData: ENTROPY.length, pbData: ENTROPY }
  const ok = encrypt
    ? a.protect(input, 'harness-mcp', entropy, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)
    : a.unprotect(input, null, entropy, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)
  if (!ok || !out.pbData) {
    throw new Error(encrypt ? 'Windows could not encrypt the secrets.' : 'Windows could not decrypt secrets.json. It was encrypted by another Windows user or on another PC.')
  }
  try {
    return a.decode(out.pbData, out.cbData ?? 0)
  } finally {
    a.localFree(out.pbData)
  }
}

export function protect(data: Buffer): Buffer {
  return run(true, data)
}

export function unprotect(data: Buffer): Buffer {
  return run(false, data)
}
