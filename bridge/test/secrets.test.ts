// Step 3: secrets.json is encrypted with Windows DPAPI, and old plain-text files are migrated.

import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { after, test } from 'node:test'
import * as h from './helpers.ts'
import { homePath } from '../src/config.ts'
import { createSecrets, migrateSecrets, secretsArePlain, totp, verifyOwner } from '../src/secrets.ts'

after(() => h.running.close())

const file = () => homePath('secrets.json')

test('new secrets are written encrypted; the authenticator secret is not on disk in clear', () => {
  const { totpSecret } = createSecrets('a brand new passphrase')
  const raw = readFileSync(file(), 'utf8')
  assert.equal(JSON.parse(raw).format, 'dpapi-v1')
  assert.ok(!raw.includes(totpSecret))
  assert.ok(!raw.includes('passphrase'))
  assert.equal(verifyOwner('a brand new passphrase', totp(totpSecret)), true)
  assert.equal(verifyOwner('wrong passphrase!!', totp(totpSecret)), false)
})

test('an old plain-text secrets.json is migrated in place and keeps working', () => {
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
  writeFileSync(file(), JSON.stringify({ passphrase: { salt: salt.toString('hex'), hash: scryptSync('legacy passphrase', salt, 64).toString('hex') }, totpSecret }))
  assert.equal(secretsArePlain(), true)
  assert.equal(migrateSecrets(), true)
  assert.equal(secretsArePlain(), false)
  assert.ok(!readFileSync(file(), 'utf8').includes(totpSecret))
  assert.equal(verifyOwner('legacy passphrase', totp(totpSecret)), true)
  assert.equal(migrateSecrets(), false, 'second run is a no-op')
})

test('a tampered secrets.json fails closed', () => {
  const env = JSON.parse(readFileSync(file(), 'utf8')) as { format: string; data: string }
  const bytes = Buffer.from(env.data, 'base64')
  bytes[bytes.length - 5] ^= 0xff
  writeFileSync(file(), JSON.stringify({ ...env, data: bytes.toString('base64') }))
  assert.equal(verifyOwner('legacy passphrase', '000000'), false)
})
