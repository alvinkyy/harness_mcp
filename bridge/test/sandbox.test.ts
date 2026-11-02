// Write sandbox (Codex "unelevated" design): commands can write only inside the workspace, .git stays
// read-only, network tools are blocked, and running outside the sandbox needs the user's approval.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as h from './helpers.ts'
import { removeSandbox } from '../src/sandbox.ts'

after(async () => {
  await h.running.close()
  removeSandbox()
})

type Pending = { id: string; kind: string; summary: string; detail: Record<string, unknown> }

async function waitForPending(match: (a: Pending) => boolean): Promise<Pending> {
  for (let i = 0; i < 50; i++) {
    const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { actions: Pending[] }
    const a = s.actions.find(match)
    if (a) return a
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('pending action never appeared')
}

/** Make the workspace's own test command run `script` (the recipe runs without approval). */
function recipe(script: string): void {
  h.write(join(h.workspace, 'probe.js'), script)
  h.write(join(h.workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node probe.js' } }))
}

describe('Write sandbox', () => {
  let t: h.Tokens
  before(async () => {
    t = await h.connect('full')
    // Trust the workspace, so the recipe runs on agent-written code without an approval card.
    const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as Record<string, unknown>
    void s
  })

  test('the sandbox is on and reported to the control page', async () => {
    const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { sandbox: { mode: string; writableRoots: string[]; detail: string } }
    assert.equal(s.sandbox.mode, 'workspace-write', s.sandbox.detail)
    assert.ok(s.sandbox.writableRoots.some((r) => r.toLowerCase() === h.workspace.toLowerCase()))
  })

  test('commands write inside the workspace but not outside it or into .git', async () => {
    mkdirSync(join(h.workspace, '.git'), { recursive: true })
    // The .git deny is added when the workspace's roots are next synced; a restart does the same.
    const { syncSandboxAcls } = await import('../src/sandbox.ts')
    syncSandboxAcls([h.workspace])
    const outsideFile = join(h.outside, 'escape.txt').replace(/\\/g, '\\\\')
    const gitFile = join(h.workspace, '.git', 'escape.txt').replace(/\\/g, '\\\\')
    recipe(`const fs = require('fs')
function tryWrite(label, p) { try { fs.writeFileSync(p, 'x'); console.log(label + ': written') } catch (e) { console.log(label + ': ' + e.code) } }
tryWrite('inside', 'inside.txt')
tryWrite('nested', require('path').join('sub', 'n.txt'), fs.mkdirSync('sub', { recursive: true }))
tryWrite('outside', '${outsideFile}')
tryWrite('git', '${gitFile}')
`)
    const r = await h.callTool(t.access_token, 'run_tests', {})
    if (/awaiting-approval/.test(r.text)) {
      const a = await waitForPending((x) => x.kind === 'command')
      await h.control(`/api/action/${a.id}/approve`)
    }
    const run = r.text.includes('"status": "passed"') ? r : await h.callTool(t.access_token, 'get_run', { id: 'latest', waitSec: 20 })
    assert.match(run.text, /"sandbox": "workspace-write"/, run.text)
    assert.match(run.text, /inside: written/)
    assert.match(run.text, /outside: EPERM/)
    assert.match(run.text, /git: EPERM/)
    assert.ok(existsSync(join(h.workspace, 'inside.txt')))
    assert.equal(existsSync(join(h.outside, 'escape.txt')), false)
    assert.equal(existsSync(join(h.workspace, '.git', 'escape.txt')), false)
  })

  test('Node child processes with captured output work inside the sandbox (Codex #47868 does not apply)', async () => {
    recipe(`const { execSync, spawnSync } = require('child_process')
console.log('exec=' + execSync('echo piped-ok', { encoding: 'utf8' }).trim())
console.log('spawn=' + spawnSync(process.execPath, ['-v'], { encoding: 'utf8' }).stdout.trim())
console.log('python=' + execSync('python -c "print(6*7)"', { encoding: 'utf8' }).trim())
`)
    let r = await h.callTool(t.access_token, 'run_tests', {})
    if (/awaiting-approval/.test(r.text)) {
      const a = await waitForPending((x) => x.kind === 'command')
      await h.control(`/api/action/${a.id}/approve`)
      r = await h.callTool(t.access_token, 'get_run', { id: 'latest', waitSec: 20 })
    }
    assert.match(r.text, /"sandbox": "workspace-write"/, r.text)
    assert.match(r.text, /exec=piped-ok/)
    assert.match(r.text, /spawn=v\d+/)
    assert.match(r.text, /python=42/)
  })

  test('network tools are blocked inside the sandbox', async () => {
    recipe(`const { execSync } = require('child_process')
for (const c of ['ssh -V', 'git ls-remote https://example.invalid/x.git']) {
  try { execSync(c, { stdio: 'pipe' }); console.log(c + ': ran') } catch (e) { console.log(c + ': blocked ' + String(e.stderr).split('\\n')[0]) }
}
console.log('proxy=' + process.env.HTTPS_PROXY)
`)
    let r = await h.callTool(t.access_token, 'run_tests', {})
    if (/awaiting-approval/.test(r.text)) {
      const a = await waitForPending((x) => x.kind === 'command')
      await h.control(`/api/action/${a.id}/approve`)
      r = await h.callTool(t.access_token, 'get_run', { id: 'latest', waitSec: 20 })
    }
    assert.match(r.text, /ssh -V: blocked .*network tools are blocked/)
    assert.match(r.text, /git ls-remote .*: blocked/)
    assert.match(r.text, /proxy=http:\/\/127\.0\.0\.1:9/)
  })

  test('outside the sandbox needs a justification and the user\'s approval, then has full rights', async () => {
    const missing = await h.callTool(t.access_token, 'run', { command: 'echo hi', outsideSandbox: true })
    assert.match(missing.text, /justification/)

    const target = join(h.outside, 'approved-outside.txt')
    const call = h.callTool(t.access_token, 'run', { command: `echo ok> "${target}"`, outsideSandbox: true, justification: 'test writes outside' })
    const action = await waitForPending((a) => a.summary.includes('approved-outside'))
    assert.equal(action.detail.outsideSandbox, true)
    assert.equal(action.detail.justification, 'test writes outside')
    await h.control(`/api/action/${action.id}/approve`)
    const r = await call
    assert.match(r.text, /"sandbox": "outside"/, r.text)
    assert.equal(readFileSync(target, 'utf8').trim(), 'ok')
  })

  test('a sandboxed timeout still kills the whole process tree', async () => {
    const pidFile = join(h.workspace, 'child.pid').replace(/\\/g, '/')
    recipe(`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('${pidFile}',String(c.pid));setInterval(()=>{},1000)`)
    let r = await h.callTool(t.access_token, 'run_tests', {})
    if (/awaiting-approval/.test(r.text)) {
      const a = await waitForPending((x) => x.kind === 'command')
      await h.control(`/api/action/${a.id}/approve`)
      r = await h.callTool(t.access_token, 'get_run', { id: 'latest', waitSec: 20 })
    }
    assert.match(r.text, /"status": "(failed|killed)"/, r.text)
    const childPid = Number(readFileSync(join(h.workspace, 'child.pid'), 'utf8'))
    await new Promise((res) => setTimeout(res, 800))
    assert.throws(() => process.kill(childPid, 0), 'grandchild should be gone')
  })
})
