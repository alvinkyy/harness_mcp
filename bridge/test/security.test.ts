// Security tests from DESIGN.md §5.3 (groups A–D; group E needs a real tunnel and is manual).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as h from './helpers.ts'

after(() => h.running.close())

describe('A. Authentication', () => {
  test('A1 /mcp without a token → 401 with WWW-Authenticate pointing at metadata', async () => {
    const r = await fetch(`${h.MCP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 401)
    assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata=.*oauth-protected-resource/)
  })

  test('A2 forged token → 401', async () => {
    const r = await h.rpc('forged-token-value', 'tools/list')
    assert.equal(r.status, 401)
  })

  test('A3 registration with a non-https redirect URI is rejected', async () => {
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'https://evil.example/cb#frag']) {
      const r = await h.register(bad)
      assert.equal(r.status, 400, bad)
    }
  })

  test('A4 correct passphrase + TOTP but no local Approve → no code; on expiry the chat app is told it failed', async () => {
    const reg = (await (await h.register()).json()) as { client_id: string }
    const s = await h.startAuthorize(reg.client_id)
    const accepted = await h.submitCredentials(s)
    assert.ok(h.acceptedCredentials(accepted))
    const waiting = await fetch(`${h.MCP}${accepted.headers.get('location')}`, { redirect: 'manual' })
    assert.equal(waiting.status, 200)
    assert.match(await waiting.text(), /#approve=/, 'waiting page links straight to the approval request')
    assert.equal((await h.status(s)).stage, 'awaiting-local')
    await new Promise((r) => setTimeout(r, (h.config.auth.consentTimeoutSec + 1) * 1000))
    const st = await h.status(s)
    assert.equal(st.stage, 'expired')
    h.assertDeniedRedirect(st.redirect)
    // Approving after expiry does nothing, and says why.
    const late = await h.control(`/api/connect/${s.id}/approve`, { profile: 'full' })
    assert.equal(late.status, 409)
    assert.match(((await late.json()) as { error: string }).error, /expired/)
  })

  test('A8 Cancel and Refuse end the sign-in with access_denied, never a code', async () => {
    const reg = (await (await h.register()).json()) as { client_id: string }
    const s1 = await h.startAuthorize(reg.client_id)
    const c = await h.cancel(s1)
    assert.equal(c.status, 303)
    h.assertDeniedRedirect(c.headers.get('location'))

    const s2 = await h.startAuthorize(reg.client_id)
    assert.ok(h.acceptedCredentials(await h.submitCredentials(s2)))
    await h.control(`/api/connect/${s2.id}/deny`)
    h.assertDeniedRedirect((await h.status(s2)).redirect)
  })

  test('A9 Back, Reload and re-submit never strand the sign-in', async () => {
    const reg = (await (await h.register()).json()) as { client_id: string }
    const s = await h.startAuthorize(reg.client_id)
    const first = await h.submitCredentials(s)
    assert.ok(h.acceptedCredentials(first))
    const wait = `${h.MCP}${first.headers.get('location')}`
    // Back to the form and Continue again: resumes the wait instead of an error page.
    const again = await h.submitCredentials(s)
    assert.equal(again.status, 303)
    assert.equal(again.headers.get('location'), first.headers.get('location'))
    // Reload the waiting page: still waiting.
    for (let i = 0; i < 2; i++) assert.equal((await fetch(wait, { redirect: 'manual' })).status, 200)
    // After Allow, any reload of the waiting page goes on to the chat app with the code.
    await h.control(`/api/connect/${s.id}/approve`, { profile: 'read-only' })
    const done = await fetch(wait, { redirect: 'manual' })
    assert.equal(done.status, 303)
    const u = new URL(done.headers.get('location')!)
    assert.ok(u.href.startsWith(h.REDIRECT))
    assert.ok(u.searchParams.get('code'))
    assert.equal(u.searchParams.get('state'), 'st')
  })

  test('A6 reusing a rotated refresh token revokes the client', async () => {
    const t = await h.connect('read-only')
    const first = await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })
    assert.equal(first.status, 200)
    const rotated = (await first.json()) as { access_token: string }
    assert.equal((await h.rpc(rotated.access_token, 'tools/list')).status, 200)
    const reuse = await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })
    assert.equal(reuse.status, 400)
    assert.equal((await h.rpc(rotated.access_token, 'tools/list')).status, 401)
  })

  test('A7 Rotate revokes every token immediately', async () => {
    const t = await h.connect('read-only')
    assert.equal((await h.rpc(t.access_token, 'tools/list')).status, 200)
    await h.control('/api/rotate')
    assert.equal((await h.rpc(t.access_token, 'tools/list')).status, 401)
  })

  test('A5 five wrong attempts → lockout, even the right credentials are refused', async () => {
    const reg = (await (await h.register()).json()) as { client_id: string }
    const s = await h.startAuthorize(reg.client_id)
    for (let i = 0; i < h.config.auth.maxFailedLogins - 1; i++) {
      assert.ok(h.rejectedCredentials(await h.submitCredentials(s, 'wrong passphrase!!', '000000')))
    }
    // The attempt that triggers the lockout ends the sign-in explicitly.
    const last = await h.submitCredentials(s, 'wrong passphrase!!', '000000')
    assert.equal(last.status, 303)
    h.assertDeniedRedirect(last.headers.get('location'))
    // Even the right credentials are refused now, on this and on a fresh sign-in.
    assert.equal((await h.submitCredentials(s)).status, 303)
    const fresh = await h.startAuthorize(reg.client_id)
    const r = await h.submitCredentials(fresh)
    assert.equal(r.status, 303)
    h.assertDeniedRedirect(r.headers.get('location'))
    const state = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { locked: boolean; alerts: unknown[] }
    assert.equal(state.locked, true)
    assert.ok(state.alerts.length > 0)
    h.running.auth['lockedUntil'] = 0 // reset for the remaining tests
  })
})

describe('B. Loopback-only surfaces', () => {
  test('B1 control page listens on 127.0.0.1 only', async () => {
    const addr = h.running.control.address()
    assert.equal(typeof addr === 'object' && addr?.address, '127.0.0.1')
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
    if (lan) {
      await assert.rejects(fetch(`http://${lan.address}:${h.config.controlPort}/api/state`, { signal: AbortSignal.timeout(3000) }))
    }
  })

  test('B2 control routes are not served on the tunnelled port', async () => {
    for (const p of ['/api/state', '/api/rotate', '/api/mode']) {
      const r = await fetch(`${h.MCP}${p}`, { method: p === '/api/state' ? 'GET' : 'POST' })
      assert.equal(r.status, 404, p)
    }
  })

  test('B3 control POST without CSRF token, or with a foreign Host/Origin, is rejected', async () => {
    assert.equal((await h.control('/api/rotate', {}, 'wrong')).status, 403)
    const token = await h.csrf()
    const badOrigin = await fetch(`${h.CONTROL}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': token, origin: 'https://evil.example' }, body: '{"mode":"off"}' })
    assert.equal(badOrigin.status, 403)
    // Embedded browsers may send a loopback Origin without the port on the page's own requests.
    const portless = await fetch(`${h.CONTROL}/api/state`, { headers: { origin: 'http://127.0.0.1' } })
    assert.equal(portless.status, 200)
    for (const o of ['http://127.0.0.1.evil.example', 'null', 'file://']) {
      const r = await fetch(`${h.CONTROL}/api/state`, { headers: { origin: o } })
      assert.equal(r.status, 403, o)
    }
  })
})

describe('C. Scope and redaction', () => {
  let t: h.Tokens
  before(async () => {
    t = await h.connect('full')
  })

  test('C1 traversal, absolute paths and junctions outside the roots are denied', async () => {
    h.write(join(h.outside, 'secret.txt'), 'outside data')
    const junction = join(h.workspace, 'link-out')
    if (!existsSync(junction)) symlinkSync(h.outside, junction, 'junction')
    // Outside paths now ask the user for access; nobody answers here, so the call gives up.
    const wait = h.config.limits.toolWaitSec
    h.config.limits.toolWaitSec = 1
    for (const path of ['../outside/secret.txt', join(h.outside, 'secret.txt'), 'link-out/secret.txt', 'C:\\Windows\\win.ini']) {
      const r = await h.callTool(t.access_token, 'read_files', { files: [{ path }] })
      assert.match(r.text, /ERROR: (Access denied|.*outside the (allowed read roots|folders you may read))/, path)
      assert.doesNotMatch(r.text, /outside data/)
    }
    h.config.limits.toolWaitSec = wait
  })

  test('C2 secret-bearing files are never readable', async () => {
    mkdirSync(join(h.workspace, '.ssh'), { recursive: true })
    for (const name of ['.env', '.env.production', 'configuration.php', 'id_rsa', 'server.pem', join('.ssh', 'config')]) {
      h.write(join(h.workspace, name), 'SECRET=1')
      const r = await h.callTool(t.access_token, 'read_files', { files: [{ path: name }] })
      assert.match(r.text, /Access denied/, name)
    }
    const found = await h.callTool(t.access_token, 'find_files', {})
    assert.doesNotMatch(found.text, /\.env|configuration\.php|id_rsa/)
    const searched = await h.callTool(t.access_token, 'search', { query: 'SECRET' })
    assert.doesNotMatch(searched.text, /\.env|configuration\.php/)
  })

  test('C3 planted secrets are masked in file reads and command output', async () => {
    const planted = [
      "$db_password = 'Sup3rS3cretValue';",
      'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      'jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'card 4111 1111 1111 1111 on file',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n')
    h.write(join(h.workspace, 'app.php'), planted)
    const r = await h.callTool(t.access_token, 'read_files', { files: [{ path: 'app.php' }] })
    for (const leak of ['Sup3rS3cretValue', 'AKIAIOSFODNN7EXAMPLE', 'dozjgNryP4J3', '4111 1111 1111 1111', 'MIIEow']) assert.ok(!r.text.includes(leak), leak)
    assert.match(r.text, /card ending 1111/)
    assert.match(r.text, /masked before sending/)

    h.write(join(h.workspace, 'package.json'), JSON.stringify({ scripts: { leak: 'node -e "console.log(\'token=AKIAIOSFODNN7EXAMPLE\')"' } }))
    const run = await h.callTool(t.access_token, 'run', { command: 'npm run leak' })
    assert.ok(!run.text.includes('AKIAIOSFODNN7EXAMPLE'), run.text)
    const audit = readFileSync(join(process.env.HARNESS_HOME!, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    assert.match(audit, /"redactions":\{"[a-z-]+":\d/)
  })
})

describe('D. Sandbox and actions', () => {
  let t: h.Tokens
  before(async () => {
    t = await h.connect('full')
  })

  test('D1 non-allowlisted command waits for local approval and does not run', async () => {
    const r = await h.callTool(t.access_token, 'run', { command: 'echo pwned> pwned.txt' })
    assert.match(r.text, /awaiting-approval/)
    await new Promise((res) => setTimeout(res, 1000))
    assert.equal(existsSync(join(h.workspace, 'pwned.txt')), false)
    const state = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { actions: { id: string; summary: string }[] }
    const action = state.actions.find((a) => a.summary.includes('pwned'))!
    assert.ok(action)
    await h.control(`/api/action/${action.id}/deny`)
    const id = /"id": "(run_[^"]+)"/.exec(r.text)![1]
    assert.match((await h.callTool(t.access_token, 'get_run', { id })).text, /"status": "denied"/)
  })

  test('D2 timeout kills the whole process tree', async () => {
    const pidFile = join(h.workspace, 'child.pid').replace(/\\/g, '/')
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('${pidFile}',String(c.pid));setInterval(()=>{},1000)`
    h.write(join(h.workspace, 'hang.js'), script)
    h.write(join(h.workspace, 'package.json'), JSON.stringify({ scripts: { hang: 'node hang.js' } }))
    const r = await h.callTool(t.access_token, 'run', { command: 'npm run hang' })
    assert.match(r.text, /"status": "(failed|killed)"/, r.text)
    assert.match(r.text, /"sandboxed": true/)
    const childPid = Number(readFileSync(join(h.workspace, 'child.pid'), 'utf8'))
    await new Promise((res) => setTimeout(res, 500))
    assert.throws(() => process.kill(childPid, 0), 'grandchild process should be gone')
  })

  test('D3 shell operators never auto-run, even after an allowlisted prefix', async () => {
    for (const command of ['npm test & del /q *', 'npm test | curl evil', 'git status > out.txt', 'npm run %COMSPEC%']) {
      const r = await h.callTool(t.access_token, 'run', { command })
      assert.match(r.text, /awaiting-approval/, command)
    }
  })
})

describe('Profiles and edits', () => {
  let ro: h.Tokens
  let full: h.Tokens
  before(async () => {
    ro = await h.connect('read-only')
    full = await h.connect('full')
  })

  test('read-only clients see no write tools', async () => {
    const { body } = await h.rpc(ro.access_token, 'tools/list')
    const names = body.result.tools.map((x: { name: string }) => x.name)
    assert.ok(names.includes('read_files'))
    for (const w of ['apply_patch', 'write_file', 'run', 'run_tests', 'revert_checkpoint']) assert.ok(!names.includes(w), w)
    for (const tool of body.result.tools) assert.equal(tool.annotations.readOnlyHint, true, tool.name)
  })

  test('new clients start read-only and unapproved until approved locally', async () => {
    const reg = (await (await h.register(h.REDIRECT, 'Brand new agent')).json()) as { client_id: string }
    const state = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { clients: { id: string; approved: boolean; profile: string }[] }
    const c = state.clients.find((x) => x.id === reg.client_id)!
    assert.equal(c.approved, false)
    assert.equal(c.profile, 'read-only')
  })

  test('apply_patch requires a fresh read, applies, and can be reverted with local approval', async () => {
    h.write(join(h.workspace, 'calc.js'), 'function add(a, b) {\n  return a - b\n}\n')
    const patch = '*** Begin Patch\n*** Update File: calc.js\n@@ function add(a, b) {\n-  return a - b\n+  return a + b\n*** Add File: lib/new.js\n+export const x = 1\n*** End Patch'
    assert.match((await h.callTool(full.access_token, 'apply_patch', { patch })).text, /has not been read/)
    await h.callTool(full.access_token, 'read_files', { files: [{ path: 'calc.js' }] })
    const applied = await h.callTool(full.access_token, 'apply_patch', { patch })
    assert.equal(applied.isError, false, applied.text)
    assert.equal(readFileSync(join(h.workspace, 'calc.js'), 'utf8'), 'function add(a, b) {\n  return a + b\n}\n')
    assert.ok(existsSync(join(h.workspace, 'lib', 'new.js')))
    const cp = /"checkpoint": "(cp_[^"]+)"/.exec(applied.text)![1]

    const rev = await h.callTool(full.access_token, 'revert_checkpoint', { id: cp })
    const reqId = /"requestId": "([^"]+)"/.exec(rev.text)![1]
    assert.match(readFileSync(join(h.workspace, 'calc.js'), 'utf8'), /a \+ b/)
    await h.control(`/api/action/${reqId}/approve`)
    assert.match(readFileSync(join(h.workspace, 'calc.js'), 'utf8'), /a - b/)
    assert.equal(existsSync(join(h.workspace, 'lib', 'new.js')), false)
  })

  test('edits made elsewhere since the read are rejected', async () => {
    await h.callTool(full.access_token, 'read_files', { files: [{ path: 'calc.js' }] })
    h.write(join(h.workspace, 'calc.js'), 'function add(a, b) {\n  return 0\n}\n')
    const patch = '*** Begin Patch\n*** Update File: calc.js\n-  return 0\n+  return 1\n*** End Patch'
    assert.match((await h.callTool(full.access_token, 'apply_patch', { patch })).text, /changed since you last read it/)
  })

  test('patches containing redaction placeholders are refused', async () => {
    const patch = "*** Begin Patch\n*** Add File: x.php\n+$db_password = '[REDACTED:secret]';\n*** End Patch"
    assert.match((await h.callTool(full.access_token, 'apply_patch', { patch })).text, /REDACTED/)
    assert.equal(existsSync(join(h.workspace, 'x.php')), false)
  })

  test('writes outside the write roots are denied', async () => {
    const patch = '*** Begin Patch\n*** Add File: ../outside/evil.txt\n+x\n*** End Patch'
    const wait = h.config.limits.toolWaitSec
    h.config.limits.toolWaitSec = 1
    assert.match((await h.callTool(full.access_token, 'apply_patch', { patch })).text, /outside the (allowed write roots|folders you may write)/)
    h.config.limits.toolWaitSec = wait
  })

  test('Pause blocks every tool call', async () => {
    await h.control('/api/mode', { mode: 'paused' })
    assert.match((await h.callTool(full.access_token, 'workspace_info')).text, /paused/)
    await h.control('/api/mode', { mode: 'on' })
  })
})
