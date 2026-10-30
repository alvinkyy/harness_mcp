// Node2Shell (CVE-2026-111497) mitigation: compressed request bodies are refused before any body
// parser can decompress them, on the public endpoints (no sign-in needed) and the control page.

import assert from 'node:assert/strict'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { after, test } from 'node:test'
import * as h from './helpers.ts'

after(() => h.running.close())

const form = 'grant_type=client_credentials&client_id=x'

test('public endpoints refuse compressed bodies before parsing them', async () => {
  for (const path of ['/token', '/register', '/revoke', '/consent', '/mcp']) {
    for (const [encoding, body] of [['br', brotliCompressSync(form)], ['gzip', gzipSync(form)], ['deflate, br', brotliCompressSync(form)]] as const) {
      const r = await fetch(`${h.MCP}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': encoding },
        body,
      })
      assert.equal(r.status, 415, `${path} with ${encoding}`)
    }
  }
})

test('uncompressed and identity bodies still reach the endpoints', async () => {
  for (const encoding of [undefined, 'identity']) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (encoding) headers['content-encoding'] = encoding
    const r = await fetch(`${h.MCP}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ redirect_uris: [h.REDIRECT], client_name: 'Encoding test' }),
    })
    assert.equal(r.status, 201, String(encoding))
  }
})

test('the control page refuses compressed bodies too', async () => {
  const token = await h.csrf()
  const r = await fetch(`${h.CONTROL}/api/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'br', 'x-csrf': token },
    body: brotliCompressSync(JSON.stringify({ mode: 'on' })),
  })
  assert.equal(r.status, 415)
})
