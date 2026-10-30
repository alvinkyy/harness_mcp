// Rotating quick-tunnel hostnames: OAuth metadata follows the hostname the agent used, and
// unknown hostnames are refused.

import assert from 'node:assert/strict'
import { request } from 'node:http'
import { after, test } from 'node:test'
import * as h from './helpers.ts'

h.config.publicUrl = 'auto'
after(() => h.running.close())

function get(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: h.config.mcpPort, path, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('OAuth metadata names the quick-tunnel hostname the agent used', async () => {
  for (const host of ['brave-otter-sky.trycloudflare.com', 'calm-river-moon.trycloudflare.com']) {
    const r = await get('/.well-known/oauth-authorization-server', host)
    assert.equal(r.status, 200)
    const meta = JSON.parse(r.body) as { issuer: string; authorization_endpoint: string }
    assert.equal(meta.issuer, `https://${host}/`)
    assert.equal(meta.authorization_endpoint, `https://${host}/authorize`)
    const pr = await get('/.well-known/oauth-protected-resource/mcp', host)
    assert.equal((JSON.parse(pr.body) as { resource: string }).resource, `https://${host}/mcp`)
  }
})

test('unknown hostnames are refused', async () => {
  for (const host of ['evil.example.com', 'trycloudflare.com.evil.net', 'a.b.trycloudflare.com']) {
    assert.equal((await get('/.well-known/oauth-authorization-server', host)).status, 421, host)
  }
})

test('the control page learns the current connector URL, and remembers the previous one', async () => {
  await get('/', 'first-addr-one.trycloudflare.com')
  await get('/', 'second-addr-two.trycloudflare.com')
  const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { connection: { connectorUrl: { current: string; previous: string } } }
  assert.equal(s.connection.connectorUrl.current, 'https://second-addr-two.trycloudflare.com/mcp')
  assert.equal(s.connection.connectorUrl.previous, 'https://first-addr-one.trycloudflare.com/mcp')
})
