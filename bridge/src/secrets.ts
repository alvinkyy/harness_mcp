// Owner credentials for the OAuth consent page: a passphrase (stored as an scrypt hash) and a TOTP
// secret for an authenticator app (RFC 6238, SHA-1, 30 s, 6 digits).

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homePath, writeJsonAtomic } from './config.ts'
import { dpapiAvailable, protect, unprotect } from './dpapi.ts'

type Secrets = { passphrase: { salt: string; hash: string }; totpSecret: string }

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(s: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c)
    if (i < 0) continue
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totp(secret: string, time = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)))
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const o = h[h.length - 1] & 15
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
  return code
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  return [-1, 0, 1].some((w) => timingSafeEqual(Buffer.from(totp(secret, now + w * 30_000)), Buffer.from(clean)))
}

function file(): string {
  return homePath('secrets.json')
}

export function hasSecrets(): boolean {
  return existsSync(file())
}

/** On disk: the secrets JSON encrypted with Windows DPAPI (this user, this PC), base64 in an envelope. */
type Envelope = { format: 'dpapi-v1'; data: string }

function writeSecrets(secrets: Secrets): void {
  if (!dpapiAvailable()) return writeJsonAtomic(file(), secrets) // non-Windows: protected by file permissions only
  const envelope: Envelope = { format: 'dpapi-v1', data: protect(Buffer.from(JSON.stringify(secrets))).toString('base64') }
  writeJsonAtomic(file(), envelope)
}

function readSecrets(): Secrets {
  const raw = JSON.parse(readFileSync(file(), 'utf8')) as Secrets | Envelope
  if ('format' in raw && raw.format === 'dpapi-v1') return JSON.parse(unprotect(Buffer.from(raw.data, 'base64')).toString('utf8')) as Secrets
  return raw as Secrets
}

/** True when secrets.json is still stored as plain text. */
export function secretsArePlain(): boolean {
  if (!hasSecrets()) return false
  const raw = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
  return raw.format !== 'dpapi-v1'
}

/** Re-save a plain-text secrets.json encrypted. Returns true if it was migrated. */
export function migrateSecrets(): boolean {
  if (!dpapiAvailable() || !secretsArePlain()) return false
  writeSecrets(readSecrets())
  return true
}

export function createSecrets(passphrase: string): { totpSecret: string; otpauth: string } {
  if (passphrase.length < 12) throw new Error('Passphrase must be at least 12 characters.')
  const salt = randomBytes(16)
  const hash = scryptSync(passphrase, salt, 64)
  const totpSecret = base32Encode(randomBytes(20))
  writeSecrets({ passphrase: { salt: salt.toString('hex'), hash: hash.toString('hex') }, totpSecret })
  return { totpSecret, otpauth: `otpauth://totp/harness-mcp?secret=${totpSecret}&issuer=harness-mcp&digits=6&period=30` }
}

export function verifyOwner(passphrase: string, code: string): boolean {
  if (!hasSecrets()) return false
  let s: Secrets
  try {
    s = readSecrets()
  } catch {
    return false // unreadable or tampered secrets: fail closed
  }
  const expected = Buffer.from(s.passphrase.hash, 'hex')
  const actual = scryptSync(passphrase, Buffer.from(s.passphrase.salt, 'hex'), 64)
  const passOk = timingSafeEqual(expected, actual)
  const codeOk = verifyTotp(s.totpSecret, code)
  return passOk && codeOk
}
